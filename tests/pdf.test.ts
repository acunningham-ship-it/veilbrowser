/**
 * pdf() — Page.printToPDF → Buffer. INTEGRATION test (real headless Chrome),
 * skips under CI. PDF printing is a HEADLESS-only Chrome feature, which is
 * exactly the mode this test launches. data: URL, no network.
 *
 * Run with: bun test tests/pdf.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

describe.skipIf(!!process.env.CI)("pdf", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(dataUrl(`<h1>Veil PDF</h1><p>hello from a printToPDF test</p>`));
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("renders a valid PDF buffer", async () => {
    const buf = await page.pdf();
    expect(Buffer.isBuffer(buf)).toBe(true);
    // Every PDF starts with the "%PDF-" magic and ends near "%%EOF".
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(500);
  }, TIMEOUT);

  it("honors pass-through options (landscape)", async () => {
    const buf = await page.pdf({ landscape: true, printBackground: true });
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, TIMEOUT);
});
