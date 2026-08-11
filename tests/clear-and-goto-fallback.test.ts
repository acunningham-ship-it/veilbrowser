/**
 * Two fixes from the same pain-points pass (Claude marketing/veil-pain-points-2026-08-10.md):
 *
 * 1. clear(ref) — a first-class way to empty a field and read back the resulting
 *    length, instead of every posting skill hand-rolling Ctrl+A+Delete differently.
 *    Covers input, textarea, AND contenteditable — the contenteditable case is the
 *    one that broke on Instagram before (see press-modifiers.test.ts for the
 *    modifiers-actually-apply half of that fix).
 *
 * 2. goto()'s "load" wait no longer THROWS when the DOM landed but a background
 *    connection kept Page.loadEventFired from ever firing — measured as routine on
 *    real sites (Instagram, TikTok, holtroofing.com, ...). It still throws when the
 *    page genuinely never loaded.
 *
 * INTEGRATION test (real headless Chrome + a throwaway local server), skips under CI.
 * Run with: bun test tests/clear-and-goto-fallback.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

describe.skipIf(!!process.env.CI)("clear()", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  // Each fixture page has exactly one meaningful element in the accessibility
  // tree — snapshot()'s whole design goal is "never write a selector", so the
  // single-field ref is just elements[0].
  const soleRef = async () => {
    const snap = await page.snapshot();
    if (!snap.elements.length) throw new Error(`no elements in snapshot:\n${snap.text}`);
    return snap.elements[0].ref;
  };

  it("empties a pre-filled <input> and reports length 0", async () => {
    await page.goto(dataUrl(`<input id="f" value="old value">`));
    const len = await page.clear(await soleRef());
    expect(len).toBe(0);
    expect(await page.evaluate(`document.getElementById('f').value`)).toBe("");
  });

  it("empties a pre-filled <textarea>", async () => {
    await page.goto(dataUrl(`<textarea id="t">some existing text</textarea>`));
    const len = await page.clear(await soleRef());
    expect(len).toBe(0);
  });

  // role="textbox" matches how real rich-text editors (Instagram's caption box
  // included) mark up a contenteditable region — a bare div with no ARIA role
  // doesn't surface as an accessible control at all, on veil's page or any other.
  it("empties a contenteditable — the case that broke on Instagram", async () => {
    await page.goto(dataUrl(`<div id="e" contenteditable="true" role="textbox">caption text here</div>`));
    const len = await page.clear(await soleRef());
    expect(len).toBe(0);
    // textContent, not innerText: Chromium leaves a lone placeholder <br> after a
    // full clear, and innerText reads that as "\n" — see the comment in clear().
    expect(await page.evaluate(`document.getElementById('e').textContent`)).toBe("");
  });

  it("clear() then type() leaves ONLY the new text — the actual bug this fixes", async () => {
    // Before this fix, veil_press(key:"a", modifiers:["Control"]) silently typed a
    // literal "a" instead of selecting all, so a follow-up type() produced the old
    // and new text mashed together. clear() is the primitive that replaces that
    // whole broken sequence.
    await page.goto(dataUrl(`<div id="e" contenteditable="true" role="textbox">OLD CAPTION</div>`));
    await page.clear(await soleRef());
    await page.type("new caption");
    expect(await page.evaluate(`document.getElementById('e').innerText`)).toBe("new caption");
  });

  it("rejects a disabled field instead of silently no-op'ing", async () => {
    await page.goto(dataUrl(`<input id="f" value="x" disabled>`));
    const ref = await soleRef();
    let msg = "";
    try {
      await page.clear(ref);
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg).toMatch(/disabled/);
  });
}, TIMEOUT);

describe.skipIf(!!process.env.CI)("goto() load-timeout fallback", () => {
  let browser: Browser;
  let page: Page;
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const u = new URL(req.url);
        // An <img> whose request never resolves: DOMContentLoaded still fires
        // (readyState reaches "interactive"), but window/Page.loadEventFired
        // waits on every resource the initial document referenced and so never
        // fires — the exact shape measured on real sites tonight.
        if (u.pathname === "/hang-image") return new Promise(() => {}); // never resolves
        if (u.pathname === "/works") {
          return new Response(
            `<!doctype html><body>ok<img src="/hang-image"></body>`,
            { headers: { "content-type": "text/html" } },
          );
        }
        // A response that never finishes sending — the document itself never
        // finishes downloading, so readyState never even reaches "interactive".
        // This must still throw: not every load-timeout is benign.
        if (u.pathname === "/never-finishes") {
          const stream = new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode("<!doctype html><html><body>")); },
          });
          return new Response(stream, { headers: { "content-type": "text/html" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
  });
  afterAll(async () => {
    server?.stop(true);
    await browser?.close();
  });

  it("does NOT throw when the DOM landed but load never fired — returns ok + the flag", async () => {
    const result = await page.goto(`http://127.0.0.1:${server.port}/works`, { timeout: 1500 });
    expect(result.timedOutWaitingForLoad).toBe(true);
    expect(await page.evaluate("document.body.innerText")).toBe("ok");
  });

  it("still throws when the document itself never finished loading", async () => {
    let msg = "";
    try {
      await page.goto(`http://127.0.0.1:${server.port}/never-finishes`, { timeout: 1200 });
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg).toMatch(/Timed out waiting for Page\.loadEventFired/);
  });
}, TIMEOUT);
