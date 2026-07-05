/**
 * Page lifecycle (open/close/cleanup) — an INTEGRATION test: it launches a real
 * headless Chrome. Skipped in CI (process.env.CI) because Chrome cold-start under
 * a loaded CI runner is non-deterministic against a short test timeout, and a
 * flaky-red CI is worse than no CI signal. The browser path is covered for real
 * by examples/selftest.ts and examples/fedcm.ts. Runs normally on a dev machine:
 *   bun test tests/lifecycle.test.ts
 */
import { describe, it, expect } from "bun:test";
import { Browser } from "../src/index.js";

const TIMEOUT = 30_000; // Chrome launch + nav + close, with headroom

describe.skipIf(!!process.env.CI)("page lifecycle", () => {
  it("page.close() is idempotent", async () => {
    const browser = await Browser.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`data:text/html,${encodeURIComponent("<h1>Test</h1>")}`);
      await page.close();
      await page.close(); // second close must not throw
      expect(true).toBe(true);
    } finally {
      await browser.close();
    }
  }, TIMEOUT);

  it("can create and close multiple pages", async () => {
    const browser = await Browser.launch({ headless: true });
    try {
      const pages = [];
      for (let i = 0; i < 5; i++) {
        const page = await browser.newPage();
        await page.goto(`data:text/html,${encodeURIComponent(`<h1>Page ${i}</h1>`)}`);
        pages.push(page);
      }
      expect(pages).toHaveLength(5);
      for (const page of pages) await page.close();
      expect(true).toBe(true);
    } finally {
      await browser.close();
    }
  }, TIMEOUT);
});
