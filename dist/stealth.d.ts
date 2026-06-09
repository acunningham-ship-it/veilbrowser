/**
 * The page-side stealth patch — minimal and SELF-GATING.
 *
 * Hard-won lesson: on a real, properly-launched Chrome, the "tells" stealth
 * bundles fix don't exist. `--disable-blink-features=AutomationControlled`
 * already yields `navigator.webdriver === false` (the correct *human* value —
 * NOT `undefined`, which is itself anomalous). A real profile already has the
 * `chrome` object, 5 plugins, and real `languages`. Blindly overriding those
 * doesn't help — and the overrides themselves (a patched `permissions.query`,
 * a faked `toString`) are the precise signatures deep fingerprinters score as
 * "stealth detected".
 *
 * So every patch here is gated: it fires ONLY when the value is actually wrong
 * (e.g. a stripped/headless environment leaked `webdriver === true` or 0 plugins).
 * On a healthy real Chrome this injects a script that observably does nothing.
 *
 * The WebGL vendor override is the one opt-in (`maskWebgl`), used solely to hide
 * SwiftShader on GPU-less hosts. With a real GPU it stays off — the authentic
 * vendor is consistent with the rendered pixels, so masking would be a lie.
 */
export interface StealthOptions {
    maskWebgl?: boolean;
    webglVendor?: string;
    webglRenderer?: string;
}
export declare function buildStealth(opts?: StealthOptions): string;
/** Default stealth source: self-gating, no WebGL masking (authentic GPU fingerprint). */
export declare const STEALTH_SOURCE: string;
