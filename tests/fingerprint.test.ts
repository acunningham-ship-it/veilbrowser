/**
 * Fingerprint coherence — an INTEGRATION test (real headless Chrome), skipped in
 * CI. It applies a full Windows-Chrome profile and asserts that EVERY page-
 * observable value agrees with the UA: navigator.*, the high-entropy client
 * hints, screen geometry, and devicePixelRatio. Coherence is the product here —
 * a single field disagreeing with the UA is itself a detection signal.
 *
 * The page is served from 127.0.0.1 (a secure context) so navigator.userAgentData
 * is populated — it is undefined on data: URLs. No external network.
 *
 * Run with: bun test tests/fingerprint.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { Browser } from "../src/index.js";
import { chromeMajor, chromeFullVersion, clientHintPlatform, type Fingerprint } from "../src/fingerprint.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;

// A realistic, internally-consistent Windows-11 / Chrome-131 desktop profile.
const WINDOWS: Fingerprint = {
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
  screen: { width: 2560, height: 1440, availWidth: 2560, availHeight: 1400, colorDepth: 24 },
  devicePixelRatio: 1,
  webglVendor: "Google Inc. (NVIDIA)",
  webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  timezone: "America/New_York",
  locale: "en-US",
  seed: 12345,
};

describe.skipIf(!!process.env.CI)("fingerprint coherence (Windows profile)", () => {
  let browser: Browser;
  let page: Page;
  let server: Server;

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response("<!doctype html><meta charset=utf-8><title>fp</title><h1>ctx</h1>", {
          headers: { "content-type": "text/html" },
        }),
    });
    // blockPrivateNetwork:false — this is a fingerprint test, and we deliberately
    // navigate to a loopback secure context.
    browser = await Browser.launch({ headless: true, fingerprint: WINDOWS, blockPrivateNetwork: false });
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  it("navigator core values match the profile", async () => {
    expect(await page.evaluate("navigator.userAgent")).toBe(WINDOWS.userAgent);
    expect(await page.evaluate("navigator.platform")).toBe(WINDOWS.platform);
    expect(await page.evaluate("navigator.hardwareConcurrency")).toBe(WINDOWS.hardwareConcurrency);
    expect(await page.evaluate("navigator.deviceMemory")).toBe(WINDOWS.deviceMemory);
    expect(await page.evaluate("JSON.stringify(navigator.languages)")).toBe(JSON.stringify(WINDOWS.languages));
    // navigator.language is the first list entry, clean (no q-weight leak).
    expect(await page.evaluate("navigator.language")).toBe(WINDOWS.languages[0]);
  }, TIMEOUT);

  it("high-entropy client hints agree with the UA", async () => {
    const he = JSON.parse(
      await page.evaluate<string>(
        `navigator.userAgentData.getHighEntropyValues(['platform','platformVersion','architecture','bitness','model','uaFullVersion','fullVersionList']).then(v => JSON.stringify(v))`,
      ),
    );
    expect(he.platform).toBe(clientHintPlatform(WINDOWS)); // "Windows"
    expect(he.platform).toBe("Windows");
    expect(he.platformVersion).toBe(WINDOWS.platformVersion);
    expect(he.architecture).toBe(WINDOWS.architecture);
    expect(he.bitness).toBe(WINDOWS.bitness);
    expect(he.model).toBe(WINDOWS.model);
    // The client-hint full version must equal the Chrome version in the UA string.
    expect(he.uaFullVersion).toBe(chromeFullVersion(WINDOWS.userAgent));
    // …and the significant-version brands must carry the SAME major as the UA.
    const major = chromeMajor(WINDOWS.userAgent);
    const brands = await page.evaluate<Array<{ brand: string; version: string }>>(
      "JSON.parse(JSON.stringify(navigator.userAgentData.brands))",
    );
    const chrome = brands.find((b) => b.brand === "Google Chrome");
    expect(chrome?.version).toBe(major);
    expect(he.fullVersionList.find((b: any) => b.brand === "Google Chrome")?.version).toBe(
      chromeFullVersion(WINDOWS.userAgent),
    );
  }, TIMEOUT);

  it("uaData.platform, uaData.mobile and navigator.platform are mutually consistent", async () => {
    expect(await page.evaluate("navigator.userAgentData.platform")).toBe("Windows");
    expect(await page.evaluate("navigator.userAgentData.mobile")).toBe(WINDOWS.mobile);
    // A "Windows" client-hint platform must pair with a Win* navigator.platform.
    const navPlatform = await page.evaluate<string>("navigator.platform");
    expect(navPlatform.startsWith("Win")).toBe(true);
  }, TIMEOUT);

  it("screen geometry and devicePixelRatio match the profile", async () => {
    expect(await page.evaluate("screen.width")).toBe(WINDOWS.screen.width);
    expect(await page.evaluate("screen.height")).toBe(WINDOWS.screen.height);
    expect(await page.evaluate("screen.availWidth")).toBe(WINDOWS.screen.availWidth);
    expect(await page.evaluate("screen.availHeight")).toBe(WINDOWS.screen.availHeight);
    expect(await page.evaluate("screen.colorDepth")).toBe(WINDOWS.screen.colorDepth);
    expect(await page.evaluate("screen.pixelDepth")).toBe(WINDOWS.screen.colorDepth);
    expect(await page.evaluate("window.devicePixelRatio")).toBe(WINDOWS.devicePixelRatio);
    // avail must never exceed the physical screen.
    expect(WINDOWS.screen.availHeight).toBeLessThanOrEqual(WINDOWS.screen.height);
  }, TIMEOUT);

  it("the injected getters are not detectable (native toString, inherited, no own-property tell)", async () => {
    const audit = JSON.parse(
      await page.evaluate<string>(`(() => {
        const hc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency');
        const lang = Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages');
        const avail = Object.getOwnPropertyDescriptor(Screen.prototype, 'availHeight');
        return JSON.stringify({
          hcSrc: hc.get.toString(),
          hcName: hc.get.name,
          langSrc: lang.get.toString(),
          availSrc: avail.get.toString(),
          hcOwn: Object.prototype.hasOwnProperty.call(navigator, 'hardwareConcurrency'),
          langOwn: Object.prototype.hasOwnProperty.call(navigator, 'languages'),
          availOwn: Object.prototype.hasOwnProperty.call(screen, 'availHeight'),
          // over-masking guard: a real user function must still show its source
          userFn: (function demo(){ return 42; }).toString(),
          // the toString proxy must hide itself
          selfSrc: Function.prototype.toString.toString(),
          // a genuine native fn must still read native
          nativeFn: Array.prototype.push.toString(),
        });
      })()`),
    );
    expect(audit.hcSrc).toBe("function get hardwareConcurrency() { [native code] }");
    expect(audit.hcName).toBe("get hardwareConcurrency");
    expect(audit.langSrc).toBe("function get languages() { [native code] }");
    expect(audit.availSrc).toBe("function get availHeight() { [native code] }");
    expect(audit.hcOwn).toBe(false);
    expect(audit.langOwn).toBe(false);
    expect(audit.availOwn).toBe(false);
    expect(audit.userFn).toBe("function demo(){ return 42; }"); // NOT over-masked
    expect(audit.selfSrc).toBe("function () { [native code] }");
    expect(audit.nativeFn).toBe("function push() { [native code] }");
  }, TIMEOUT);
});
