/**
 * Snapshot refs must survive a re-render.
 *
 * snapshot() records each element's viewport CENTRE at snapshot time. Any
 * re-render that moves an element — content inserted above it, a banner
 * appearing, a list growing, an accordion opening — leaves that centre pointing
 * at whatever now occupies the old coordinates. click(ref) then dispatches a
 * real mouse event at the stale point and silently hits the wrong element.
 *
 * That is the single most common failure mode for an agent driving a live page:
 * the click "succeeds", nothing throws, and the wrong thing happened.
 *
 * INTEGRATION test (real headless Chrome), skips under CI. data: URL, no network.
 * Run with: bun test tests/ref-staleness.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

/** A target button, plus a decoy sitting exactly where the target starts.
 *  Pressing "grow" inserts a tall block above both, pushing the real target
 *  down and sliding the decoy into the coordinates the snapshot recorded. */
const PAGE = `
  <div id=spacer></div>
  <button id=decoy onclick="document.getElementById('hit').textContent='DECOY'">Decoy</button>
  <button id=target onclick="document.getElementById('hit').textContent='TARGET'">Target</button>
  <div id=hit>none</div>
  <script>
    function grow() {
      document.getElementById('spacer').style.height = '300px';
    }
  </script>`;

describe.skipIf(!!process.env.CI)("snapshot ref staleness", () => {
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
    if (!el) throw new Error(`no "${name}" in snapshot:\n${snap.text}`);
    return el.ref;
  };

  it("clicks the right element after the page reflows under it", async () => {
    await page.goto(dataUrl(PAGE));
    const target = await refFor("Target");

    // Re-render: everything below the spacer shifts down 300px. The recorded
    // centre for Target now points at empty space (or, on a denser page, at
    // whatever slid into that spot).
    await page.evaluate("grow()");

    await page.click(target);

    // Before the fix this reads "none" (click landed on the gap) or "DECOY".
    expect(await page.evaluate("document.getElementById('hit').textContent")).toBe("TARGET");
  }, TIMEOUT);

  it("still clicks correctly when nothing moved", async () => {
    await page.goto(dataUrl(PAGE));
    const target = await refFor("Target");
    await page.click(target);
    expect(await page.evaluate("document.getElementById('hit').textContent")).toBe("TARGET");
  }, TIMEOUT);

  it("throws a useful error when the element is gone entirely", async () => {
    await page.goto(dataUrl(PAGE));
    const target = await refFor("Target");
    await page.evaluate("document.getElementById('target').remove()");
    let msg = "";
    try {
      await page.click(target);
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    // Must name the ref and say the node is gone — not a bare CDP error, and
    // above all not a silent success.
    expect(msg).toMatch(/ref \d+|detached|no longer|gone/i);
  }, TIMEOUT);
});
