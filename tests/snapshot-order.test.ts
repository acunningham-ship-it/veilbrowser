/**
 * snapshot() resolves layout boxes concurrently. Refs must still come back in
 * accessibility-tree order, densely numbered from 1.
 *
 * This is the one property batching can break: replies arrive out of order, so
 * an implementation that assigns refs as results land produces numbering that
 * shuffles between runs. An agent that reads "[7] button Save" from one
 * snapshot and clicks ref 7 after the next would hit a different element — the
 * same silent-wrong-target family as stale refs, but caused by our own
 * concurrency rather than the page.
 *
 * INTEGRATION test (real headless Chrome), skips under CI. data: URL, no network.
 * Run with: bun test tests/snapshot-order.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

const N = 60;
const PAGE = `<body>${Array.from({ length: N }, (_, i) => `<button>Button ${i}</button>`).join("")}</body>`;

describe.skipIf(!!process.env.CI)("snapshot ordering under concurrent box resolution", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("numbers refs densely from 1 in document order", async () => {
    await page.goto(dataUrl(PAGE));
    const snap = await page.snapshot();

    expect(snap.elements.length).toBe(N);
    // dense and ascending: 1..N with no gaps and no reordering
    expect(snap.elements.map((e) => e.ref)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    // and the ref order matches the source order of the buttons
    expect(snap.elements.map((e) => e.name)).toEqual(Array.from({ length: N }, (_, i) => `Button ${i}`));
  }, TIMEOUT);

  it("is stable across repeated snapshots of an unchanged page", async () => {
    await page.goto(dataUrl(PAGE));
    const a = await page.snapshot();
    const b = await page.snapshot();
    expect(b.elements.map((e) => `${e.ref}:${e.name}`)).toEqual(a.elements.map((e) => `${e.ref}:${e.name}`));
  }, TIMEOUT);

  it("skips invisible elements without leaving holes in the numbering", async () => {
    await page.goto(
      dataUrl(`<button>alpha</button>
               <button style="display:none">ghost</button>
               <button>beta</button>`),
    );
    const snap = await page.snapshot();
    expect(snap.elements.map((e) => e.name)).toEqual(["alpha", "beta"]);
    expect(snap.elements.map((e) => e.ref)).toEqual([1, 2]);
  }, TIMEOUT);
});
