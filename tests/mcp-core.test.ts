/**
 * MCP server hardening: per-call deadline, parameter aliases, attach safety env
 * (VEIL_ATTACH_STRICT, VEIL_ALLOW_ORIGINS, VEIL_ALLOW_COOKIE_VALUES).
 *
 * Every test spawns `bun run src/mcp.ts` over stdio, exactly as the fleet does. Chrome is only ever a
 * throwaway headless instance under /tmp; this file NEVER attaches to 127.0.0.1:9333 or any real profile.
 *
 * Run: bun test tests/mcp-core.test.ts
 */
import { describe, it, expect, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { PARAM_ALIASES } from "../src/mcp-validate.js";
import { normalizeArgs, NEW_ALIASES } from "../src/mcp-aliases.js";

const MCP = join(import.meta.dir, "..", "src", "mcp.ts");
const scratch = mkdtempSync(join(tmpdir(), "veil-mcp-core-"));
const cleanups: Array<() => void> = [];
afterAll(() => { for (const c of cleanups.reverse()) try { c(); } catch {} try { rmSync(scratch, { recursive: true, force: true }); } catch {} });

/** A spawned MCP server speaking newline-delimited JSON-RPC. */
function startMcp(env: Record<string, string>) {
  const child = spawn("bun", ["run", MCP], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, DISPLAY: process.env.DISPLAY ?? "", ...env },
  });
  let buf = "";
  let stderr = "";
  const waiters = new Map<number, (m: any) => void>();
  child.stdout!.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      try { const m = JSON.parse(line); waiters.get(m.id)?.(m); } catch {}
    }
  });
  child.stderr!.on("data", (d) => { stderr += d.toString(); });
  let nextId = 1;
  const rpc = (method: string, params?: any, timeoutMs = 30_000): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => reject(new Error(`no reply to ${method} within ${timeoutMs}ms`)), timeoutMs);
      waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const call = (name: string, args: any = {}, timeoutMs?: number) => rpc("tools/call", { name, arguments: args }, timeoutMs);
  const kill = () => { try { child.kill("SIGKILL"); } catch {} };
  cleanups.push(kill);
  return { child, call, rpc, kill, stderr: () => stderr };
}
const out = (r: any): string => (r.result?.content ?? []).map((c: any) => c.text).join("\n");

describe("(1) per-call deadline", () => {
  it("a never-resolving tool errors within 3s AND the next call still answers", async () => {
    const m = startMcp({ VEIL_TOOL_DEADLINE_MS: "1000", VEIL_MCP_TEST_STUB: "1" });
    const t0 = Date.now();
    const r = await m.call("veil_test_hang", {}, 10_000);
    const dt = Date.now() - t0;
    expect(r.result.isError).toBe(true);
    expect(out(r)).toContain("timed out after 1s on veil_test_hang");
    expect(out(r)).toContain("try veil_dom or veil_click_text");
    expect(dt).toBeLessThan(3000);
    // chain not wedged: a later call answers
    const list = await m.rpc("tools/list", undefined, 5_000);
    expect(list.result.tools.length).toBeGreaterThan(40);
    m.kill();
  }, 30_000);

  it("positive control: the stub tool is NOT exposed without the test env", async () => {
    const m = startMcp({});
    const r = await m.call("veil_test_hang", {}, 5_000);
    expect(r.error?.code).toBe(-32601);
    m.kill();
  }, 15_000);
});

describe("(2) parameter aliases", () => {
  it("every new alias maps to its canonical name (pure table)", () => {
    for (const [tool, aliases] of Object.entries(NEW_ALIASES)) {
      for (const [wrong, right] of Object.entries(aliases)) {
        const r = normalizeArgs(tool, { [wrong]: "x" });
        expect(r[right]).toBe("x");
        expect(r[wrong]).toBeUndefined();
      }
    }
    const flat = (t: string, a: string) => NEW_ALIASES[t]?.[a];
    expect(flat("veil_click_text", "selector")).toBe("query");
    expect(flat("veil_click_text", "css")).toBe("query");
    expect(flat("veil_fill", "value")).toBe("text");
    expect(flat("veil_eval", "script")).toBe("expression");
    expect(flat("veil_eval", "expr")).toBe("expression");
    expect(flat("veil_batch", "actions")).toBe("steps");
    expect(flat("veil_enable_downloads", "path")).toBe("dir");
    for (const [a, c] of [["to_x", "toX"], ["endX", "toX"], ["from_x", "fromX"], ["startX", "fromX"]]) expect(flat("veil_drag", a)).toBe(c);
    expect(flat("veil_scroll", "deltaY")).toBe("dy");
  });

  it("path->dir is scoped to veil_enable_downloads only; canonical names win", () => {
    expect(normalizeArgs("veil_pdf", { path: "/x.pdf" })).toEqual({ path: "/x.pdf" });
    expect(normalizeArgs("veil_eval", { expression: "1", script: "2" }).expression).toBe("1");
    // legacy table still applies
    expect(normalizeArgs("veil_upload", { files: ["/a"] })).toEqual({ paths: ["/a"] });
    expect(Object.keys(PARAM_ALIASES).length).toBeGreaterThan(0);
  });

  it("over stdio: unknown param still errors naming the canonical one (no Chrome needed)", async () => {
    const m = startMcp({});
    const r = await m.call("veil_eval", { bogus: "1+1" }, 10_000);
    expect(r.result.isError).toBe(true);
    expect(out(r)).toContain('missing required param "expression"');
    m.kill();
  }, 20_000);
});

