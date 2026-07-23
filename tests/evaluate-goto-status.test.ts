/**
 * evaluate() timeout + goto() response status. INTEGRATION test (real headless
 * Chrome + a throwaway local server), skips under CI.
 *
 * Run with: bun test tests/evaluate-goto-status.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;

/** Capture a rejection message via try/catch — bun's expect().rejects can
 *  misreport errors that race browser teardown. */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe.skipIf(!!process.env.CI)("evaluate timeout + goto status", () => {
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
        if (u.pathname === "/missing") return new Response("nope", { status: 404 });
        if (u.pathname === "/boom") return new Response("no", { status: 500 });
        return new Response("<h1>ok</h1>", { headers: { "content-type": "text/html" } });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
    await page.goto("data:text/html,<h1>ready</h1>");
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  it("evaluate still resolves normally", async () => {
    expect(await page.evaluate("1 + 1")).toBe(2);
  }, TIMEOUT);

  it("evaluate rejects cleanly on timeout instead of hanging", async () => {
    const start = Date.now();
    const msg = await rejectionMessage(page.evaluate("new Promise(() => {})", { timeout: 500 }));
    expect(msg).toMatch(/evaluate: timed out after 500ms/);
    expect(Date.now() - start).toBeLessThan(3000); // bounded, not a 30s hang
  }, TIMEOUT);

  it("goto returns HTTP 200 / ok for a success", async () => {
    const res = await page.goto(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.url).toBe(`${base}/`);
  }, TIMEOUT);

  it("goto returns 4xx / 5xx status with ok:false", async () => {
    const notFound = await page.goto(`${base}/missing`);
    expect(notFound.status).toBe(404);
    expect(notFound.ok).toBe(false);

    const serverErr = await page.goto(`${base}/boom`);
    expect(serverErr.status).toBe(500);
    expect(serverErr.ok).toBe(false);
  }, TIMEOUT);

  it("goto return shape is backward-compatible (still has url)", async () => {
    const res = await page.goto("data:text/html,<h1>x</h1>");
    expect(res.url).toContain("data:text/html");
  }, TIMEOUT);
});
