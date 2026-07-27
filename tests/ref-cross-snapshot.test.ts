/**
 * A ref must mean the SAME element on every snapshot, or fail loudly.
 *
 * `tests/ref-staleness.test.ts` covers the mid-action case: one snapshot, the page
 * reflows, click(ref) still lands right because freshCenter() re-reads the live box.
 * This file covers the cross-snapshot case — the critique u/Ok-Regret-2934 made on
 * r/AI_Agents: "css selectors break on every redeploy, but numbers break on every
 * dom change."
 *
 * WHAT WAS MEASURED (2026-07-27), before the fix, with refs assigned 1..N per snapshot:
 *
 *   removal of an earlier element -> every later ref shifted down one
 *   `document.body.prepend`       -> every existing ref shifted UP one
 *   `appendChild` into a div above -> nothing shifted; the newcomer snapshotted LAST
 *
 * The last two are the same logical mutation — insert an interactive element above —
 * with opposite results. So "has the DOM changed in a way that renumbers?" was not a
 * question a caller could answer, which is what made the critique land.
 *
 * The failure was silent in the worst case: a stale ref still IN RANGE resolved to a
 * real, live, DIFFERENT node. click() dispatched, nothing threw, the wrong button was
 * pressed. (Out of range threw, which was luck, not design.)
 *
 * FIX: a ref is now an identity, not a position — `refByNode` memoises
 * backendNodeId -> ref for the life of the document, so a number is never reused for
 * a different element. A stale ref is therefore either still correct, or loudly gone.
 *
 * INTEGRATION test (real headless Chrome), skips under CI. data: URL, no network.
 * Run with: DISPLAY=:98 bun test tests/ref-cross-snapshot.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

const PAGE = `
  <button id=a>Alpha</button>
  <button id=b onclick="document.getElementById('hit').textContent='BRAVO'">Bravo</button>
  <button id=c onclick="document.getElementById('hit').textContent='CHARLIE'">Charlie</button>
  <div id=hit>none</div>`;

describe.skipIf(!!process.env.CI)("refs across snapshots", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  const refs = async () => (await page.snapshot()).elements.map((e) => [e.ref, e.name] as const);
  const refOf = async (name: string) => {
    const f = (await refs()).find(([, n]) => n === name);
    if (!f) throw new Error(`no "${name}" in snapshot`);
    return f[0];
  };
  const hit = () => page.evaluate<string>("document.getElementById('hit').textContent");

  /** THE CONTRACT. Written before the fix existed and RED against the old code:
   *  it clicked Charlie while the caller meant Bravo, and returned success. */
  it("never silently actuates a different element when handed a stale ref", async () => {
    await page.goto(dataUrl(PAGE));
    const bravo = await refOf("Bravo");

    await page.evaluate("document.getElementById('a').remove()"); // a banner is dismissed
    await page.snapshot(); // agent re-snapshots; under the old code Bravo->1, Charlie->2

    let threw = "";
    try {
      await page.click(bravo);
    } catch (e: any) {
      threw = String(e?.message ?? e);
    }
    const landed = await hit();

    if (threw) {
      expect(landed).toBe("none"); // refusing to act is acceptable; acting wrongly is not
      return;
    }
    expect(landed).not.toBe("CHARLIE");
    expect(landed).toBe("BRAVO");
  }, TIMEOUT);

  it("keeps a survivor's ref when an element above it is REMOVED", async () => {
    await page.goto(dataUrl(PAGE));
    const [bravo, charlie] = [await refOf("Bravo"), await refOf("Charlie")];
    await page.evaluate("document.getElementById('a').remove()");
    expect(await refOf("Bravo")).toBe(bravo);
    expect(await refOf("Charlie")).toBe(charlie);
  }, TIMEOUT);

  it("keeps existing refs when an element is INSERTED above, and numbers the newcomer freshly", async () => {
    await page.goto(dataUrl(PAGE));
    const before = await refs();
    await page.evaluate(
      "const n=document.createElement('button');n.textContent='Newcomer';document.body.prepend(n)",
    );
    const after = await refs();

    for (const [ref, name] of before) {
      expect(after.find(([, n]) => n === name)?.[0]).toBe(ref); // nothing renumbered
    }
    const newcomer = after.find(([, n]) => n === "Newcomer")!;
    expect(newcomer[0]).toBeGreaterThan(Math.max(...before.map(([r]) => r)));
    // Listed FIRST (it is first in the tree) while holding the HIGHEST number —
    // the visible sign that a ref is an identity and not a position.
    expect(after[0][1]).toBe("Newcomer");
  }, TIMEOUT);

  it("a removed element's ref stops resolving, loudly", async () => {
    await page.goto(dataUrl(PAGE));
    const alpha = await refOf("Alpha");
    await page.evaluate("document.getElementById('a').remove()");
    await page.snapshot();
    let msg = "";
    try {
      await page.click(alpha);
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg).toMatch(/no element with ref/i);
    expect(await hit()).toBe("none");
  }, TIMEOUT);

  it("resets numbering on navigation, so refs do not grow without bound", async () => {
    await page.goto(dataUrl(PAGE));
    await page.evaluate(
      "const n=document.createElement('button');n.textContent='Newcomer';document.body.prepend(n)",
    );
    await page.snapshot(); // allocates a 4th number
    await page.goto(dataUrl(PAGE)); // new document — old node ids are meaningless
    expect((await refs()).map(([r]) => r)).toEqual([1, 2, 3]);
  }, TIMEOUT);
});
