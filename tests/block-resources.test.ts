/**
 * blockResources() / unblockResources() — and their coexistence with the
 * default-on private-network guard (both share one Fetch handler). INTEGRATION
 * test: launches real headless Chrome AND a throwaway local HTTP server, so it
 * skips under CI. The page is served from 127.0.0.1 (a private host, so the
 * top-level nav is allowed by the guard); only the resource loads are blocked.
 *
 * Run with: bun test tests/block-resources.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

describe.skipIf(!!process.env.CI)("blockResources", () => {
  let browser: Browser;
  let page: Page;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/img.png") return new Response(PNG, { headers: { "content-type": "image/png" } });
        return new Response(`<!doctype html><img id=pic src="/img.png">`, { headers: { "content-type": "text/html" } });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    browser = await Browser.launch({ headless: true }); // private-network guard ON by default
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  const naturalWidth = () => page.evaluate<number>("document.getElementById('pic') ? document.getElementById('pic').naturalWidth : -1");

  it("a same-origin (private) page's image loads with no blocking", async () => {
    await page.goto(`${base}/`);
    await page.waitFor("document.getElementById('pic').complete", { timeout: 5000 });
    expect(await naturalWidth()).toBeGreaterThan(0);
  }, TIMEOUT);

  it("blockResources(['image']) fails the image load (coexisting with the guard)", async () => {
    await page.blockResources(["image"]);
    await page.goto(`${base}/`);
    await page.waitFor("document.getElementById('pic').complete", { timeout: 5000 });
    expect(await naturalWidth()).toBe(0);
  }, TIMEOUT);

  it("unblockResources() restores the load", async () => {
    await page.unblockResources();
    await page.goto(`${base}/`);
    await page.waitFor("document.getElementById('pic').complete", { timeout: 5000 });
    expect(await naturalWidth()).toBeGreaterThan(0);
  }, TIMEOUT);

  it("URL-substring blocking fails a matching request", async () => {
    await page.blockResources([], { urls: ["img.png"] });
    await page.goto(`${base}/`);
    await page.waitFor("document.getElementById('pic').complete", { timeout: 5000 });
    expect(await naturalWidth()).toBe(0);
    await page.unblockResources();
  }, TIMEOUT);

  it("private-network guard still blocks a PUBLIC page reaching a private host", async () => {
    // data: URL is an opaque (public) origin — fetching 127.0.0.1 must be blocked
    // by the guard, proving the refactor preserved the security default.
    await page.goto("data:text/html,<h1>public</h1>");
    const outcome = await page.evaluate<string>(`fetch("${base}/img.png").then(() => "ok", () => "blocked")`);
    expect(outcome).toBe("blocked");
  }, TIMEOUT);

  it("rejects an unknown resource type", async () => {
    let msg = "";
    try {
      await page.blockResources(["bogus"]);
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg).toMatch(/unknown type "bogus"/);
  }, TIMEOUT);
});
