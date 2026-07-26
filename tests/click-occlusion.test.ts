/**
 * click() must notice when something is covering the target.
 *
 * click() dispatches a real mouse event at the element's centre. That is the
 * right way to look human, but it means the click goes to whatever is TOPMOST
 * at that point — and on a real page that is very often a cookie banner, a
 * modal backdrop, a sticky header, or a full-page "loading" veil that hasn't
 * torn down yet.
 *
 * The overlay receives the click. The target never fires. Nothing throws.
 *
 * This is the same silent-wrong-outcome family as the stale-ref and blind-fill
 * bugs: the agent is told it clicked, and no later check can tell it otherwise.
 *
 * INTEGRATION test (real headless Chrome), skips under CI. data: URL, no network.
 * Run with: bun test tests/click-occlusion.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

/** A button, and a cookie-banner-shaped overlay that can be dropped over it. */
const PAGE = `
  <button id=target style="position:absolute;top:100px;left:100px;width:120px;height:40px"
          onclick="document.getElementById('hit').textContent='TARGET'">Accept terms</button>
  <div id=veil style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999"
       onclick="document.getElementById('hit').textContent='VEIL'"></div>
  <div id=hit>none</div>
  <script>
    function cover(){ document.getElementById('veil').style.display = 'block'; }
  </script>`;

describe.skipIf(!!process.env.CI)("click occlusion", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  const targetRef = async () => {
    const snap = await page.snapshot();
    const el = snap.elements.find((e) => e.name === "Accept terms");
    if (!el) throw new Error(`no target in snapshot:\n${snap.text}`);
    return el.ref;
  };

  it("clicks normally when nothing is in the way", async () => {
    await page.goto(dataUrl(PAGE));
    const ref = await targetRef();
    await page.click(ref);
    expect(await page.evaluate("document.getElementById('hit').textContent")).toBe("TARGET");
  }, TIMEOUT);

  it("throws, naming the covering element, instead of letting the overlay eat the click", async () => {
    await page.goto(dataUrl(PAGE));
    const ref = await targetRef();
    await page.evaluate("cover()");

    let msg = "";
    try {
      await page.click(ref);
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }

    expect(msg).toMatch(/cover|obscur|intercept|overlay/i);
    // and the overlay must NOT have been clicked on the agent's behalf
    expect(await page.evaluate("document.getElementById('hit').textContent")).toBe("none");
  }, TIMEOUT);

  it("still works for an element whose own child sits at the centre point", async () => {
    // A button wrapping a <span> is the common shape; elementFromPoint returns
    // the span, which is a descendant and must NOT count as occlusion.
    await page.goto(
      dataUrl(`<button id=b onclick="document.getElementById('h').textContent='OK'">
                 <span style="pointer-events:auto">Save changes</span></button>
               <div id=h>none</div>`),
    );
    const snap = await page.snapshot();
    const el = snap.elements.find((e) => (e.name ?? "").includes("Save changes"));
    if (!el) throw new Error(`no button in snapshot:\n${snap.text}`);
    await page.click(el.ref);
    expect(await page.evaluate("document.getElementById('h').textContent")).toBe("OK");
  }, TIMEOUT);
});
