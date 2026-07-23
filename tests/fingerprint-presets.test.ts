/**
 * Preset profiles + Fingerprint.random(). The coherence checks are pure logic
 * (no browser), so they run in CI. A second block (skipped in CI) applies a
 * RANDOMIZED profile to real Chrome and re-runs the PR1-style consistency
 * asserts, proving a random identity is as coherent as a hand-built one.
 *
 * Run with: bun test tests/fingerprint-presets.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { Browser } from "../src/index.js";
import { Fingerprint, PRESETS, clientHintPlatform, chromeMajor, chromeFullVersion } from "../src/fingerprint.js";
import type { Page } from "../src/page.js";

const TIMEOUT = 30_000;

/** Assert a fingerprint is internally consistent — the same rule set a leak
 *  check applies: platform family, language/locale, screen bounds, WebGL, UA. */
function assertCoherent(fp: Fingerprint) {
  const ch = clientHintPlatform(fp);
  if (ch === "Windows") expect(fp.platform.startsWith("Win")).toBe(true);
  if (ch === "macOS") expect(fp.platform.startsWith("Mac")).toBe(true);
  if (ch === "Linux") expect(fp.platform.startsWith("Linux")).toBe(true);
  if (ch === "Android") expect(fp.userAgent).toContain("Android");
  // navigator.language (languages[0]) must equal the locale — the region can't
  // disagree with itself.
  expect(fp.languages[0]).toBe(fp.locale);
  // avail never exceeds the physical screen.
  expect(fp.screen.availWidth).toBeLessThanOrEqual(fp.screen.width);
  expect(fp.screen.availHeight).toBeLessThanOrEqual(fp.screen.height);
  // WebGL vendor/renderer present.
  expect(fp.webglVendor.length).toBeGreaterThan(0);
  expect(fp.webglRenderer.length).toBeGreaterThan(0);
  // The client-hint full version's major must match the Chrome major in the UA.
  expect(chromeFullVersion(fp.userAgent).startsWith(chromeMajor(fp.userAgent) + ".")).toBe(true);
  // mobile flag agrees with the UA.
  expect(fp.mobile).toBe(/Mobile|Android/.test(fp.userAgent));
}

describe("preset profiles + randomizer (pure)", () => {
  it("every preset is internally consistent", () => {
    const names = Object.keys(PRESETS);
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const name of names) assertCoherent(PRESETS[name]!);
  });

  it("mac preset carries the real Apple-Silicon quirks (frozen Intel UA + arm arch)", () => {
    const mac = PRESETS["mac-chrome"]!;
    expect(mac.userAgent).toContain("Intel Mac OS X 10_15_7"); // Chrome freezes this
    expect(mac.platform).toBe("MacIntel");
    expect(mac.architecture).toBe("arm");
    expect(mac.webglRenderer).toContain("Apple");
  });

  it("Fingerprint.random is deterministic given a seed", () => {
    expect(JSON.stringify(Fingerprint.random(42))).toBe(JSON.stringify(Fingerprint.random(42)));
    expect(Fingerprint.random(42).seed).toBe(42);
    // Different seeds produce different profiles (at least one field differs).
    expect(JSON.stringify(Fingerprint.random(42))).not.toBe(JSON.stringify(Fingerprint.random(1234)));
  });

  it("every randomized profile is internally consistent", () => {
    for (const seed of [1, 7, 42, 99, 1234, 55555, 0xabcdef]) assertCoherent(Fingerprint.random(seed));
  });

  it("Fingerprint.presets mirrors PRESETS", () => {
    expect(Fingerprint.presets).toBe(PRESETS);
  });
});

// Pick a seed that yields a known platform so the assertions are stable; the
// profile is still produced entirely by the randomizer.
const RANDOM_FP = Fingerprint.random(42);

describe.skipIf(!!process.env.CI)("a randomized profile applied to real Chrome is coherent", () => {
  let browser: Browser;
  let page: Page;
  let server: Server;

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response("<!doctype html><meta charset=utf-8><title>rnd</title><h1>ctx</h1>", {
          headers: { "content-type": "text/html" },
        }),
    });
    browser = await Browser.launch({ headless: true, fingerprint: RANDOM_FP, blockPrivateNetwork: false });
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  it("navigator + client hints + screen agree with the randomized profile", async () => {
    expect(await page.evaluate("navigator.userAgent")).toBe(RANDOM_FP.userAgent);
    expect(await page.evaluate("navigator.platform")).toBe(RANDOM_FP.platform);
    expect(await page.evaluate("navigator.hardwareConcurrency")).toBe(RANDOM_FP.hardwareConcurrency);
    expect(await page.evaluate("navigator.deviceMemory")).toBe(RANDOM_FP.deviceMemory);
    expect(await page.evaluate("JSON.stringify(navigator.languages)")).toBe(JSON.stringify(RANDOM_FP.languages));
    expect(await page.evaluate("navigator.userAgentData.platform")).toBe(clientHintPlatform(RANDOM_FP));
    expect(await page.evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone")).toBe(RANDOM_FP.timezone);
    expect(await page.evaluate("screen.width")).toBe(RANDOM_FP.screen.width);
    expect(await page.evaluate("screen.height")).toBe(RANDOM_FP.screen.height);
    expect(await page.evaluate("screen.availHeight")).toBe(RANDOM_FP.screen.availHeight);
    expect(await page.evaluate("screen.colorDepth")).toBe(RANDOM_FP.screen.colorDepth);
    expect(await page.evaluate("window.devicePixelRatio")).toBe(RANDOM_FP.devicePixelRatio);
  }, TIMEOUT);
});
