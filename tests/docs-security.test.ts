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

export function checkRows(md: string, root = ROOT, src = srcText()) {
  const problems: string[] = [];
  const rows = parseControlRows(md);
  if (rows.length === 0) problems.push("no control rows parsed");
  for (const r of rows.filter((r) => r.status === "enforced")) {
    if (r.token === "-" || !src.includes(r.token)) problems.push(`${r.control}: token "${r.token}" not in src/`);
    if (r.test === "-" || !existsSync(join(root, "tests", r.test))) problems.push(`${r.control}: test "${r.test}" does not exist`);
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
  it("README links docs/SECURITY.md", () => {
    expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain("docs/SECURITY.md");
  });
  it("mutant: a row pointing at a nonexistent test, or a token absent from src/, is caught", () => {
    const hdr = "| Control | Status | Env var / API | Test file | Notes |\n|---|---|---|---|---|\n";
    expect(checkRows(hdr + "| x | enforced | allowOrigins | no-such.test.ts | |\n")).toHaveLength(1);
    expect(checkRows(hdr + "| x | enforced | NO_SUCH_TOKEN_XYZ | origin-allowlist.test.ts | |\n")).toHaveLength(1);
    expect(checkRows(hdr + "| x | enforced | allowOrigins | origin-allowlist.test.ts | |\n")).toHaveLength(0);
  });
});
