/**
 * Shadow DOM — can an agent see and drive elements inside a shadow root?
 *
 * Web components put their real controls inside a shadow root. If snapshot()
 * can't see them, everything built on custom elements is invisible to the
 * agent: Salesforce Lightning, most design-system buttons, half of any modern
 * admin panel.
 *
 * This test EXISTS TO ESTABLISH WHETHER IT ALREADY WORKS. The accessibility
 * tree is supposed to pierce shadow roots natively, so the honest thing is to
 * measure it rather than assume a fix is needed. If these pass unchanged, the
 * capability was already there and no code should be written.
 *
 * INTEGRATION test (real headless Chrome), skips under CI. data: URL, no network.
 * Run with: bun test tests/shadow-dom.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

/** An open shadow root containing a button and a text input, plus a nested
 *  shadow root one level deeper — the shape a real component library produces. */
const PAGE = `
  <div id=host></div>
  <div id=out>none</div>
  <script>
    const root = document.getElementById('host').attachShadow({mode:'open'});
    root.innerHTML =
      '<button id=sb>Shadow save</button>' +
      '<input id=si aria-label="shadow field">' +
      '<div id=inner></div>';
    root.getElementById('sb').addEventListener('click', () => {
      document.getElementById('out').textContent = 'SHADOW_CLICKED';
    });
    const deep = root.getElementById('inner').attachShadow({mode:'open'});
    deep.innerHTML = '<button id=db>Deep button</button>';
    deep.getElementById('db').addEventListener('click', () => {
      document.getElementById('out').textContent = 'DEEP_CLICKED';
    });
  </script>`;

describe.skipIf(!!process.env.CI)("shadow DOM", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("sees elements inside an open shadow root", async () => {
    await page.goto(dataUrl(PAGE));
    const snap = await page.snapshot();
    expect(snap.elements.map((e) => e.name)).toContain("Shadow save");
  }, TIMEOUT);

  it("clicks a button inside a shadow root", async () => {
    await page.goto(dataUrl(PAGE));
    const snap = await page.snapshot();
    const el = snap.elements.find((e) => e.name === "Shadow save");
    if (!el) throw new Error(`shadow button not in snapshot:\n${snap.text}`);
    await page.click(el.ref);
    expect(await page.evaluate("document.getElementById('out').textContent")).toBe("SHADOW_CLICKED");
  }, TIMEOUT);

  it("fills an input inside a shadow root", async () => {
    await page.goto(dataUrl(PAGE));
    const snap = await page.snapshot();
    const el = snap.elements.find((e) => e.name === "shadow field");
    if (!el) throw new Error(`shadow input not in snapshot:\n${snap.text}`);
    await page.fill(el.ref, "typed into shadow");
    const value = await page.evaluate<string>(
      "document.getElementById('host').shadowRoot.getElementById('si').value",
    );
    expect(value).toBe("typed into shadow");
  }, TIMEOUT);

  it("reaches a nested shadow root", async () => {
    await page.goto(dataUrl(PAGE));
    const snap = await page.snapshot();
    const el = snap.elements.find((e) => e.name === "Deep button");
    if (!el) throw new Error(`nested shadow button not in snapshot:\n${snap.text}`);
    await page.click(el.ref);
    expect(await page.evaluate("document.getElementById('out').textContent")).toBe("DEEP_CLICKED");
  }, TIMEOUT);
});