// ---- throwaway headless Chrome + local page that sets a marker cookie ----
function freePort(): Promise<number> {
  return new Promise((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
}
async function throwawayChrome(): Promise<{ port: number; proc: ChildProcess; pageUrl: string }> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () =>
    new Response("<html><body>hello ZBODY page</body></html>", { headers: { "content-type": "text/html", "set-cookie": "zsess=ZMARK123; Path=/" } }) });
  cleanups.push(() => server.stop(true));
  const port = await freePort();
  const udd = join(scratch, "chrome-profile");
  const chrome = process.env.VEIL_CHROME || "/usr/bin/google-chrome";
  const proc = spawn(chrome, [`--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, "--headless=new", "--no-sandbox", "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  cleanups.push(() => { try { proc.kill("SIGKILL"); } catch {} });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    await Bun.sleep(100);
  }
  // load the marker page with a plain (non-private-blocking) veil connection, then drop it
  const { Browser } = await import("../src/index.js");
  const b = await Browser.connect(`127.0.0.1:${port}`, { blockPrivateNetwork: false });
  const pg = (await b.pages())[0] ?? (await b.newPage());
  const pageUrl = `http://127.0.0.1:${server.port}/`;
  await pg.goto(pageUrl);
  return { port, proc, pageUrl };
}

describe("(4) cookie redaction + aliases/body defaults against an attached throwaway Chrome", () => {
  it("ZMARK123 absent by default, present with VEIL_ALLOW_COOKIE_VALUES=1; aliases and body defaults work", async () => {
    const { port } = await throwawayChrome();
    const base = { VEIL_CDP_URL: `127.0.0.1:${port}`, VEIL_ATTACH_STRICT: "1" };
    const a = startMcp(base);
    const red = out(await a.call("veil_get_cookies", {}, 30_000));
    expect(red).toContain("zsess");               // positive control: the cookie exists and is listed by name
    expect(red).not.toContain("ZMARK123");
    // aliases against a live page
    expect(out(await a.call("veil_eval", { script: "6*7" }, 20_000))).toBe("42");
    expect(out(await a.call("veil_eval", { expr: "6*8" }, 20_000))).toBe("48");
    // body defaults
    expect(out(await a.call("veil_text", {}, 20_000))).toContain("ZBODY");
    expect(out(await a.call("veil_extract_text", {}, 20_000))).toContain("ZBODY");
    const s = await a.call("veil_scroll", { deltaY: 10 }, 20_000);
    expect(s.result.isError).toBeUndefined();
    a.kill();

    const b = startMcp({ ...base, VEIL_ALLOW_COOKIE_VALUES: "1" });
    const raw = out(await b.call("veil_get_cookies", {}, 30_000));
    expect(raw).toContain("ZMARK123");
    b.kill();
  }, 90_000);
});

describe("(3) VEIL_ATTACH_STRICT", () => {
  it("strict: attach failure returns the fix and spawns NO Chrome; non-strict control DOES launch", async () => {
    const spy = join(scratch, "fake-chrome.sh");
    const marker = join(scratch, "launched.marker");
    writeFileSync(spy, `#!/bin/sh\necho launched > "${marker}"\nexit 1\n`);
    chmodSync(spy, 0o755);
    const env = { VEIL_CDP_URL: "127.0.0.1:1", VEIL_CHROME: spy, VEIL_HEADLESS: "1", VEIL_USER_DATA_DIR: join(scratch, "udd-strict") };

    const s = startMcp({ ...env, VEIL_ATTACH_STRICT: "1" });
    const r = await s.call("veil_snapshot", {}, 30_000);
    expect(r.result.isError).toBe(true);
    expect(out(r)).toContain("VEIL_ATTACH_STRICT");
    expect(out(r)).toContain("127.0.0.1:1");
    expect(out(r)).toContain("--remote-debugging-port");
    await Bun.sleep(500);
    expect(existsSync(marker)).toBe(false);
    s.kill();

    // positive control: the spy WOULD have been executed if a launch had been attempted
    const n = startMcp(env);
    await n.call("veil_snapshot", {}, 30_000);
    expect(existsSync(marker)).toBe(true);
    n.kill();
  }, 90_000);
});

describe("(5) VEIL_ALLOW_ORIGINS on launch", () => {
  it("unlisted host -> AccessDenied; listed host passes the allowlist (fails later, at DNS)", async () => {
    const m = startMcp({ VEIL_ALLOW_ORIGINS: "listed.invalid, other.invalid", VEIL_HEADLESS: "1", VEIL_USER_DATA_DIR: join(scratch, "udd-allow"), VEIL_CHROME: process.env.VEIL_CHROME ?? "/usr/bin/google-chrome" });
    const denied = await m.call("veil_goto", { url: "http://unlisted.invalid/" }, 60_000);
    expect(out(denied).toLowerCase()).toMatch(/access.?denied/);
    const ok = await m.call("veil_goto", { url: "http://listed.invalid/" }, 60_000);
    expect(out(ok).toLowerCase()).not.toMatch(/access.?denied/);   // blocked-by-DNS or similar, not by the allowlist
    expect(m.stderr()).toContain("listed.invalid");                  // active list is printed
    await m.call("veil_close", {}, 20_000);
    m.kill();
  }, 120_000);
});
