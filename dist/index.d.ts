export { Browser } from "./browser.js";
export { Page, isPrivateHost, type Snapshot, type Element, type FedCmAccount, type FedCmDialog } from "./page.js";
export { launchChrome, findChrome, type LaunchOptions } from "./launcher.js";
export { CDP } from "./cdp.js";
export { STEALTH_SOURCE } from "./stealth.js";
export { Fingerprint, // interface + namespace (Fingerprint.random / Fingerprint.presets)
PRESETS, buildFingerprintStealth, buildClientHints, buildAcceptLanguage, clientHintPlatform, chromeMajor, chromeFullVersion, type FingerprintScreen, type FingerprintGeolocation, } from "./fingerprint.js";
export { Rng, mousePath } from "./human.js";
