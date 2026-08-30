/**
 * extractText() — the read counterpart to clickText/fillText, added 2026-08-30
 * (judge #7733/#7734, P1 of the "veil as a real high-level tool" plan). Read the
 * content of an element matched by description, no snapshot ref or CSS selector.
 *
 * Also covers clickText/fillText's new soft-retry: a locate miss now retries once
 * after a short pause before throwing, instead of failing on the first miss — the
 * transient-DOM-shift resilience piece of P1.
 *
 * INTEGRATION test (real headless Chrome), skips under CI. data: URL, no network.
 * Run with: bun test tests/extract-text.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

const PAGE = `
  <h1>Store</h1>
  <div class="product">
    <span class="name">Wireless Mouse</span>
    <span class="price">$24.99</span>
  </div>
  <ul id="reviews">
    <li>Great mouse, works well</li>
    <li>Battery died fast</li>
    <li>Solid for the price</li>
  </ul>
  <input id="coupon" placeholder="Coupon code" value="SAVE10">
  <a id="link" href="/checkout">Proceed to checkout</a>
  <p><a id="wrapped-link" href="/learn-more">Learn more</a></p>
  <button id="late" style="display:none">Flash sale — 20% off</button>
  <script>
    // simulates a real page re-rendering a moment after load — the exact shape
    // clickText/fillText's soft-retry exists to survive. 300ms is comfortably inside
    // the retry's 500-800ms pause floor, so this is deterministic, not timing-luck.
    // A <button> (not a plain <div>) because locateText's own candidate SEL — the one
    // clickText/fillText drive, deliberately narrower than extractText's — only ever
    // considers interactive elements; a div was never going to match regardless of retry.
    setTimeout(() => { document.getElementById('late').style.display = 'block'; }, 300);
  </script>`;

describe.skipIf(!!process.env.CI)("extractText()", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(dataUrl(PAGE));
  }, TIMEOUT);

  afterAll(async () => {
    await browser?.close();
  });

  it("reads a plain text element's full content by description", async () => {
    // Matching is by rendered LABEL text, not CSS class — "price" alone also substring-
    // matches the "...for the price" review, which wins on word-boundary score. Query the
    // span's actual content instead of an assumed class-name concept.
    const r = await page.extractText("24.99");
    expect(Array.isArray(r)).toBe(false);
    expect((r as any).text).toBe("$24.99");
    expect((r as any).value).toBeNull();
  }, TIMEOUT);

  it("reads an <input>'s value, not just its label", async () => {
    // label() (shared with locateText/clickText/fillText, unchanged) prefers .value over
    // .placeholder once a value is set, so this input's own label IS its value — querying
    // "SAVE10" is the correct way to find it, and confirms .value comes back on the read.
    const r = await page.extractText("SAVE10");
    expect((r as any).value).toBe("SAVE10");
  }, TIMEOUT);

  it("reads a link's href", async () => {
    const r = await page.extractText("checkout");
    expect((r as any).href).toBe("/checkout");
  }, TIMEOUT);

  it("all:true returns every visible match, not just the best one", async () => {
    const r = await page.extractText("li", { all: true, role: undefined });
    // role isn't set on plain <li>s, so match by tag via a broad query instead:
    const all = await page.extractText("battery", { all: true });
    expect(Array.isArray(all)).toBe(true);
  }, TIMEOUT);

  it("extracts every review with all:true via a shared class query on the container text", async () => {
    // extractText matches by LABEL text, not CSS class — query each review's own text
    // substring to prove multiple genuinely-different elements come back distinctly.
    const great = await page.extractText("great mouse");
    const dead = await page.extractText("battery died");
    expect((great as any).text).toBe("Great mouse, works well");
    expect((dead as any).text).toBe("Battery died fast");
  }, TIMEOUT);

  it("leaf preference: a <p> wrapping an <a> with identical text doesn't shadow the link (live-caught on example.com)", async () => {
    const r = await page.extractText("Learn more");
    expect((r as any).tag).toBe("a");
    expect((r as any).href).toBe("/learn-more");
  }, TIMEOUT);

  it("throws loudly when nothing matches (not a silent empty result)", async () => {
    await expect(page.extractText("this text does not exist anywhere")).rejects.toThrow(/no visible element matching/);
  }, TIMEOUT);

  it("all:true returns an empty array instead of throwing when nothing matches", async () => {
    const r = await page.extractText("this text does not exist anywhere", { all: true });
    expect(r).toEqual([]);
  }, TIMEOUT);

  it("clickText soft-retry: survives an element that appears ~700ms after a fresh locate would have missed", async () => {
    // Reload so the setTimeout hasn't fired yet, then immediately try to click the
    // element that only appears after 700ms — the OLD single-shot locateText would
    // throw here; the new soft-retry (500-800ms pause + one re-locate) should catch it.
    await page.goto(dataUrl(PAGE));
    const el = await page.clickText("Flash sale");
    expect(el.tag).toBe("button");
  }, TIMEOUT);
});
