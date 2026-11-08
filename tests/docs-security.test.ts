/**
 * Drift guard for docs/SECURITY.md.
 *
 * The threat model carries a per-control table. A row marked `enforced` is a promise, so
 * the promise must be checkable: the env var / API token it names must exist in src/, and
 * the test file it names must exist. A row cannot claim "enforced" while pointing at
 * nothing. Rows marked `pending` or `NOT enforced` make no promise and are not checked
 * (flip `pending` to `enforced` when the PR that wires it merges).
 *
 * Table columns: | Control | Status | Env var / API | Test file | Notes |
 * Run: bun test tests/docs-security.test.ts
 */
import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

export function parseControlRows(md: string) {
  const rows: { control: string; status: string; token: string; test: string }[] = [];
  let inTable = false;
  for (const line of md.split("\n")) {
    if (/^\|\s*Control\s*\|\s*Status\s*\|/i.test(line)) { inTable = true; continue; }
    if (!inTable) continue;
    if (!line.startsWith("|")) { if (rows.length) break; else continue; }
    if (/^\|\s*-+/.test(line)) continue;
    const c = line.split("|").slice(1, -1).map((s) => s.trim().replace(/`/g, ""));
    if (c.length < 4) continue;
    rows.push({ control: c[0], status: c[1].toLowerCase(), token: c[2], test: c[3] });
  }
  return rows;
}

function srcText(dir = join(ROOT, "src")): string {
  let out = "";
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    out += statSync(p).isDirectory() ? srcText(p) : readFileSync(p, "utf8");
  }
  return out;
}

const STATUSES = ["enforced", "pending", "not enforced"];
const TOKEN = /^[A-Za-z_][A-Za-z0-9_]{3,}$/; // a real identifier, not "a"
const TEST_FILE = /^[\w.-]+\.test\.ts$/; // a bare file name in tests/, no "../"
const word = (t: string) => new RegExp(`(?<![A-Za-z0-9_])${t}(?![A-Za-z0-9_])`);
// a test only proves a control if its CODE uses the token; a comment naming it proves nothing
const code = (ts: string) => ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

export function checkRows(md: string, root = ROOT, src = srcText()) {
  const problems: string[] = [];
  const rows = parseControlRows(md);
  if (rows.length === 0) problems.push("no control rows parsed");
  for (const r of rows) {
    if (!STATUSES.includes(r.status)) { problems.push(`${r.control}: status "${r.status}" is not one of ${STATUSES.join(" | ")}`); continue; }
    if (r.status === "not enforced") continue;
    const tokenOk = TOKEN.test(r.token);
    const inSrc = tokenOk && word(r.token).test(src);
    const testPath = join(root, "tests", r.test);
    const testOk = TEST_FILE.test(r.test) && existsSync(testPath);
    const tested = testOk && tokenOk && word(r.token).test(code(readFileSync(testPath, "utf8")));
    if (r.status === "enforced") {
      if (!tokenOk) problems.push(`${r.control}: token "${r.token}" is not an identifier of 4+ chars`);
      else if (!inSrc) problems.push(`${r.control}: token "${r.token}" not in src/`);
      if (!testOk) problems.push(`${r.control}: test "${r.test}" is not an existing tests/*.test.ts file`);
      else if (!tested) problems.push(`${r.control}: test "${r.test}" never uses "${r.token}" in code`);
    } else if (inSrc && tested) {
      // pending -> the wiring landed: the doc must stop under-claiming
      problems.push(`${r.control}: "${r.token}" is in src/ and exercised by ${r.test}; flip pending -> enforced`);
    }
  }
  return problems;
}

describe("docs/SECURITY.md", () => {
  const path = join(ROOT, "docs", "SECURITY.md");
  it("exists and has a control table with at least one enforced and one NOT enforced row", () => {
    expect(existsSync(path)).toBe(true);
    const rows = parseControlRows(readFileSync(path, "utf8"));
    expect(rows.some((r) => r.status === "enforced")).toBe(true);
    expect(rows.some((r) => r.status === "not enforced")).toBe(true);
  });
  it("every enforced row names a token present in src/ and an existing test file", () => {
    expect(checkRows(readFileSync(path, "utf8"))).toEqual([]);
  });
  it("documents the three env vars", () => {
    const md = readFileSync(path, "utf8");
    for (const v of ["VEIL_ALLOW_ORIGINS", "VEIL_ATTACH_STRICT", "VEIL_ALLOW_COOKIE_VALUES"]) expect(md).toContain(v);
  });
  it("README does not contradict the table on MCP allowlist coverage", () => {
    const mcpRow = parseControlRows(readFileSync(path, "utf8")).find((r) => r.token === "VEIL_ALLOW_ORIGINS");
    expect(mcpRow).toBeDefined();
    const saysUncovered = /not covered by the origin allowlist/.test(readFileSync(join(ROOT, "README.md"), "utf8"));
    expect(saysUncovered).toBe(mcpRow!.status !== "enforced");
  });
  it("README links docs/SECURITY.md", () => {
    expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain("docs/SECURITY.md");
  });
  it("mutant: every way a row can overclaim is caught", () => {
    const hdr = "| Control | Status | Env var / API | Test file | Notes |\n|---|---|---|---|---|\n";
    const row = (status: string, token: string, test: string) => checkRows(hdr + `| x | ${status} | ${token} | ${test} | |\n`);
    expect(row("enforced", "allowOrigins", "origin-allowlist.test.ts")).toEqual([]);
    expect(row("enforced", "allowOrigins", "no-such.test.ts")).not.toEqual([]);
    expect(row("enforced", "NO_SUCH_TOKEN_XYZ", "origin-allowlist.test.ts")).not.toEqual([]);
    expect(row("enforced", "a", "origin-allowlist.test.ts")).not.toEqual([]); // substring token
    expect(row("enforced", "allowOrigin", "origin-allowlist.test.ts")).not.toEqual([]); // prefix of a real identifier
    expect(row("enforced", "allowOrigins", "../package.json")).not.toEqual([]); // path escape
    expect(row("enforced (partial)", "allowOrigins", "origin-allowlist.test.ts")).not.toEqual([]); // status dodge
    expect(row("enforced", "blockPrivateNetwork", "private-host.test.ts")).not.toEqual([]); // named only in a comment
    expect(row("pending", "allowOrigins", "origin-allowlist.test.ts")).not.toEqual([]); // landed, not flipped
    expect(row("pending", "NO_SUCH_TOKEN_XYZ", "origin-allowlist.test.ts")).toEqual([]);
  });
});
