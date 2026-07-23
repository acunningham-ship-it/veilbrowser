/**
 * select(ref, value) — drive a native <select> by snapshot ref, firing
 * input+change. INTEGRATION test (real headless Chrome), skips under CI. The
 * page is a data: URL — no network.
 *
 * Run with: bun test tests/select.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

/** Capture a rejection message via try/catch. bun's `expect().rejects.toThrow`
 *  matcher races the promise against browser teardown here and misreports the
 *  error; awaiting directly (the way real callers and the MCP layer do) is
 *  exact. */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  throw new Error("expected the promise to reject, but it resolved");
}

const PAGE = `
  <select aria-label="pick" id=s>
    <option value=a>Apple</option>
    <option value=b>Banana</option>
    <option value=c>Cherry</option>
  </select>
  <button id=btn>go</button>
  <div id=log></div>
  <script>
    document.getElementById('s').addEventListener('change', e => {
      document.getElementById('log').textContent = 'changed:' + e.target.value;
    });
  </script>`;

describe.skipIf(!!process.env.CI)("select", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  const selectRef = async () => {
    const snap = await page.snapshot();
    const el = snap.elements.find((e) => e.name === "pick") ?? snap.elements.find((e) => e.role === "combobox" || e.role === "listbox");
    if (!el) throw new Error(`no <select> in snapshot: ${snap.text}`);
    return el.ref;
  };

  it("sets by option value and fires change", async () => {
    await page.goto(dataUrl(PAGE));
    const ref = await selectRef();
    const result = await page.select(ref, "b");
    expect(result).toBe("b");
    expect(await page.evaluate("document.getElementById('s').value")).toBe("b");
    expect(await page.evaluate("document.getElementById('log').textContent")).toBe("changed:b");
  }, TIMEOUT);

  it("matches by visible option text too", async () => {
    await page.goto(dataUrl(PAGE));
    const ref = await selectRef();
    expect(await page.select(ref, "Cherry")).toBe("c");
  }, TIMEOUT);

  it("throws when the ref is not a <select>", async () => {
    await page.goto(dataUrl(PAGE));
    const snap = await page.snapshot();
    const btn = snap.elements.find((e) => e.role === "button");
    expect(btn).toBeTruthy();
    expect(await rejectionMessage(page.select(btn!.ref, "x"))).toMatch(/not a <select>/);
  }, TIMEOUT);
});
