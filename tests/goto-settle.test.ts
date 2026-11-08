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
          return new Response(`<!doctype html><title>stuck</title><h1>hi</h1><script src="/hang.js"></script>`, {
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
    const res = await page.goto(`${base()}/stuck`, { timeout: 10_000 });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect((page as any).lastNavReady).toBe(false);
    expect(await page.evaluate("location.href")).toBe(`${base()}/stuck`);
    expect(res.url).toBe(`${base()}/stuck`);
  }, 30_000);

  it("reload on the stuck page also resolves", async () => {
    const t0 = Date.now();
    await page.reload({ timeout: 10_000 });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect((page as any).lastNavReady).toBe(false);
    expect(await page.evaluate("location.href")).toBe(`${base()}/stuck`);
  }, 30_000);

  it("reload of a normal page sets lastNavReady=true again", async () => {
    await page.goto(`${base()}/ok`, { timeout: 15_000 });
    await page.reload({ timeout: 15_000 });
    expect((page as any).lastNavReady).toBe(true);
  }, 30_000);

  it("control: connection-refused still throws", async () => {
    const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const url = `http://127.0.0.1:${dead.port}/`;
    dead.stop(true);
    await expect(page.goto(url, { timeout: 10_000 })).rejects.toThrow(/ERR_|failed/);
  }, 30_000);
});
