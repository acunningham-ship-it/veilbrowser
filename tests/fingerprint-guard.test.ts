/**
 * Fingerprint capstone — INTEGRATION test (real headless Chrome), skipped in CI.
 * Two guards:
 *
 *  1. CONSISTENCY GUARD — a mini leak check. With a full profile applied, assert
 *     no field contradicts any other: UA major ↔ client-hint brand/full version,
 *     client-hint platform ↔ navigator.platform, language ↔ locale, timezone,
 *     screen bounds, and a WebGL renderer that is PLAUSIBLE for the claimed OS
 *     (a Windows profile must not leak an Apple/Metal renderer). Contradictions
 *     are exactly what a fingerprinter scores, so the guard is the product.
 *
 *  2. SANNYSOFT NO-REGRESSION — the baseline stealth signals a sannysoft-style
 *     scan reads (webdriver, window.chrome, plugins, languages, HeadlessChrome in
 *     UA, the notifications-permission contradiction) must STILL be clean with a
 *     profile active, and unchanged from a no-profile page — except the WebGL
 *     vendor/renderer, which the profile intentionally sets.
 *
 * The guarded page is served from 127.0.0.1 (secure context) so userAgentData is
 * available. No external network.
 *
 * Run with: bun test tests/fingerprint-guard.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { Browser, PRESETS } from "../src/index.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;
const WIN = PRESETS["windows-chrome"]!;

const SANNYSOFT = `(async () => {
  let permContradiction = false;
  try {
    const st = (await navigator.permissions.query({ name: 'notifications' })).state;
    permContradiction = (typeof Notification !== 'undefined' && Notification.permission === 'denied' && st === 'prompt');
  } catch (e) {}
  const gl = document.createElement('canvas').getContext('webgl');
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return JSON.stringify({
    webdriver: navigator.webdriver,
    hasChrome: !!window.chrome,
    plugins: navigator.plugins.length,
    languages: navigator.languages.length,
    headlessInUA: /HeadlessChrome/.test(navigator.userAgent),
    permContradiction,
    webglVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'n/a',
    webglRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a',
  });
})()`;

describe.skipIf(!!process.env.CI)("fingerprint capstone", () => {
  let browser: Browser;
  let guard: Page; // profile applied
  let plain: Page; // no profile (baseline)
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response("<!doctype html><meta charset=utf-8><title>guard</title><h1>ctx</h1>", {
          headers: { "content-type": "text/html" },
        }),
    });
    origin = `http://127.0.0.1:${server.port}`;
    // One browser (no launch-level fingerprint); apply the profile to ONE page.
    browser = await Browser.launch({ headless: true, blockPrivateNetwork: false });
    guard = await browser.newPage();
    await guard.applyFingerprint(WIN);
    await guard.goto(`${origin}/`);
    plain = await browser.newPage();
    await plain.goto(`${origin}/`);
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  it("no internal contradiction across the whole profile", async () => {
    const a = JSON.parse(
      await guard.evaluate<string>(`(async () => {
        const uad = navigator.userAgentData;
        const he = await uad.getHighEntropyValues(['platform','platformVersion','architecture','uaFullVersion']);
        const gl = document.createElement('canvas').getContext('webgl');
        const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
        return JSON.stringify({
          ua: navigator.userAgent,
          uaMajor: (navigator.userAgent.match(/Chrome\\/(\\d+)/) || [])[1],
          brandMajor: (uad.brands.find(b => b.brand === 'Google Chrome') || {}).version,
          heUaFullVersion: he.uaFullVersion,
          chPlatform: uad.platform,
          hePlatform: he.platform,
          navPlatform: navigator.platform,
          mobile: uad.mobile,
          language: navigator.language,
          languages: navigator.languages,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          locale: Intl.DateTimeFormat().resolvedOptions().locale,
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemory: navigator.deviceMemory,
          screenW: screen.width, screenH: screen.height,
          availW: screen.availWidth, availH: screen.availHeight,
          colorDepth: screen.colorDepth,
          dpr: window.devicePixelRatio,
          outerW: window.outerWidth,
          webglVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'n/a',
          webglRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a',
          getParamSrc: WebGLRenderingContext.prototype.getParameter.toString(),
          hcSrc: Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency').get.toString(),
        });
      })()`),
    );

    // UA anchors everything: major agrees across UA string, brands, full version.
    expect(a.ua).toBe(WIN.userAgent);
    expect(a.brandMajor).toBe(a.uaMajor);
    expect(a.heUaFullVersion.startsWith(a.uaMajor + ".")).toBe(true);
    // platform: client hint == high-entropy == a matching legacy navigator.platform.
    expect(a.chPlatform).toBe("Windows");
    expect(a.hePlatform).toBe("Windows");
    expect(a.navPlatform.startsWith("Win")).toBe(true);
    expect(a.mobile).toBe(false);
    // language ↔ locale ↔ timezone.
    expect(a.language).toBe(WIN.languages[0]);
    expect(a.language).toBe(WIN.locale);
    expect(a.languages).toEqual(WIN.languages);
    expect(a.locale).toBe(WIN.locale);
    expect(a.timezone).toBe(WIN.timezone);
    // hardware.
    expect(a.hardwareConcurrency).toBe(WIN.hardwareConcurrency);
    expect(a.deviceMemory).toBe(WIN.deviceMemory);
    // screen self-consistency: avail within physical, window within screen.
    expect(a.screenW).toBe(WIN.screen.width);
    expect(a.screenH).toBe(WIN.screen.height);
    expect(a.availW).toBeLessThanOrEqual(a.screenW);
    expect(a.availH).toBeLessThanOrEqual(a.screenH);
    expect(a.colorDepth).toBe(WIN.screen.colorDepth);
    expect(a.dpr).toBe(WIN.devicePixelRatio);
    expect(a.outerW).toBeLessThanOrEqual(a.screenW);
    // WebGL matches the profile AND is plausible for Windows (Direct3D, not Apple/Metal).
    expect(a.webglVendor).toBe(WIN.webglVendor);
    expect(a.webglRenderer).toBe(WIN.webglRenderer);
    expect(a.webglRenderer).toContain("Direct3D");
    expect(a.webglRenderer).not.toContain("Apple");
    expect(a.webglRenderer).not.toContain("Metal");
    // overrides read back native (no masking tell).
    expect(a.getParamSrc).toBe("function getParameter() { [native code] }");
    expect(a.hcSrc).toBe("function get hardwareConcurrency() { [native code] }");
  }, TIMEOUT);

  it("sannysoft-style stealth signals stay clean with a profile active", async () => {
    const g = JSON.parse(await guard.evaluate<string>(SANNYSOFT));
    const p = JSON.parse(await plain.evaluate<string>(SANNYSOFT));

    for (const s of [g, p]) {
      expect(s.webdriver === false || s.webdriver === undefined).toBe(true);
      expect(s.hasChrome).toBe(true);
      expect(s.plugins).toBeGreaterThan(0);
      expect(s.languages).toBeGreaterThan(0);
      expect(s.headlessInUA).toBe(false);
      expect(s.permContradiction).toBe(false);
    }
    // The profile changes NOTHING in the baseline stealth signals…
    expect(g.webdriver).toBe(p.webdriver);
    expect(g.hasChrome).toBe(p.hasChrome);
    expect(g.plugins).toBe(p.plugins);
    expect(g.languages).toBe(p.languages);
    // …except the WebGL vendor/renderer, which the profile intentionally sets.
    expect(g.webglVendor).toBe(WIN.webglVendor);
    expect(g.webglVendor).not.toBe(p.webglVendor); // p is the host's real GPU
  }, TIMEOUT);
});
