/**
 * getCookies() — the symmetric read counterpart to setCookies(). INTEGRATION
 * test: launches a real headless Chrome, so it skips under CI (process.env.CI)
 * like the other browser-launching tests. The round-trip (set → get) needs no
 * network — the cookie store is populated directly over CDP.
 *
 * Run with: bun test tests/cookies.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;

describe.skipIf(!!process.env.CI)("getCookies", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("reads back a cookie injected via setCookies", async () => {
    await page.setCookies([
      { name: "veil_session", value: "abc123", domain: "example.com", path: "/" },
    ]);
    const cookies = await page.getCookies(["https://example.com/"]);
    const found = cookies.find((c) => c.name === "veil_session");
    expect(found).toBeTruthy();
    expect(found!.value).toBe("abc123");
    expect(found!.domain).toContain("example.com");
  }, TIMEOUT);

  it("returns an array (empty is fine on a blank page)", async () => {
    const cookies = await page.getCookies();
    expect(Array.isArray(cookies)).toBe(true);
  }, TIMEOUT);
});
