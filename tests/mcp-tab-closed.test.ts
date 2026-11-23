/**
 * Red-first: the MCP server must survive its tab being closed under it.
 *
 * Attached mode drives one tab. When that tab is closed (a human, another client, or
 * /json/close), the cached Page's CDP session is gone and every later call used to fail
 * with -32001 "Session with given id not found" until the server was restarted, because
 * ensurePage() only dropped the page when the whole browser disconnected.
 *
 * Expected now: the next call opens a fresh tab and works, and it does NOT take over
 * another tab that is already open (on a shared browser that tab is another client's).
 *
 * INTEGRATION test (real Chrome, random port, /tmp profile, never 9333); skips without Chrome.
 * Run with: bun test tests/mcp-tab-closed.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome } from "../src/launcher.js";

let chromePath: string | null = null;
try { chromePath = findChrome(); } catch { /* no Chrome here */ }
if (!chromePath && process.env.VEIL_REQUIRE_CHROME) throw new Error("VEIL_REQUIRE_CHROME is set but findChrome() found no Chrome");

const MCP = join(import.meta.dir, "..", "src", "mcp.ts");
const page = (title: string) => `data:text/html,${encodeURIComponent(`<title>${title}</title><p>${title}</p>`)}`;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as any).port;
      s.close(() => resolve(port));
    });
  });

const tabs = async (port: number): Promise<any[]> =>
  ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[]).filter((t) => t.type === "page");

describe.skipIf(!chromePath)("MCP survives its tab being closed (hermetic)", () => {
  let port: number;
  let dir: string;
  let chrome: ChildProcess;
  let mcp: ChildProcess;
  let out = "";
  let stderr = "";
  let nextId = 1;
  const waiting = new Map<number, (m: any) => void>();

  const rpc = (method: string, params?: object): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => reject(new Error(`no reply to ${method}\n${stderr}`)), 40_000);
      waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
      mcp.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const call = async (name: string, args: object = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    return { isError: !!r.result?.isError, text: (r.result?.content?.[0]?.text ?? JSON.stringify(r.error)) as string };
  };

  beforeAll(async () => {
    port = await freePort();
    expect(port).not.toBe(9333);
    dir = mkdtempSync(join(tmpdir(), "veil-tab-closed-"));
    chrome = spawn(
      chromePath!,
      [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--headless=new", "--no-sandbox",
       "--no-first-run", "--no-default-browser-check", "about:blank"],
      { stdio: "ignore" },
    );
    for (let i = 0; i < 100; i++) {
      try { if ((await tabs(port)).length) break; } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
    mcp = spawn("bun", ["run", MCP], {
      env: { ...process.env, VEIL_CDP_URL: `127.0.0.1:${port}`, VEIL_USER_DATA_DIR: join(dir, "mcp-must-not-be-used") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    mcp.stderr!.on("data", (d) => { stderr += d.toString(); });
    mcp.stdout!.on("data", (d) => {
      out += d.toString();
      let nl: number;
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl);
        out = out.slice(nl + 1);
        try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch { /* ignore */ }
      }
    });
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  }, 30_000);

  afterAll(async () => {
    // only PIDs this test started
    try { mcp?.stdin?.end(); } catch { /* */ }
    mcp?.kill("SIGTERM");
    chrome?.kill("SIGTERM");
    await Bun.sleep(500);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("goto, close that tab, goto again: works on a fresh tab and leaves the other tab alone", async () => {
    const first = await call("veil_goto", { url: page("one") });
    expect(first.isError).toBe(false);
    const driven = (await tabs(port)).find((t) => t.title === "one");
    expect(driven).toBeDefined();

    // Another client's tab on the same browser. It must not be hijacked.
    const other = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json() as any;
    expect((await fetch(`http://127.0.0.1:${port}/json/close/${driven.id}`)).ok).toBe(true);
    for (let i = 0; i < 50 && (await tabs(port)).some((t) => t.id === driven.id); i++) await Bun.sleep(100);

    const second = await call("veil_goto", { url: page("two") });
    expect(second.text).not.toContain("Session with given id not found");
    expect(second.isError).toBe(false);

    const after = await tabs(port);
    expect(after.some((t) => t.id === driven.id)).toBe(false);
    expect(after.find((t) => t.id === other.id)?.url).toBe("about:blank");
    const fresh = after.find((t) => t.title === "two");
    expect(fresh).toBeDefined();
    expect(fresh.id).not.toBe(other.id);

    // and the server keeps working on that tab
    const snap = await call("veil_snapshot");
    expect(snap.isError).toBe(false);
  }, 60_000);
});
