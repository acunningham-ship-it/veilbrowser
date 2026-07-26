/**
 * uploadFile must reach a file input inside an open shadow root.
 *
 * It resolved the input with CDP DOM.querySelector, which does not cross shadow
 * boundaries — so a file input owned by a web component (every design-system
 * "upload" control) reported "no element matching input[type=file]" while the
 * input was right there.
 *
 * Also pins the absolute-path precondition: DOM.setFileInputFiles silently
 * attaches nothing for a relative path, which is another quiet no-op.
 *
 * INTEGRATION test (real headless Chrome), skips under CI. data: URL, no network.
 * Run with: bun test tests/upload-shadow.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

const SHADOW_PAGE = `
  <div id=host></div>
  <script>
    const r = document.getElementById('host').attachShadow({mode:'open'});
    r.innerHTML = '<input id=f type="file">';
  </script>`;

describe.skipIf(!!process.env.CI)("uploadFile across shadow roots", () => {
  let browser: Browser;
  let page: Page;
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "veil-up-"));
    file = join(dir, "payload.txt");
    writeFileSync(file, "veil upload test");
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("attaches to a file input in the light DOM", async () => {
    await page.goto(dataUrl(`<input id=f type="file">`));
    await page.uploadFile([file]);
    expect(await page.evaluate("document.getElementById('f').files[0].name")).toBe("payload.txt");
  }, TIMEOUT);

  it("attaches to a file input inside an open shadow root", async () => {
    await page.goto(dataUrl(SHADOW_PAGE));
    await page.uploadFile([file]);
    const name = await page.evaluate<string>(
      "document.getElementById('host').shadowRoot.getElementById('f').files[0].name",
    );
    expect(name).toBe("payload.txt");
  }, TIMEOUT);

  it("rejects a relative path instead of silently attaching nothing", async () => {
    await page.goto(dataUrl(`<input id=f type="file">`));
    let msg = "";
    try {
      await page.uploadFile(["relative/payload.txt"]);
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg).toMatch(/absolute/i);
  }, TIMEOUT);

  it("says it searched shadow roots when nothing matches", async () => {
    await page.goto(dataUrl(`<p>no inputs here</p>`));
    let msg = "";
    try {
      await page.uploadFile([file]);
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg).toMatch(/shadow roots/i);
  }, TIMEOUT);
});
