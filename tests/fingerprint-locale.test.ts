/**
 * Fingerprint timezone / locale / geolocation coherence — INTEGRATION test (real
 * headless Chrome), skipped in CI. A US profile must resolve a US timezone, a US
 * locale, and (if given) US coordinates: a Windows/en-US UA reporting
 * Asia/Shanghai is a contradiction detectors score, so these must track the
 * profile, not the host.
 *
 * All three overrides are browser-level (Emulation.setTimezoneOverride /
 * setLocaleOverride / setGeolocationOverride), so they resolve natively with no
 * JS getter to unmask. The page is served from 127.0.0.1 (a secure context) so
 * navigator.geolocation is available and permission can be granted for its origin.
 *
 * Run with: bun test tests/fingerprint-locale.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { launchChrome, type LaunchResult } from "../src/launcher.js";
import { CDP } from "../src/cdp.js";
import { Page } from "../src/page.js";
import type { Fingerprint } from "../src/fingerprint.js";

const TIMEOUT = 30_000;

const US: Fingerprint = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36",
  platform: "Win32",
  platformVersion: "15.0.0",
  architecture: "x86",
  bitness: "64",
  model: "",
  mobile: false,
  hardwareConcurrency: 8,
  deviceMemory: 8,
  languages: ["en-US", "en"],
  screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24 },
  devicePixelRatio: 1,
  webglVendor: "Google Inc. (Intel)",
  webglRenderer: "ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
  timezone: "America/New_York",
  locale: "en-US",
  geolocation: { latitude: 40.7128, longitude: -74.006, accuracy: 50 },
  seed: 999,
};

describe.skipIf(!!process.env.CI)("fingerprint timezone / locale / geolocation", () => {
  let launch: LaunchResult;
  let cdp: CDP;
  let page: Page;
  let server: Server;

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response("<!doctype html><meta charset=utf-8><title>geo</title><h1>ctx</h1>", {
          headers: { "content-type": "text/html" },
        }),
    });
    const origin = `http://127.0.0.1:${server.port}`;
    launch = await launchChrome({ headless: true, blockPrivateNetwork: false });
    cdp = await CDP.connect(launch.webSocketDebuggerUrl);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    page = new Page(cdp, sessionId, targetId);
    await page.init({ fingerprint: US, blockPrivateNetwork: false });
    // Grant geolocation for the origin we're about to visit (browser-level).
    await cdp.send("Browser.grantPermissions", { origin, permissions: ["geolocation"] });
    await page.goto(`${origin}/`);
  });
  afterAll(async () => {
    try { cdp.close(); } catch {}
    launch?.kill();
    server?.stop(true);
  });

  it("Intl resolves the profile timezone", async () => {
    expect(await page.evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone")).toBe(US.timezone);
  }, TIMEOUT);

  it("Intl + navigator resolve the profile locale/language", async () => {
    expect(await page.evaluate("Intl.DateTimeFormat().resolvedOptions().locale")).toBe(US.locale);
    expect(await page.evaluate("navigator.language")).toBe(US.languages[0]);
    // languages[0] must equal the locale — the region can't disagree with itself.
    expect(US.languages[0]).toBe(US.locale);
  }, TIMEOUT);

  it("timezone offset matches the zone (America/New_York is behind UTC)", async () => {
    // A sanity cross-check that the override really moved the clock, not just the
    // reported string: New York is UTC-5/-4, so the offset is strictly positive
    // (getTimezoneOffset returns minutes BEHIND UTC as a positive number).
    const offsetMin = await page.evaluate<number>("new Date('2026-01-15T12:00:00Z').getTimezoneOffset()");
    expect(offsetMin).toBe(300); // EST = UTC-5 = 300 minutes
  }, TIMEOUT);

  it("geolocation returns the overridden coordinates", async () => {
    const pos = await page.evaluate<{ lat: number; lng: number }>(
      `new Promise((res, rej) => navigator.geolocation.getCurrentPosition(
         p => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
         e => rej(new Error('geo: ' + e.message)),
         { timeout: 5000 }))`,
    );
    expect(pos.lat).toBeCloseTo(US.geolocation!.latitude, 3);
    expect(pos.lng).toBeCloseTo(US.geolocation!.longitude, 3);
  }, TIMEOUT);
});
