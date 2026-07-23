/**
 * text(ref) / attribute(ref, name) — read a single element by snapshot ref.
 * INTEGRATION test (real headless Chrome), skips under CI. data: URL, no network.
 *
 * Run with: bun test tests/text-attribute.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

const PAGE = `<a id=x href="/foo?q=1" data-kind="primary" aria-label="Go home">Hello <b>World</b></a>`;

describe.skipIf(!!process.env.CI)("text / attribute", () => {
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

  const linkRef = async () => {
    const snap = await page.snapshot();
    const el = snap.elements.find((e) => e.role === "link");
    if (!el) throw new Error(`no link in snapshot: ${snap.text}`);
    return el.ref;
  };

  it("reads the element's innerText", async () => {
    expect(await page.text(await linkRef())).toBe("Hello World");
  }, TIMEOUT);

  it("reads a raw attribute", async () => {
    const ref = await linkRef();
    // getAttribute returns the raw, un-resolved attribute string.
    expect(await page.attribute(ref, "href")).toBe("/foo?q=1");
    expect(await page.attribute(ref, "data-kind")).toBe("primary");
    expect(await page.attribute(ref, "aria-label")).toBe("Go home");
  }, TIMEOUT);

  it("returns null for a missing attribute", async () => {
    expect(await page.attribute(await linkRef(), "nope")).toBeNull();
  }, TIMEOUT);
});
