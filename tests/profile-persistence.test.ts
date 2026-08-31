/**
 * Regression: browser.close() must let Chrome flush the profile (cookies,
 * localStorage) to disk before the process dies, or a persistent userDataDir
 * — the entire point of passing one, e.g. an agent staying logged into an
 * account across restarts — silently loses whatever was just set.
 *
 * Root cause: close() sent the CDP `Browser.close` (the graceful-quit
 * signal) but never waited for it to take effect before immediately
 * SIGKILLing the whole process group right after — the kill raced ahead of
 * Chrome's own shutdown flush. Found while wiring a persistent login profile
 * for a real deployment; reproduced and fixed here.
 *
 * INTEGRATION test (real headless Chrome), skips under CI.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/index.js";

const TIMEOUT = 30_000;

describe.skipIf(!!process.env.CI)("profile persistence across close+relaunch", () => {
  it("a cookie set in one session survives close() and is there in the next launch on the same userDataDir", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "veil-persist-test-"));
    try {
      let browser = await Browser.launch({ headless: true, userDataDir: profileDir });
      let page = await browser.newPage();
      await page.goto("https://example.com/");
      await page.evaluate(`document.cookie = "veil_persist_test=survived; path=/; max-age=86400"`);
      await browser.close(); // must not return until the profile is actually flushed

      browser = await Browser.launch({ headless: true, userDataDir: profileDir });
      page = await browser.newPage();
      await page.goto("https://example.com/");
      const cookies = await page.getCookies();
      await browser.close();

      const survived = cookies.find((c) => c.name === "veil_persist_test");
      expect(survived).toBeTruthy();
      expect(survived?.value).toBe("survived");
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  }, TIMEOUT);
});
