/**
 * Hermetic end-to-end test of the MCP server's ATTACH mode (VEIL_CDP_URL).
 *
 * Starts a throwaway Chrome (random debugging port, /tmp user-data-dir — never 9333, never a
 * real profile), spawns `bun run src/mcp.ts` against it and drives initialize, goto, snapshot,
 * click over stdio. Then asserts through Chrome's own /json/list that the attached tab was
 * REUSED: same tab count, that tab is the one that navigated and clicked, and no second Chrome
 * was launched. This is a regression guard (the feature already worked), not a red-first test.
 *
 * INTEGRATION test (real Chrome); skips when no Chrome is installed.
 * Run with: bun test tests/mcp-attach-e2e.test.ts
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

const MCP = join(import.meta.dir, "..", "src", "mcp.ts");
const PAGE = `data:text/html,${encodeURIComponent(
  `<title>before</title><button onclick="document.title='clicked'">Go</button>`,
)}`;

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

describe.skipIf(!chromePath)("MCP attach mode (hermetic)", () => {
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
  const call = async (name: string, args: object = {}): Promise<string> => {
    const r = await rpc("tools/call", { name, arguments: args });
    expect(r.result?.isError).toBeFalsy();
    return r.result.content[0].text as string;
  };

  beforeAll(async () => {
    port = await freePort();
    expect(port).not.toBe(9333);
    dir = mkdtempSync(join(tmpdir(), "veil-attach-e2e-"));
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
  }, 30_000);

  afterAll(async () => {
    // only PIDs this test started
    try { mcp?.stdin?.end(); } catch { /* */ }
    mcp?.kill("SIGTERM");
    chrome?.kill("SIGTERM");
    await Bun.sleep(500);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("drives the already-open tab over stdio without opening a second tab or Chrome", async () => {
    const before = await tabs(port);
    expect(before.length).toBe(1);
    const tabId = before[0].id;

    const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
    expect(init.result.serverInfo.name).toBe("veil");

    await call("veil_goto", { url: PAGE });
    const snap = await call("veil_snapshot");
    const ref = /\[(\d+)\][^\n]*Go/.exec(snap)?.[1];
    expect(ref).toBeDefined();
    await call("veil_click", { ref: Number(ref) });

    const after = await tabs(port);
    expect(after.length).toBe(before.length);
    expect(after[0].id).toBe(tabId);
    expect(after[0].title).toBe("clicked"); // the attached tab itself navigated AND took the click
    expect(stderr).toContain(`attached to Chrome at 127.0.0.1:${port}`);
    expect(stderr).not.toContain("launching one instead");
  }, 60_000);
});
