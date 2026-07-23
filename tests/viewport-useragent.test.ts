/**
 * setViewport() / setUserAgent() — runtime Emulation overrides. INTEGRATION
 * test (real headless Chrome), skips under CI. data: URL, no network.
 *
 * Run with: bun test tests/viewport-useragent.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;

describe.skipIf(!!process.env.CI)("setViewport / setUserAgent", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
    await page.goto("data:text/html,<h1>emulation</h1>");
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("setViewport changes innerWidth/Height and devicePixelRatio", async () => {
    // mobile:false — with mobile:true a page lacking a viewport meta lays out at
    // Chrome's 980px mobile-overview fallback, which would mask the width.
    await page.setViewport({ width: 400, height: 812, deviceScaleFactor: 2, mobile: false });
    expect(await page.evaluate("window.innerWidth")).toBe(400);
    expect(await page.evaluate("window.innerHeight")).toBe(812);
    expect(await page.evaluate("window.devicePixelRatio")).toBe(2);
  }, TIMEOUT);

  it("setUserAgent overrides navigator.userAgent (live, and across navigation)", async () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    await page.setUserAgent(ua);
    // Live override — visible without a navigation…
    expect(await page.evaluate("navigator.userAgent")).toBe(ua);
    // …and it persists across one.
    await page.goto("data:text/html,<h1>ua</h1>");
    expect(await page.evaluate("navigator.userAgent")).toBe(ua);
  }, TIMEOUT);
});
