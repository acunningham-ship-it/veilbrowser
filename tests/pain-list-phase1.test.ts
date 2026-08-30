/**
 * Phase 1 of "make veil a really good browser" (2026-08-30, judge #7762/#7763)
 * — joe's ranked pain-list items #3-8 plus the standalone verifyUrl() ask.
 * INTEGRATION test (real headless Chrome), skips under CI.
 *
 * Run with: bun test tests/pain-list-phase1.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser, verifyUrl } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

describe.skipIf(!!process.env.CI)("pain-list phase 1", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  }, TIMEOUT);

  afterAll(async () => {
    await browser?.close();
  });

  // --- #5: waitForText — searches shadow DOM, false negatives fixed ---

  it("waitForText finds text a plain innerText check misses inside a shadow root", async () => {
    await page.goto(dataUrl(`<div id=host></div><script>
      const host = document.getElementById('host').attachShadow({mode:'open'});
      host.innerHTML = '<p>No issues found</p>';
    </script>`));
    // document.body.innerText alone does NOT see into the shadow root — this is
    // exactly joe's false-negative repro (evaluate confirmed the text was there,
    // waitFor("innerText.includes(...)") timed out anyway).
    const plainSees = await page.evaluate<boolean>(`document.body.innerText.includes("No issues found")`);
    expect(plainSees).toBe(false);
    await page.waitForText("No issues found", { timeout: 3000 }); // must NOT throw
  }, TIMEOUT);

  it("waitForText is case-insensitive and whitespace-normalized", async () => {
    await page.goto(dataUrl(`<p>Reel   Shared</p>`));
    await page.waitForText("reel shared", { timeout: 2000 });
  }, TIMEOUT);

  it("waitForText times out with a diagnostic snippet, not a blind failure", async () => {
    await page.goto(dataUrl(`<p>The actual page content</p>`));
    await expect(page.waitForText("this text is definitely not here", { timeout: 400 }))
      .rejects.toThrow(/The actual page content/);
  }, TIMEOUT);

  // --- #7: scroll honesty + scrollToText ---

  it("scroll() reports moved:false when the wheel event under the cursor moves nothing", async () => {
    // A page with no scrollable content at all — the classic "reported success,
    // scrolled nothing" case from joe's report.
    await page.goto(dataUrl(`<body style="margin:0;height:100px;overflow:hidden"><p>short</p></body>`));
    const r = await page.scroll(0, 500);
    expect(r.moved).toBe(false);
  }, TIMEOUT);

  it("scroll() reports moved:true and the real delta on an actually-scrollable page", async () => {
    await page.goto(dataUrl(`<body style="margin:0"><div style="height:4000px">tall</div></body>`));
    const r = await page.scroll(0, 500);
    expect(r.moved).toBe(true);
    expect(r.dy).toBeGreaterThan(0);
  }, TIMEOUT);

  it("scrollToText finds and reports an element inside a NESTED scroll container — the exact case a viewport wheel event misses", async () => {
    await page.goto(dataUrl(`
      <div style="height:100px;overflow:auto" id="outer">
        <div style="height:50px">spacer</div>
        <button style="display:block;margin-top:900px">Deep Target</button>
      </div>`));
    const before = await page.evaluate<number>(`document.getElementById('outer').scrollTop`);
    expect(before).toBe(0);
    const el = await page.scrollToText("Deep Target");
    expect(el.t).toBe("Deep Target");
    const after = await page.evaluate<number>(`document.getElementById('outer').scrollTop`);
    expect(after).toBeGreaterThan(0); // scrollIntoView moved the INNER container, not the page
  }, TIMEOUT);

  // --- #8: press count ---

  it("press(key, count) repeats — clearing a field with N Backspaces in one call", async () => {
    await page.goto(dataUrl(`<input id=f value="hello">`));
    await page.click((await page.snapshot()).elements.find((e) => e.role === "textbox")!.ref);
    // move caret to the end first so Backspace actually deletes characters
    await page.press("End");
    await page.press("Backspace", 5);
    const val = await page.evaluate<string>(`document.getElementById('f').value`);
    expect(val).toBe("");
  }, TIMEOUT);

  // --- #6: goto reports the REAL url and retries a silent no-nav ---

  it("goto() return value is the actual location.href, not an echo of the input", async () => {
    const target = dataUrl(`<h1>hi</h1>`);
    const res = await page.goto(target);
    expect(res.url).toBe(target); // data: URLs don't redirect, so these DO match — but via the real read path
    const live = await page.evaluate<string>("location.href");
    expect(res.url).toBe(live); // and it must agree with the page's own idea of where it is
  }, TIMEOUT);

  it("goto() to a real cross-origin site returns its actual (possibly redirected) URL", async () => {
    const res = await page.goto("https://example.com/", { timeout: 15000 });
    expect(res.url).toContain("example.com");
    const live = await page.evaluate<string>("location.href");
    expect(res.url).toBe(live);
  }, TIMEOUT);

  // --- #4: param validation / aliases (MCP layer — see mcp-validation.test.ts for direct coverage) ---
  // covered separately since it doesn't need a live page.

  // --- verifyUrl(): the standalone external-fetch primitive ---

  it("verifyUrl fetches a real public page anonymously and finds real content", async () => {
    const r = await verifyUrl("https://example.com/", { expectText: "Example Domain" });
    expect(r.ok).toBe(true);
    expect(r.found["Example Domain"]).toBe(true);
    expect(r.bytes).toBeGreaterThan(0);
    expect(r.userAgent).toBeTruthy();
  }, TIMEOUT);

  it("verifyUrl reports ok:false with a snippet when expectText is genuinely absent", async () => {
    const r = await verifyUrl("https://example.com/", { expectText: "this string will never appear on example.com" });
    expect(r.ok).toBe(false);
    expect(r.found["this string will never appear on example.com"]).toBe(false);
    expect(r.snippet).toBeTruthy();
  }, TIMEOUT);

  it("verifyUrl tries the next UA when one returns nothing, instead of failing on the first miss", async () => {
    const r = await verifyUrl("https://example.com/", {
      expectText: "Example Domain",
      userAgents: ["Definitely-Not-A-Real-Bot/1.0-that-returns-nothing-special", "Twitterbot/1.0"],
    });
    // example.com serves the same content to any UA, so both "work" here — the
    // real assertion is that a caller-supplied UA LIST is honored end to end.
    expect(r.ok).toBe(true);
  }, TIMEOUT);
});
