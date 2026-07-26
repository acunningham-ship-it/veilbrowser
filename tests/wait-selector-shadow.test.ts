/**
 * waitForSelector must see inside open shadow roots.
 *
 * It polls document.querySelector, which does NOT cross shadow boundaries. So
 * waiting for anything a web component renders timed out after the full
 * timeout even though the element was present and visible — verified before the
 * fix: waitForSelector("#deep") failed while
 * host.shadowRoot.querySelector("#deep") returned the element.
 *
 * That is the worst shape for a wait: the agent burns its timeout and then
 * concludes the page never rendered, when the page rendered immediately.
 *
 * INTEGRATION test (real headless Chrome), skips under CI. data: URL, no network.
 * Run with: bun test tests/wait-selector-shadow.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

/** Content lands inside the shadow root after a tick, so the wait has to poll. */
const PAGE = `
  <div id=host></div>
  <script>
    const r = document.getElementById('host').attachShadow({mode:'open'});
    setTimeout(() => {
      r.innerHTML = '<button id=deep>Deep</button><div id=nested></div>';
      const d = r.getElementById('nested').attachShadow({mode:'open'});
      d.innerHTML = '<span id=deeper>deeper</span>';
    }, 150);
  </script>`;

describe.skipIf(!!process.env.CI)("waitForSelector across shadow roots", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("finds an element inside an open shadow root", async () => {
    await page.goto(dataUrl(PAGE));
    await page.waitForSelector("#deep", { timeout: 5000 });
  }, TIMEOUT);

  it("finds an element nested two shadow roots deep", async () => {
    await page.goto(dataUrl(PAGE));
    await page.waitForSelector("#deeper", { timeout: 5000 });
  }, TIMEOUT);

  it("honours visible:true for a shadow element", async () => {
    await page.goto(dataUrl(PAGE));
    await page.waitForSelector("#deep", { visible: true, timeout: 5000 });
  }, TIMEOUT);

  it("still finds ordinary light-DOM elements", async () => {
    await page.goto(dataUrl(`<p id=plain>hi</p>`));
    await page.waitForSelector("#plain", { timeout: 5000 });
  }, TIMEOUT);

  it("still times out with a clear message when nothing matches anywhere", async () => {
    await page.goto(dataUrl(PAGE));
    let msg = "";
    try {
      await page.waitForSelector("#nope", { timeout: 700 });
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg).toMatch(/"#nope" not found within 700ms/);
  }, TIMEOUT);
});
