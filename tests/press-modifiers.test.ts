/**
 * press() with modifier chords: "Control+a", "Shift+Tab", "Meta+c".
 *
 * sendKey() already understood CDP's modifier bitfield, but press() exposed no
 * way to reach it — so select-all, copy/paste, Ctrl+Enter to submit, and
 * Shift+Tab to walk a form backwards were all unreachable from the public API.
 * Agents need those constantly.
 *
 * The subtle part is that a chord with Ctrl/Alt/Meta is a COMMAND, not text:
 * emitting a char event alongside it types a literal "a" into the field at the
 * same time as the Ctrl+A, which silently corrupts the value.
 *
 * INTEGRATION test (real headless Chrome), skips under CI. data: URL, no network.
 * Run with: bun test tests/press-modifiers.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

const PAGE = `
  <input id=one aria-label="one" value="abc">
  <input id=two aria-label="two">
  <div id=log></div>
  <script>
    document.addEventListener('keydown', e => {
      document.getElementById('log').textContent =
        [e.ctrlKey?'ctrl':'', e.shiftKey?'shift':'', e.altKey?'alt':'', e.metaKey?'meta':'', e.key].filter(Boolean).join('+');
    });
  </script>`;

describe.skipIf(!!process.env.CI)("press() modifier chords", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  const focusOne = async () => {
    await page.goto(dataUrl(PAGE));
    await page.evaluate("document.getElementById('one').focus()");
  };

  it("reports ctrl held for Control+a", async () => {
    await focusOne();
    await page.press("Control+a");
    expect(await page.evaluate("document.getElementById('log').textContent")).toBe("ctrl+a");
  }, TIMEOUT);

  it("does NOT type a literal character for a command chord", async () => {
    await focusOne();
    await page.press("Control+a");
    // the field must still read "abc" — no stray "a" appended by a char event
    expect(await page.evaluate("document.getElementById('one').value")).toBe("abc");
  }, TIMEOUT);

  it("reports shift held for Shift+Tab", async () => {
    await focusOne();
    await page.press("Shift+Tab");
    expect(await page.evaluate("document.getElementById('log').textContent")).toBe("shift+Tab");
  }, TIMEOUT);

  it("stacks multiple modifiers", async () => {
    await focusOne();
    await page.press("Control+Shift+k");
    expect(await page.evaluate("document.getElementById('log').textContent")).toBe("ctrl+shift+k");
  }, TIMEOUT);

  it("still handles a bare named key", async () => {
    await focusOne();
    await page.press("Tab");
    expect(await page.evaluate("document.getElementById('log').textContent")).toBe("Tab");
  }, TIMEOUT);

  it("rejects an unknown modifier by name", async () => {
    await focusOne();
    let msg = "";
    try {
      await page.press("Hyper+a");
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg).toMatch(/unknown modifier/i);
  }, TIMEOUT);
});
