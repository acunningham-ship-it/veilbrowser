export { Browser } from "./browser.js";
export { Page, isPrivateHost, isOriginAllowed, verifyUrl, VERIFY_USER_AGENTS, type Snapshot, type Element, type DomSnapshot, type DomElement, type ExtractedText, type FedCmAccount, type FedCmDialog, type VerifyUrlResult } from "./page.js";
export { runBatch, BATCH_ACTIONS, type BatchStep, type BatchStepResult, type BatchResult } from "./batch.js";
export { launchChrome, findChrome, type LaunchOptions } from "./launcher.js";
export { CDP } from "./cdp.js";
export { STEALTH_SOURCE } from "./stealth.js";
export { Fingerprint, // interface + namespace (Fingerprint.random / Fingerprint.presets)
PRESETS, buildFingerprintStealth, buildClientHints, buildAcceptLanguage, clientHintPlatform, chromeMajor, chromeFullVersion, type FingerprintScreen, type FingerprintGeolocation, } from "./fingerprint.js";
export { Rng, mousePath } from "./human.js";
