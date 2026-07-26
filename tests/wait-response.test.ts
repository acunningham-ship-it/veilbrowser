/**
 * waitForResponse — read the status of a request the page made.
 *
 * The gap: an agent clicks Save, the button spins, and the only ways to learn
 * whether the write succeeded were polling the DOM for a toast that may never
 * appear, or sleeping and hoping. The HTTP status is the ground truth and was
 * not reachable from the public API at all.
 *
 * Two behaviours worth pinning:
 *  - a match that already happened before the await still resolves (the very
 *    common "click, then wait" ordering must not race)
 *  - a 4xx/5xx RESOLVES with ok:false rather than throwing — "the request
 *    failed" is an answer the caller wants, not an exception. Only a timeout
 *    rejects.
 *
 * INTEGRATION test (real headless Chrome), skips under CI. Requests are served
 * from a loopback http server on an ephemeral port — nothing leaves the box.
 *
 * Run with: bun test tests/wait-response.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createServer, type Server } from "node:http";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;

describe.skipIf(!!process.env.CI)("waitForResponse", () => {
  let browser: Browser;
  let page: Page;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith("/api/save")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"saved":true}');
      } else if (req.url?.startsWith("/api/boom")) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":"nope"}');
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<button id=go>Save</button>");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    base = `http://127.0.0.1:${port}`;
    // loopback is blocked by default (blockPrivateNetwork) — this test is about
    // response capture, so opt out for it specifically.
    browser = await Browser.launch({ headless: true, blockPrivateNetwork: false });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it("resolves with the status of a matching response", async () => {
    await page.goto(base);
    const wait = page.waitForResponse("/api/save", { timeout: 10_000 });
    await page.evaluate(`fetch("/api/save")`);
    const res = await wait;
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.url).toContain("/api/save");
  }, TIMEOUT);

  it("resolves for a response that already arrived before the await", async () => {
    await page.goto(base);
    await page.evaluate(`fetch("/api/save").then(r => r.text())`);
    await new Promise((r) => setTimeout(r, 300)); // let it land first
    const res = await page.waitForResponse("/api/save", { timeout: 5000 });
    expect(res.status).toBe(200);
  }, TIMEOUT);

  it("resolves (not rejects) on a 500, with ok:false", async () => {
    await page.goto(base);
    const wait = page.waitForResponse("/api/boom", { timeout: 10_000 });
    await page.evaluate(`fetch("/api/boom").catch(() => {})`);
    const res = await wait;
    expect(res.status).toBe(500);
    expect(res.ok).toBe(false);
  }, TIMEOUT);

  it("accepts a RegExp", async () => {
    await page.goto(base);
    const wait = page.waitForResponse(/\/api\/sa[v]e/, { timeout: 10_000 });
    await page.evaluate(`fetch("/api/save")`);
    expect((await wait).ok).toBe(true);
  }, TIMEOUT);

  it("times out with a message saying how many responses it did see", async () => {
    await page.goto(base);
    let msg = "";
    try {
      await page.waitForResponse("/never/happens", { timeout: 700 });
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg).toMatch(/nothing matching .* within 700ms/);
    expect(msg).toMatch(/response[s]? seen/);
  }, TIMEOUT);
});
