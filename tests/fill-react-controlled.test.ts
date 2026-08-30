/**
 * fill() on <input>/<textarea> must commit through a React (or any framework
 * using the same shadowed-setter pattern) controlled component's OWN state,
 * not just the raw DOM .value — and must do it fast, not one dispatched
 * keystroke per character.
 *
 * Root cause fixed here (2026-08-29, judge #7702, reproduced live on a
 * Bold.org essay textarea): the old fill() dispatched one real
 * keydown/char/keyUp triple per character. Two failures from that:
 *   1. SLOW — ~2900 chars took 120s+.
 *   2. Some pages re-render (autosave, live word count, validation) on every
 *      single keystroke, and that per-keystroke churn can throw mid-dispatch.
 *
 * Fix: for <input>/<textarea>, set .value once via the native property
 * setter, reset the element's React `_valueTracker` to the OLD value first
 * (the documented React 16+ controlled-input testing gotcha — React shadows
 * the native setter and compares against a cached tracker value to decide
 * whether a raw 'input' event actually changed anything), then dispatch one
 * 'input' + 'change' event. contenteditable (no .value/tracker) still uses
 * real keystrokes.
 *
 * INTEGRATION test (real headless Chrome), skips under CI. data: URL, no
 * network — the test page embeds a minimal inline React-like controlled
 * component using nothing but the same _valueTracker mechanism real React
 * installs, so this doesn't depend on a CDN fetch succeeding under CI.
 * Run with: bun test tests/fill-react-controlled.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

// Minimal stand-in for what React actually installs on a controlled <input>/
// <textarea>: a shadowed value setter (so writing .value directly is a no-op
// from the "committed" state's point of view) plus a _valueTracker whose
// setValue() is what un-shadows a write — exactly the mechanism fill() now
// has to cooperate with. This is the same shape real React 16+ uses, kept
// dependency-free so the test doesn't need a CDN React bundle under CI.
const PAGE = `
  <textarea id=essay></textarea>
  <div id=committed>uncommitted</div>
  <input id=field>
  <div id=field-committed>uncommitted</div>
  <div id=contenteditable-target contenteditable="true" role="textbox" aria-label="ce-field"></div>
  <input id=fillText-field placeholder="fillText-target">
  <div id=fillText-committed>uncommitted</div>
  <script>
    function makeControlled(el, echoEl) {
      let committed = '';
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      const nativeGetter = Object.getOwnPropertyDescriptor(proto, 'value').get;
      let tracked = '';
      el._valueTracker = {
        setValue(v) { tracked = v; },
        getValue() { return tracked; },
      };
      Object.defineProperty(el, 'value', {
        get() { return nativeGetter.call(el); },
        set(v) { nativeSetter.call(el, v); }, // writing .value does NOT update the tracker
        configurable: true,
      });
      el.addEventListener('input', () => {
        const raw = nativeGetter.call(el);
        // React's real behavior: only "commits" (re-renders) if the raw DOM
        // value differs from what the tracker last recorded — i.e. the
        // tracker MUST have been reset to the old value before 'input' fires,
        // or this never sees a change and echoEl never updates.
        if (raw !== tracked) {
          committed = raw;
          tracked = raw;
          echoEl.textContent = committed;
        }
      });
    }
    makeControlled(document.getElementById('essay'), document.getElementById('committed'));
    makeControlled(document.getElementById('field'), document.getElementById('field-committed'));
    makeControlled(document.getElementById('fillText-field'), document.getElementById('fillText-committed'));
  </script>`;

describe.skipIf(!!process.env.CI)("fill() on React-controlled inputs", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(dataUrl(PAGE));
  }, TIMEOUT);

  afterAll(async () => {
    await browser?.close();
  });

  it("does not throw on a textarea", async () => {
    const snap = await page.snapshot();
    const ref = Number(snap.text.split("\n").find((l) => /textbox/i.test(l))!.match(/^\[(\d+)\]/)![1]);
    // Not `.resolves.toBeUndefined()` — bun's `.resolves` matcher races the
    // underlying CDP send oddly here (`CDP connection closed` on every test
    // after this one), even though the same fill() awaited directly works
    // fine. Plain await + no throw is exactly what "does not throw" means.
    await page.fill(ref, "hello world");
  }, TIMEOUT);

  it("commits through the tracker so the framework's OWN state updates, not just raw .value", async () => {
    const snap = await page.snapshot();
    const ref = Number(snap.text.split("\n").find((l) => /textbox/i.test(l))!.match(/^\[(\d+)\]/)![1]);
    const text = "the framework must see this, not just the DOM";
    await page.fill(ref, text);
    const raw = await page.evaluate<string>("document.getElementById('essay').value");
    const committed = await page.evaluate<string>("document.getElementById('committed').textContent");
    expect(raw).toBe(text);
    expect(committed).toBe(text); // only true if the tracker reset worked
  }, TIMEOUT);

  it("round-trips non-ASCII exactly (em-dash, accents, CJK, emoji)", async () => {
    const snap = await page.snapshot();
    const ref = Number(snap.text.split("\n").find((l) => /textbox/i.test(l))!.match(/^\[(\d+)\]/)![1]);
    const text = "em—dash café naïve 日本語 emoji 🎮 done";
    await page.fill(ref, text);
    const raw = await page.evaluate<string>("document.getElementById('essay').value");
    expect(raw).toBe(text);
  }, TIMEOUT);

  it("is fast — a long fill completes in well under a second, not the ~40ms/char the old per-keystroke path cost", async () => {
    const snap = await page.snapshot();
    const ref = Number(snap.text.split("\n").find((l) => /textbox/i.test(l))!.match(/^\[(\d+)\]/)![1]);
    const longText = "word ".repeat(600); // 3000 chars — old path measured 120s+ on this order of magnitude
    const t0 = Date.now();
    await page.fill(ref, longText);
    const elapsed = Date.now() - t0;
    const raw = await page.evaluate<string>("document.getElementById('essay').value");
    expect(raw).toBe(longText);
    expect(elapsed).toBeLessThan(5_000); // generous CI margin; real cost is a few hundred ms
  }, TIMEOUT);

  it("works the same way on a plain <input>, not just <textarea>", async () => {
    const snap = await page.snapshot();
    const line = snap.text.split("\n").filter((l) => /textbox/i.test(l))[1]; // the input, second textbox
    const ref = Number(line.match(/^\[(\d+)\]/)![1]);
    await page.fill(ref, "input works too");
    const committed = await page.evaluate<string>("document.getElementById('field-committed').textContent");
    expect(committed).toBe("input works too");
  }, TIMEOUT);

  it("fillText (the ref-less analogue) commits through the tracker too, non-ASCII included", async () => {
    const text = "fillText also—must commit café 🎮";
    await page.fillText("fillText-target", text);
    const raw = await page.evaluate<string>("document.getElementById('fillText-field').value");
    const committed = await page.evaluate<string>("document.getElementById('fillText-committed').textContent");
    expect(raw).toBe(text);
    expect(committed).toBe(text); // only true if the tracker reset worked, same as fill()
  }, TIMEOUT);

  it("still uses real keystrokes on contenteditable (no .value/tracker to set)", async () => {
    const snap = await page.snapshot();
    const line = snap.text.split("\n").find((l) => /ce-field/i.test(l));
    const ref = Number(line?.match(/^\[(\d+)\]/)?.[1]);
    expect(Number.isFinite(ref)).toBe(true);
    await page.fill(ref, "ce text");
    const raw = await page.evaluate<string>("document.getElementById('contenteditable-target').textContent");
    expect(raw).toBe("ce text");
  }, TIMEOUT);
});
