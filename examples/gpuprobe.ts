/**
 * Find Chrome flags that yield REAL hardware WebGL on this AMD APU.
 *   VEIL_FLAGS="--use-gl=egl" VEIL_HEADFUL=1 xvfb-run -a bun run examples/gpuprobe.ts
 * WebGL mask is off by default, so we see the genuine renderer string.
 */
import { Browser } from "../src/index.js";

const flags = (process.env.VEIL_FLAGS ?? "").split(" ").filter(Boolean);
const browser = await Browser.launch({
  headless: process.env.VEIL_HEADFUL !== "1",
  gpu: process.env.VEIL_GPU as any,
  extraArgs: flags,
});
try {
  const p = await browser.newPage();
  await p.goto("data:text/html,<canvas></canvas>");
  const r = await p.evaluate<any>(`(() => {
    const gl = document.createElement('canvas').getContext('webgl') || document.createElement('canvas').getContext('experimental-webgl');
    if (!gl) return { ctx: false };
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return { ctx: true,
      vendor: gl.getParameter(d ? d.UNMASKED_VENDOR_WEBGL : 0x1F00),
      renderer: gl.getParameter(d ? d.UNMASKED_RENDERER_WEBGL : 0x1F01) };
  })()`);
  console.log(`flags=[${flags.join(" ")}] ->`, JSON.stringify(r));
} finally {
  await browser.close();
}
