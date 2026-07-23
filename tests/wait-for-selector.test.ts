/**
 * waitForSelector() — the selector-shaped convenience over waitFor().
 * INTEGRATION test (real headless Chrome), so it skips under CI. Uses a data:
 * URL that reveals / mutates an element on a timer — no network needed.
 *
 * Run with: bun test tests/wait-for-selector.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

describe.skipIf(!!process.env.CI)("waitForSelector", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("resolves once a late element appears", async () => {
    await page.goto(dataUrl(
      `<div id=root></div><script>
        setTimeout(() => { const d = document.createElement('div'); d.className = 'late'; d.textContent = 'hi'; document.getElementById('root').appendChild(d); }, 300);
      </script>`,
    ));
    await page.waitForSelector(".late", { timeout: 5000 });
    expect(await page.evaluate("!!document.querySelector('.late')")).toBe(true);
  }, TIMEOUT);

  it("throws a selector-named error on timeout", async () => {
    await page.goto(dataUrl(`<h1>nothing here</h1>`));
    await expect(page.waitForSelector(".never", { timeout: 400 })).rejects.toThrow(/waitForSelector.*\.never/);
  }, TIMEOUT);

  it("visible:true waits past a display:none element until it is shown", async () => {
    await page.goto(dataUrl(
      `<div id=box class=target style="width:10px;height:10px;display:none"></div><script>
        setTimeout(() => { document.getElementById('box').style.display = 'block'; }, 1500);
      </script>`,
    ));
    // Hidden now (reveal is 1500ms out, past goto's settle): visible:true must NOT resolve yet.
    await expect(page.waitForSelector(".target", { visible: true, timeout: 300 })).rejects.toThrow(/waitForSelector/);
    // But it resolves once shown.
    await page.waitForSelector(".target", { visible: true, timeout: 5000 });
    expect(await page.evaluate("getComputedStyle(document.querySelector('.target')).display")).toBe("block");
  }, TIMEOUT);
});
