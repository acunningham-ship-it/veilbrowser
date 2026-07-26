/**
 * Veil smoke test against a NEW Chrome major.
 *
 * Run after any Chrome upgrade. Chrome 148 -> 150 (2026-07-26) is the reason this
 * exists: Veil speaks raw CDP with no framework in between, so a protocol change
 * lands as a runtime failure in whatever script happens to run next rather than as
 * a build error. This exercises the surfaces Veil actually depends on, and checks
 * the STEALTH properties too — a browser that drives fine but leaks
 * navigator.webdriver is worse than one that fails loudly.
 *
 * ⚠️ Veil's evaluate() takes a STRING expression, NOT a puppeteer-style function.
 * Passing a function stringifies to "() => ..." which evaluates to a function
 * object returnByValue cannot serialise, and CDP reports it as
 * "Invalid parameters (-32602)" — which reads exactly like a protocol regression.
 * The first version of this file made that mistake and cost four probes chasing a
 * Chrome 150 breakage that did not exist.
 *
 * Uses a THROWAWAY profile: opening a real profile with a newer Chrome upgrades it
 * irreversibly, and the established session stores are the expensive thing here.
 *
 *   DISPLAY=:99 bun run examples/cdp150-smoke.ts
 */
import { Browser } from "../dist/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const dir = mkdtempSync(join(tmpdir(), "veil-smoke-"));
let browser: any;

try {
  browser = await Browser.launch({ headless: false, userDataDir: dir,
    args: ["--window-position=0,0", "--window-size=1280,720"] });
  check("launch (raw CDP handshake)", true);

  const page = await browser.newPage();
  check("newPage / Target.createTarget", !!page);

  await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
  const title = await page.evaluate("document.title");
  check("goto + Runtime.evaluate", /example/i.test(String(title)), `title="${title}"`);

  // The version Chrome actually reports — proves we're on the new binary.
  const ua = await page.evaluate("navigator.userAgent");
  const major = String(ua).match(/Chrome\/(\d+)/)?.[1];
  check("running the upgraded binary", major === "150", `Chrome major=${major}`);

  // STEALTH: the whole point of Veil. A driving browser that leaks is a failure.
  const webdriver = await page.evaluate("navigator.webdriver");
  check("navigator.webdriver is false", webdriver === false, `got ${String(webdriver)}`);

  // NOTE: a STRING expression — Veil is not puppeteer. An IIFE keeps it one value.
  const uaConsistent = await page.evaluate(`(() => {
    const b = (navigator.userAgentData && navigator.userAgentData.brands) || [];
    const m = navigator.userAgent.match(/Chrome\\/(\\d+)/);
    const uaMajor = m ? m[1] : "";
    const cr = b.filter(function(x){ return /Chrome|Chromium/.test(x.brand); })[0];
    const brandMajor = cr ? cr.version : "";
    return { uaMajor: uaMajor, brandMajor: brandMajor, agree: uaMajor === brandMajor };
  })()`);
  check("UA and UA-CH brands AGREE (a mismatch is a bot tell)",
    uaConsistent.agree, `ua=${uaConsistent.uaMajor} brands=${uaConsistent.brandMajor}`);

  // Interaction surfaces Veil exposes — the a11y-ref path is its signature feature.
  const snap = await page.snapshot?.().catch(() => null);
  check("snapshot / accessibility tree", !!snap, snap ? "tree returned" : "unavailable");

  await page.goto("https://example.com/#x", { waitUntil: "domcontentloaded" });
  const shot = await page.screenshot?.().catch(() => null);
  check("screenshot / Page.captureScreenshot",
    !!shot && (shot as any).length > 1000, shot ? `${(shot as any).length} bytes` : "none");
} catch (err) {
  check("harness completed", false, String((err as Error)?.message || err));
} finally {
  try { await browser?.close?.(); } catch {}
  rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
