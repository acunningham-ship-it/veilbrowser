/**
 * End-to-end self-test. Runs headless so it works on a server with no display.
 *   bun run examples/selftest.ts
 *
 * Proves three things:
 *   1. We can drive real Chrome over our own raw-CDP runtime (no playwright).
 *   2. The stealth layer normalises the JS-observable automation tells.
 *   3. The agent tooling (AX-tree snapshot -> ref -> human click/type) works.
 */
import { Browser } from "../src/index.js";

const TEST_PAGE = `data:text/html,${encodeURIComponent(`
<!doctype html><meta charset=utf-8><title>Veil Selftest</title>
<body style="font:16px system-ui;padding:40px">
  <h1>login</h1>
  <input id=user placeholder="username" aria-label="username">
  <button id=go>Sign in</button>
  <div id=out></div>
  <script>
    document.getElementById('go').onclick = () => {
      document.getElementById('out').textContent =
        'submitted:' + document.getElementById('user').value;
    };
  </script>
</body>`)}`;

const ok = (c: boolean) => (c ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m");

const browser = await Browser.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(TEST_PAGE);

  // --- 1. Stealth fingerprint readout ---
  const fp = await page.evaluate(`(${(() => ({
    webdriver: (navigator as any).webdriver,
    hasChrome: !!(window as any).chrome,
    plugins: navigator.plugins.length,
    languages: navigator.languages.join(","),
    webglVendor: (() => {
      try {
        const gl = document.createElement("canvas").getContext("webgl") as WebGLRenderingContext;
        // UNMASKED_VENDOR_WEBGL (37445) only returns a value once the debug
        // extension is enabled — exactly what real fingerprinters do. Without it,
        // headless Chrome hands back null and makes a real GPU look absent.
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        return dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(37445);
      } catch {
        return "n/a";
      }
    })(),
    ua: navigator.userAgent,
  })).toString()})()`);

  console.log("\n=== stealth fingerprint ===");
  console.log(`${ok(fp.webdriver === undefined || fp.webdriver === false)} navigator.webdriver = ${fp.webdriver}`);
  console.log(`${ok(fp.hasChrome)} window.chrome present = ${fp.hasChrome}`);
  console.log(`${ok(fp.plugins > 0)} navigator.plugins.length = ${fp.plugins}`);
  console.log(`${ok(fp.languages.length > 0)} navigator.languages = ${fp.languages}`);
  console.log(`     webgl vendor = ${fp.webglVendor}`);
  console.log(`     userAgent = ${fp.ua}`);

  // --- 2. Agent tooling: snapshot -> act by ref ---
  console.log("\n=== AX-tree snapshot ===");
  const snap = await page.snapshot();
  console.log(snap.text || "(no interactive elements found)");

  const field = snap.elements.find((e) => e.role === "textbox" || e.role === "searchbox");
  const button = snap.elements.find((e) => e.role === "button");
  if (!field || !button) throw new Error("expected a textbox and a button in snapshot");

  await page.fill(field.ref, "veil-agent");
  await page.click(button.ref);
  await page.waitFor(`document.getElementById('out').textContent`);
  const out = await page.evaluate<string>(`document.getElementById('out').textContent`);

  console.log("\n=== interaction ===");
  console.log(`${ok(out === "submitted:veil-agent")} form result = ${JSON.stringify(out)}`);

  // --- 3. Screenshot path (vision-ready) ---
  const png = await page.screenshot();
  console.log(`${ok(png.length > 0)} screenshot bytes = ${png.length}`);

  console.log("\n\x1b[1mveil: end-to-end OK\x1b[0m\n");
} finally {
  await browser.close();
}
