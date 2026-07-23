/**
 * Fingerprint WebGL + canvas + audio noise — INTEGRATION test (real headless
 * Chrome), skipped in CI. Asserts the three properties that matter:
 *   1. the WebGL vendor/renderer read back as the profile's values;
 *   2. canvas + audio noise is DETERMINISTIC per seed — identical across repeated
 *      reads (a per-call random would itself be a detectable tell) yet different
 *      across seeds, so a profile has its own stable canvas/audio fingerprint;
 *   3. none of the overrides throw or are toString-detectable (they read back as
 *      native code).
 *
 * Two pages of ONE browser carry two different seeds (applied before their first
 * navigation), which is how the cross-seed difference is checked.
 *
 * Run with: bun test tests/fingerprint-noise.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Browser } from "../src/index.js";
import type { Fingerprint } from "../src/fingerprint.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;

const BASE: Omit<Fingerprint, "seed"> = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36",
  platform: "Win32",
  platformVersion: "15.0.0",
  architecture: "x86",
  bitness: "64",
  model: "",
  mobile: false,
  hardwareConcurrency: 16,
  deviceMemory: 8,
  languages: ["en-US", "en"],
  screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24 },
  devicePixelRatio: 1,
  webglVendor: "Google Inc. (NVIDIA)",
  webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  timezone: "America/New_York",
  locale: "en-US",
};

// Draws a canvas + renders an audio buffer, returns the two hashes twice each
// (to prove stability) plus the WebGL vendor/renderer and a toString audit.
const PROBE = `(async () => {
  const draw = () => {
    const c = document.createElement('canvas'); c.width = 220; c.height = 40;
    const x = c.getContext('2d');
    x.textBaseline = 'top'; x.font = '16px Arial';
    x.fillStyle = '#f60'; x.fillRect(2, 2, 120, 20);
    x.fillStyle = '#069'; x.fillText('veil-fingerprint-\u{1F600}', 4, 4);
    return c;
  };
  const gl = document.createElement('canvas').getContext('webgl');
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
  const audioSum = async () => {
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 1000;
    const comp = ctx.createDynamicsCompressor();
    osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    let s = 0; for (let i = 4500; i < 5000; i++) s += Math.abs(d[i]);
    return s;
  };
  const cc = draw(); const g = cc.getContext('2d');
  return JSON.stringify({
    webglVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'n/a',
    webglRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a',
    canvas1: draw().toDataURL(),
    canvas2: draw().toDataURL(),
    imageData1: Array.from(g.getImageData(0, 0, 8, 8).data).join(','),
    imageData2: Array.from(g.getImageData(0, 0, 8, 8).data).join(','),
    audio1: await audioSum(),
    audio2: await audioSum(),
    src: {
      getParameter: WebGLRenderingContext.prototype.getParameter.toString(),
      getParameter2: WebGL2RenderingContext.prototype.getParameter.toString(),
      toDataURL: HTMLCanvasElement.prototype.toDataURL.toString(),
      getImageData: CanvasRenderingContext2D.prototype.getImageData.toString(),
      getChannelData: AudioBuffer.prototype.getChannelData.toString(),
    },
    userFn: (function keep(){ return 7; }).toString(),
  });
})()`;

describe.skipIf(!!process.env.CI)("fingerprint WebGL + canvas + audio noise", () => {
  let browser: Browser;
  let a: any;
  let b: any;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true, blockPrivateNetwork: false });
    const pageA: Page = await browser.newPage();
    await pageA.applyFingerprint({ ...BASE, seed: 4242 });
    await pageA.goto("data:text/html,<h1>a</h1>");
    a = JSON.parse(await pageA.evaluate<string>(PROBE));

    const pageB: Page = await browser.newPage();
    await pageB.applyFingerprint({ ...BASE, seed: 9999 });
    await pageB.goto("data:text/html,<h1>b</h1>");
    b = JSON.parse(await pageB.evaluate<string>(PROBE));
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("WebGL vendor/renderer read back as the profile's values", () => {
    expect(a.webglVendor).toBe(BASE.webglVendor);
    expect(a.webglRenderer).toBe(BASE.webglRenderer);
  }, TIMEOUT);

  it("canvas noise is stable within a seed, different across seeds", () => {
    expect(a.canvas1).toBe(a.canvas2); // same seed, repeated read -> identical
    expect(a.imageData1).toBe(a.imageData2);
    expect(a.canvas1).not.toBe(b.canvas1); // different seed -> different hash
    // both are real, non-empty PNG data URLs
    expect(a.canvas1.startsWith("data:image/png;base64,")).toBe(true);
    expect(a.canvas1.length).toBeGreaterThan(100);
  }, TIMEOUT);

  it("audio noise is stable within a seed, different across seeds", () => {
    expect(a.audio1).toBe(a.audio2); // deterministic across reads
    expect(a.audio1).not.toBe(b.audio1); // differs by seed
    expect(a.audio1).toBeGreaterThan(0); // the render actually produced signal
  }, TIMEOUT);

  it("the overrides are not toString-detectable and don't over-mask", () => {
    expect(a.src.getParameter).toBe("function getParameter() { [native code] }");
    expect(a.src.getParameter2).toBe("function getParameter() { [native code] }");
    expect(a.src.toDataURL).toBe("function toDataURL() { [native code] }");
    expect(a.src.getImageData).toBe("function getImageData() { [native code] }");
    expect(a.src.getChannelData).toBe("function getChannelData() { [native code] }");
    // a genuine user function must still show its real source (no over-masking)
    expect(a.userFn).toBe("function keep(){ return 7; }");
  }, TIMEOUT);
});
