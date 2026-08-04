/**
 * doubleClick / rightClick / scroll(ctrl) / drag via-waypoints — the primitives
 * added for infinite-canvas editors (n8n's workflow canvas, GHL's page/workflow
 * builder). A plain click() only selects/focuses a canvas node; these are the
 * real interactions those UIs listen for: dblclick to open a config panel,
 * contextmenu to open the node menu, Ctrl+wheel to zoom, and a multi-waypoint
 * drag so a long drag toward the canvas edge dwells long enough to be seen as
 * a drag rather than a teleport.
 *
 * INTEGRATION test (real headless Chrome), skips under CI. data: URL, no network.
 * Run with: bun test tests/canvas-interaction.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const dataUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

const PAGE = `
  <button id=node style="position:absolute;top:100px;left:100px;width:120px;height:40px;background:#eee"
       ondblclick="document.getElementById('dbl').textContent='OPENED'"
       oncontextmenu="event.preventDefault();document.getElementById('ctx').textContent='MENU'">Node</button>
  <div id=dbl>closed</div>
  <div id=ctx>none</div>
  <div id=wheel>0</div>
  <div id=path></div>
  <script>
    window.addEventListener('wheel', (e) => {
      document.getElementById('wheel').textContent = e.ctrlKey ? 'zoom:' + e.deltaY : 'pan:' + e.deltaY;
    }, { passive: true });
    let moves = 0;
    let mouseDown = false;
    document.addEventListener('mousedown', () => mouseDown = true);
    document.addEventListener('mouseup', () => mouseDown = false);
    document.addEventListener('mousemove', () => {
      if (mouseDown) { moves++; document.getElementById('path').textContent = String(moves); }
    });
  </script>`;

describe.skipIf(!!process.env.CI)("canvas interaction primitives", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(dataUrl(PAGE), { waitUntil: "load" });
  }, TIMEOUT);
  afterAll(async () => {
    await browser?.close();
  });

  const nodeRef = async () => {
    const snap = await page.snapshot();
    const el = snap.elements.find((e) => e.name === "Node");
    if (!el) throw new Error("node not found in snapshot");
    return el.ref;
  };

  it(
    "doubleClick(ref) fires a real dblclick",
    async () => {
      const ref = await nodeRef();
      await page.doubleClick(ref);
      expect(await page.evaluate("document.getElementById('dbl').textContent")).toBe("OPENED");
    },
    TIMEOUT,
  );

  it(
    "rightClick(ref) fires a real contextmenu",
    async () => {
      const ref = await nodeRef();
      await page.rightClick(ref);
      expect(await page.evaluate("document.getElementById('ctx').textContent")).toBe("MENU");
    },
    TIMEOUT,
  );

  it(
    "scroll(ctrl:true) sets ctrlKey on the wheel event; plain scroll doesn't",
    async () => {
      await page.scroll(0, -100, { ctrl: true });
      expect(await page.evaluate("document.getElementById('wheel').textContent")).toBe("zoom:-100");
      await page.scroll(0, 50);
      expect(await page.evaluate("document.getElementById('wheel').textContent")).toBe("pan:50");
    },
    TIMEOUT,
  );

  it(
    "dragAtPath visits every waypoint with the button held (not a straight 2-point drag)",
    async () => {
      await page.dragAtPath([
        { x: 160, y: 120 },
        { x: 300, y: 200 },
        { x: 450, y: 300 },
        { x: 600, y: 400 },
      ]);
      const moves = Number(await page.evaluate("document.getElementById('path').textContent"));
      // straight dragCore would produce ~1 mousemove sample over the node; routing
      // through 3 intermediate waypoints must produce meaningfully more than that.
      expect(moves).toBeGreaterThan(1);
    },
    TIMEOUT,
  );
});
