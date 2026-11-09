/**
 * goto()/reload() settle instead of throwing when the load event never fires but
 * the navigation committed (fleet data: 139 "Timed out waiting for
 * Page.loadEventFired" on veil_goto, 19/19 on veil_reload).
 *
 * INTEGRATION test: real headless Chrome with a throwaway profile under /tmp
 * (launcher default) + a local Bun.serve. Skips under CI.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

describe.skipIf(!!process.env.CI)("goto/reload settle", () => {
  let browser: Browser;
  let page: Page;
  let server: ReturnType<typeof Bun.serve>;
  const held: Array<() => void> = [];
  const base = () => `http://127.0.0.1:${server.port}`;

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0, // keep the held-open script response open (default 10 s would end it)
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/hang.js") {
          // Held-open response: headers sent, body never completes.
          const stream = new ReadableStream({
            start(c) { held.push(() => { try { c.close(); } catch {} }); },
          });
          return new Response(stream, { headers: { "content-type": "text/javascript" } });
        }
        if (u.pathname === "/stuck") {
          return new Response(`<!doctype html><title>stuck</title><h1>hi</h1><script src="/hang.js${u.search}"></script>`, {
            headers: { "content-type": "text/html" },
          });
        }
        return new Response(`<!doctype html><title>ok</title><h1>ok</h1>`, { headers: { "content-type": "text/html" } });
      },
    });
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  }, 60_000);
  afterAll(async () => {
    held.forEach((f) => f());
    await browser?.close();
    server?.stop(true);
  });

  it("control: a normal page reports lastNavReady=true", async () => {
    await page.goto(`${base()}/ok`, { timeout: 15_000 });
    expect((page as any).lastNavReady).toBe(true);
  }, 30_000);

  it("goto resolves (lastNavReady=false) when load never fires", async () => {
    const t0 = Date.now();
    const res = await page.goto(`${base()}/stuck`, { timeout: 10_000, settle: true });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect((page as any).lastNavReady).toBe(false);
    expect(await page.evaluate("location.href")).toBe(`${base()}/stuck`);
    expect(res.url).toBe(`${base()}/stuck`);
  }, 30_000);

  it("reload on the stuck page also resolves", async () => {
    const t0 = Date.now();
    await page.reload({ timeout: 10_000, settle: true });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect((page as any).lastNavReady).toBe(false);
    expect(await page.evaluate("location.href")).toBe(`${base()}/stuck`);
  }, 30_000);

  it("reload of a normal page sets lastNavReady=true again", async () => {
    await page.goto(`${base()}/ok`, { timeout: 15_000, settle: true });
    await page.reload({ timeout: 15_000, settle: true });
    expect((page as any).lastNavReady).toBe(true);
  }, 30_000);

  for (const settle of [false, true]) {
    it(`control: connection-refused (chrome-error) still throws, settle=${settle}`, async () => {
      const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
      const url = `http://127.0.0.1:${dead.port}/`;
      dead.stop(true);
      await expect(page.goto(url, { timeout: 10_000, settle })).rejects.toThrow(/ERR_|failed/);
    }, 30_000);
  }

  it("default (no settle): goto and reload on the hung page still THROW at the timeout, as before", async () => {
    // Fresh tab: after a failed goto, the chrome-error page's late load event can satisfy the NEXT
    // goto's waiter on the same tab (pre-existing on main, tracked separately), so don't share one.
    const p = await browser.newPage();
    // Explicit catch, not expect().rejects: this bun doesn't await a still-pending promise there, so the
    // test would end, afterAll would close the browser, and the goto would fail as "connection closed".
    const err = (f: () => Promise<unknown>) => f().then(() => "resolved", (e: Error) => e.message);
    expect(await err(() => p.goto(`${base()}/stuck?default`, { timeout: 3000 }))).toMatch(/Timed out waiting for Page\.loadEventFired/);
    expect(await err(() => p.reload({ timeout: 3000 }))).toMatch(/Timed out waiting for Page\.loadEventFired/);
  }, 30_000);
});

// Settle cap + the guards the first round left untested (adversary caveats on #31).
describe.skipIf(!!process.env.CI)("goto/reload settle cap", () => {
  let browser: Browser;
  let page: Page;
  let server: ReturnType<typeof Bun.serve>;
  const held: Array<() => void> = [];
  const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;

  beforeAll(async () => {
    server = Bun.serve({
      port: 0, hostname: "127.0.0.1", idleTimeout: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/hang.js") {
          return new Response(new ReadableStream({ start(c) { held.push(() => { try { c.close(); } catch {} }); } }),
            { headers: { "content-type": "text/javascript" } });
        }
        return new Response(`<!doctype html><title>stuck</title><h1>hi</h1><script src="/hang.js"></script>`,
          { headers: { "content-type": "text/html" } });
      },
    });
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  }, 60_000);
  afterAll(async () => { held.forEach((f) => f()); await browser?.close(); server?.stop(true); });

  it("goto on a hung page resolves at the default 8 s cap, not the 30 s timeout", async () => {
    const t0 = Date.now();
    await page.goto(url("/stuck"), { settle: true });
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(12_000);
    expect(ms).toBeGreaterThan(7_000);
    expect((page as any).lastNavReady).toBe(false);
  }, 40_000);

  it("settleMs is honoured on goto and reload", async () => {
    let t0 = Date.now();
    await page.goto(url("/stuck2"), { settle: true, settleMs: 1500 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    t0 = Date.now();
    await page.reload({ settle: true, settleMs: 1500 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect((page as any).lastNavReady).toBe(false);
  }, 30_000);

  it("explicit networkidle still throws on a hung page", async () => {
    const msg = await page.goto(url("/stuck3"), { waitUntil: "networkidle", timeout: 3000, settle: true }).then(() => "resolved", (e: Error) => e.message);
    expect(msg).not.toBe("resolved"); // explicit catch: see the default-throws test on expect().rejects
  }, 30_000);

  it("only the identified load timeout is swallowed: other errors and networkidle rethrow", async () => {
    const decide = (e: unknown, w: "load" | "networkidle") => (page as any).committedAfterLoadTimeout(e, w);
    expect(await decide(new Error("Timed out waiting for Page.loadEventFired"), "load")).toBe(true); // control: page is committed
    expect(await decide(new Error("CDP connection closed"), "load")).toBe(false);
    expect(await decide(new Error("net::ERR_CONNECTION_RESET"), "load")).toBe(false);
    expect(await decide(new Error("Timed out waiting for Page.loadEventFired"), "networkidle")).toBe(false);
    // about:blank never counts as committed, in either mode
    await page.goto("about:blank");
    expect(await (page as any).committedNow()).toBe(false);
    expect(await (page as any).committedAfterLoadTimeout(new Error("Timed out waiting for Page.loadEventFired"), "load", true)).toBe(false);
  }, 30_000);
});

// The MCP opts in, and must tell the agent the page may be partly loaded.
describe.skipIf(!!process.env.CI)("veil_goto (MCP) on a hung page", () => {
  it("resolves at the settle cap and the tool text says NOT ready", async () => {
    const { spawn } = await import("node:child_process");
    const { mkdtempSync, rmSync, readdirSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const held: Array<() => void> = [];
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch(req) {
      if (new URL(req.url).pathname === "/hang.js")
        return new Response(new ReadableStream({ start(c) { held.push(() => { try { c.close(); } catch {} }); } }), { headers: { "content-type": "text/javascript" } });
      return new Response(`<!doctype html><h1>hi</h1><script src="/hang.js"></script>`, { headers: { "content-type": "text/html" } });
    } });
    const udd = mkdtempSync(join(tmpdir(), "veil-goto-settle-mcp-")); // throwaway profile; never attaches (VEIL_CDP_URL dropped)
    const child = spawn("bun", ["run", join(import.meta.dir, "..", "src", "mcp.ts")], {
      env: (({ VEIL_CDP_URL: _never, ...rest }) => ({ ...rest, VEIL_HEADLESS: "1", VEIL_USER_DATA_DIR: udd }))(process.env as any), stdio: ["pipe", "pipe", "ignore"],
    });
    let buf = ""; const waiters = new Map<number, (m: any) => void>();
    child.stdout!.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); waiters.get(m.id)?.(m); } catch {} } });
    let n = 0;
    const rpc = (method: string, params: any) => new Promise<any>((res) => { const id = ++n; waiters.set(id, res); child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
    try {
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
      const t0 = Date.now();
      const r = await rpc("tools/call", { name: "veil_goto", arguments: { url: `http://127.0.0.1:${srv.port}/stuck` } });
      const text = (r.result?.content ?? []).map((c: any) => c.text).join("\n");
      expect(Date.now() - t0).toBeLessThan(20_000);   // settle cap, not the 30 s timeout
      expect(r.result?.isError).not.toBe(true);
      expect(text).toContain("load event never fired");
    } finally {
      held.forEach((f) => f());
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1500));
      for (const d of readdirSync("/proc")) { if (/^\d+$/.test(d)) try { if (readFileSync(`/proc/${d}/cmdline`, "latin1").includes(udd)) process.kill(+d, "SIGKILL"); } catch {} }
      srv.stop(true);
      rmSync(udd, { recursive: true, force: true });
    }
  }, 60_000);
});
