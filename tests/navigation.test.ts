/**
 * reload() / back() / forward() and goto()'s waitUntil:"networkidle".
 * INTEGRATION test (real headless Chrome + a throwaway local server for the
 * networkidle case), so it skips under CI.
 *
 * Run with: bun test tests/navigation.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

describe.skipIf(!!process.env.CI)("navigation", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("reload() re-runs the document (fresh window)", async () => {
    await page.goto(dataUrl("<title>R</title><h1>reload</h1>"));
    await page.evaluate("window.__marker = 42");
    expect(await page.evaluate("window.__marker")).toBe(42);
    await page.reload();
    expect(await page.evaluate("typeof window.__marker")).toBe("undefined");
  }, TIMEOUT);

  it("back() and forward() move through session history", async () => {
    await page.goto(dataUrl("<title>Alpha</title>"));
    await page.goto(dataUrl("<title>Beta</title>"));
    expect(await page.evaluate("document.title")).toBe("Beta");
    await page.back();
    expect(await page.evaluate("document.title")).toBe("Alpha");
    await page.forward();
    expect(await page.evaluate("document.title")).toBe("Beta");
  }, TIMEOUT);

  it("back() throws when there is no earlier entry", async () => {
    const fresh = await browser.newPage(); // history is just [about:blank]
    let msg = "";
    try {
      await fresh.back();
    } catch (e: any) {
      msg = String(e?.message ?? e);
    } finally {
      await fresh.close();
    }
    expect(msg).toMatch(/no earlier history entry/);
  }, TIMEOUT);

  it("goto waitUntil:networkidle waits for a fetch made after load", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/slow") {
          await Bun.sleep(400);
          return new Response("done");
        }
        return new Response(
          `<!doctype html><body><script>window.__fetched=false;fetch("/slow").then(r=>r.text()).then(t=>{window.__fetched=t;});</script>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      await page.goto(`${base}/`, { waitUntil: "networkidle" });
      // networkidle must have waited past the 400ms deferred fetch.
      expect(await page.evaluate("window.__fetched")).toBe("done");
    } finally {
      server.stop(true);
    }
  }, TIMEOUT);
});
