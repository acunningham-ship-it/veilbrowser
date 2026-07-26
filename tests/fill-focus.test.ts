/**
 * fill() must verify that focus actually landed in an editable field.
 *
 * fill() = click, then Ctrl+A, then Delete, then type. Every one of those is a
 * blind keyboard dispatch to whatever happens to have focus. If the click did
 * not focus an editable element — the input is disabled or readonly, or the ref
 * points at something that isn't a field at all — then:
 *
 *   - Ctrl+A selects the whole DOCUMENT instead of the field's text
 *   - Delete does nothing (or worse, on a contenteditable page)
 *   - the typed text goes nowhere
 *   - fill() returns successfully
 *
 * The agent then proceeds believing a form is filled. Nothing downstream can
 * detect it. Same class as the stale-ref bug: a silent wrong outcome beats a
 * loud failure every time, and this one can also clobber a page-wide selection.
 *
 * INTEGRATION test (real headless Chrome), skips under CI. data: URL, no network.
 * Run with: bun test tests/fill-focus.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

const PAGE = `
  <input id=ok aria-label="ok field">
  <input id=dis aria-label="disabled field" disabled>
  <input id=ro aria-label="readonly field" readonly value="locked">
  <p id=para>not a field</p>`;

describe.skipIf(!!process.env.CI)("fill focus verification", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  const refFor = async (name: string) => {
    const snap = await page.snapshot();
    const el = snap.elements.find((e) => e.name === name);
    if (!el) return null;
    return el.ref;
  };

  const fillError = async (ref: number, text: string) => {
    try {
      await page.fill(ref, text);
    } catch (e: any) {
      return String(e?.message ?? e);
    }
    return "";
  };

  it("fills a normal field", async () => {
    await page.goto(dataUrl(PAGE));
    const ref = await refFor("ok field");
    expect(ref).not.toBeNull();
    await page.fill(ref!, "hello");
    expect(await page.evaluate("document.getElementById('ok').value")).toBe("hello");
  }, TIMEOUT);

  it("throws instead of silently no-opping on a disabled field", async () => {
    await page.goto(dataUrl(PAGE));
    const ref = await refFor("disabled field");
    if (ref == null) return; // a disabled input may be pruned from the AX tree; nothing to assert
    const msg = await fillError(ref, "nope");
    expect(msg).toMatch(/disabled|not editable|focus/i);
    expect(await page.evaluate("document.getElementById('dis').value")).toBe("");
  }, TIMEOUT);

  it("throws instead of silently no-opping on a readonly field", async () => {
    await page.goto(dataUrl(PAGE));
    const ref = await refFor("readonly field");
    if (ref == null) return;
    const msg = await fillError(ref, "nope");
    expect(msg).toMatch(/readonly|read-only|not editable|focus/i);
    // the original value must survive
    expect(await page.evaluate("document.getElementById('ro').value")).toBe("locked");
  }, TIMEOUT);

  it("does not leave a document-wide selection behind when it refuses", async () => {
    await page.goto(dataUrl(PAGE));
    const ref = await refFor("readonly field");
    if (ref == null) return;
    await fillError(ref, "nope");
    // Ctrl+A must never have reached the document.
    const selected = await page.evaluate<string>("String(window.getSelection())");
    expect(selected.trim()).toBe("");
  }, TIMEOUT);
});
