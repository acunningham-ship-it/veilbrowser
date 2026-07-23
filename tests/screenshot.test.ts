/**
 * screenshot() scope options — element (ref), explicit clip, fullPage, viewport.
 * INTEGRATION test (real headless Chrome), skips under CI. data: URL, no network.
 * We decode the PNG's IHDR to assert the captured pixel dimensions.
 *
 * Run with: bun test tests/screenshot.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

const isPng = (b: Buffer) =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
// PNG's first chunk is IHDR: width @ byte 16, height @ byte 20 (big-endian u32).
const pngSize = (b: Buffer) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) });

// A button sized to an exact border box (border/padding 0, box-sizing:border-box)
// so an element screenshot has predictable dimensions.
const PAGE = `<body style="margin:0"><button style="width:120px;height:40px;padding:0;border:0;margin:0;box-sizing:border-box">X</button></body>`;

describe.skipIf(!!process.env.CI)("screenshot scopes", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(dataUrl(PAGE));
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("default viewport screenshot still works", async () => {
    const png = await page.screenshot();
    expect(isPng(png)).toBe(true);
  }, TIMEOUT);

  it("clip captures exactly the requested rectangle", async () => {
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: 50, height: 50 } });
    expect(isPng(png)).toBe(true);
    expect(pngSize(png)).toEqual({ width: 50, height: 50 });
  }, TIMEOUT);

  it("ref captures just the element's border box", async () => {
    const snap = await page.snapshot();
    const btn = snap.elements.find((e) => e.role === "button");
    expect(btn).toBeTruthy();
    const png = await page.screenshot({ ref: btn!.ref });
    expect(isPng(png)).toBe(true);
    expect(pngSize(png)).toEqual({ width: 120, height: 40 });
  }, TIMEOUT);

  it("fullPage still works", async () => {
    const png = await page.screenshot({ fullPage: true });
    expect(isPng(png)).toBe(true);
  }, TIMEOUT);

  it("throws for an unknown ref", async () => {
    let msg = "";
    try {
      await page.screenshot({ ref: 9999 });
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg).toMatch(/No element with ref 9999/);
  }, TIMEOUT);
});
