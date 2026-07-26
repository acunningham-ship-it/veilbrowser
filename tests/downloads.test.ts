/**
 * Downloads.
 *
 * Chrome driven over CDP CANCELS downloads by default. Before enableDownloads()
 * existed, clicking an export / invoice / "download report" link did nothing at
 * all: no file, no error, and a click() that returned successfully. Agents hit
 * this the moment they touch a real dashboard.
 *
 * INTEGRATION test (real headless Chrome), skips under CI. data: URL, no network
 * — the download source is a data: href, so nothing leaves the box.
 *
 * Run with: bun test tests/downloads.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

const PAGE = `
  <a id=dl download="report.txt" href="data:text/plain,hello%20from%20veil">Download report</a>`;

describe.skipIf(!!process.env.CI)("downloads", () => {
  let browser: Browser;
  let page: Page;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "veil-dl-"));
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a relative download directory", async () => {
    let msg = "";
    try {
      await page.enableDownloads("relative/path");
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg).toMatch(/absolute/i);
  }, TIMEOUT);

  it("tells you to enable downloads before waiting for one", async () => {
    const fresh = await browser.newPage();
    let msg = "";
    try {
      await fresh.waitForDownload({ timeout: 500 });
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg).toMatch(/enableDownloads/);
    await fresh.close();
  }, TIMEOUT);

  it("downloads a file and reports where it landed", async () => {
    await page.enableDownloads(dir);
    await page.goto(dataUrl(PAGE));
    const snap = await page.snapshot();
    const link = snap.elements.find((e) => e.name === "Download report");
    if (!link) throw new Error(`no download link in snapshot:\n${snap.text}`);

    await page.click(link.ref);
    const dl = await page.waitForDownload({ timeout: 15_000 });

    expect(dl.filename).toBe("report.txt");
    expect(dl.path).toBe(join(dir, "report.txt"));
    // the whole point: the file is actually on disk with the right bytes
    expect(existsSync(dl.path)).toBe(true);
    expect(readFileSync(dl.path, "utf8")).toBe("hello from veil");
  }, TIMEOUT);

  it("times out with a clear message when no download starts", async () => {
    await page.enableDownloads(dir);
    await page.goto(dataUrl("<p>nothing to download</p>"));
    let msg = "";
    try {
      await page.waitForDownload({ timeout: 800 });
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg).toMatch(/no download completed within 800ms/);
  }, TIMEOUT);
});
