/**
 * Coherent fingerprint / profile system.
 *
 * THE GOLDEN RULE here is coherence, not spoof-count. A half-spoofed fingerprint
 * is WORSE than none: if `navigator.userAgent` says Chrome on Windows but the
 * client-hints / `navigator.platform` / WebGL vendor disagree, that very
 * INCONSISTENCY is a detection signal. So a `Fingerprint` is applied as one
 * internally-consistent set, and every derived value (client-hint platform,
 * brand versions, accept-language) is computed FROM the profile so nothing can
 * drift out of agreement.
 *
 * Two application layers, by design:
 *   1. Browser-level (CDP `Emulation.*`) — the CLEAN layer. `setUserAgentOverride`
 *      (UA + full `userAgentMetadata` + the legacy `navigator.platform`),
 *      `setDeviceMetricsOverride` (screen dims + devicePixelRatio),
 *      `setTimezoneOverride`, `setLocaleOverride`, `setGeolocationOverride`.
 *      These are set by Chrome itself, so there is NO JS getter to unmask —
 *      the strongest possible spoof.
 *   2. Page-level (injected getters) — only the handful of values CDP can't set:
 *      `navigator.hardwareConcurrency` / `deviceMemory` / `languages`, the
 *      `screen.avail*` / colour depth, and (later) WebGL/canvas/audio. Every one
 *      is defined on the PROTOTYPE (inherited, never an own-property tell) and its
 *      `toString()` is masked to `[native code]` so the override can't be read
 *      back as patched — the same discipline `stealth.ts` uses.
 *
 * `navigator.oscpu` is intentionally NOT applied: it is a Firefox-only property.
 * A Chrome UA that also exposed `navigator.oscpu` would be an anomaly in itself,
 * so the field exists on the type for completeness but is ignored on Chrome
 * profiles (see buildFingerprintStealth).
 */
/** Screen geometry a page can read (screen.* + the avail inset for a taskbar/menubar). */
export interface FingerprintScreen {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
}
/** One optional geolocation fix, applied via Emulation.setGeolocationOverride. */
export interface FingerprintGeolocation {
    latitude: number;
    longitude: number;
    accuracy?: number;
}
/**
 * A complete, internally-consistent browser identity. Build one with a preset
 * (`PRESETS`), `Fingerprint.random(seed)`, or by hand — but if you hand-build,
 * keep every field in agreement with the UA (a Windows UA needs a Win32
 * platform, a Windows-plausible WebGL renderer, etc.).
 */
export interface Fingerprint {
    /** navigator.userAgent — the anchor every other field must agree with. */
    userAgent: string;
    /** Sec-CH-UA-Full-Version-List brands (full x.y.z.w versions). Derived from the UA if omitted. */
    uaFullVersionList?: Array<{
        brand: string;
        version: string;
    }>;
    /** Sec-CH-UA brands (significant/major version only). Derived from the UA if omitted. */
    brands?: Array<{
        brand: string;
        version: string;
    }>;
    /** Legacy navigator.platform string: "Win32" | "MacIntel" | "Linux x86_64" | "Linux armv8l". */
    platform: string;
    /** Sec-CH-UA-Platform-Version (OS version), e.g. "15.0.0" (Win11) or "14.6.0" (macOS). */
    platformVersion: string;
    /** Sec-CH-UA-Arch: "x86" | "arm". */
    architecture: string;
    /** Sec-CH-UA-Bitness (default "64"). */
    bitness?: string;
    /** Sec-CH-UA-Model — "" on desktop, a device name on Android. */
    model: string;
    /** Sec-CH-UA-Mobile. */
    mobile: boolean;
    /** Firefox-only navigator.oscpu. IGNORED on Chrome profiles (see file header). */
    oscpu?: string;
    /** navigator.hardwareConcurrency (logical cores). */
    hardwareConcurrency: number;
    /** navigator.deviceMemory (GiB, spec-clamped to 8). */
    deviceMemory: number;
    /** navigator.languages, e.g. ["en-US","en"]. First entry also drives navigator.language. */
    languages: string[];
    /** screen.* geometry. */
    screen: FingerprintScreen;
    /** window.devicePixelRatio. */
    devicePixelRatio: number;
    /** WebGL UNMASKED_VENDOR_WEBGL (param 37445) — must be plausible for `platform`. */
    webglVendor: string;
    /** WebGL UNMASKED_RENDERER_WEBGL (param 37446) — must be plausible for `platform`. */
    webglRenderer: string;
    /** IANA timezone, e.g. "America/New_York". Should match the locale's region. */
    timezone: string;
    /** BCP-47 locale, e.g. "en-US". Its region should match the timezone. */
    locale: string;
    /** Optional geolocation fix (US profile → US coordinates, etc.). */
    geolocation?: FingerprintGeolocation;
    /** Numeric seed for deterministic canvas/audio noise (stable within a session). */
    seed: number;
}
/** Parse the Chrome major version (e.g. 131) out of a UA string; fallback 131. */
export declare function chromeMajor(ua: string): string;
/** Parse the full Chrome version (e.g. 131.0.6778.86) out of a UA; fallback "<major>.0.0.0". */
export declare function chromeFullVersion(ua: string): string;
/**
 * The Sec-CH-UA-Platform label ("Windows" | "macOS" | "Linux" | "Android"),
 * derived from the profile so it can never disagree with navigator.platform.
 */
export declare function clientHintPlatform(fp: Pick<Fingerprint, "platform" | "userAgent" | "mobile">): string;
/**
 * The full `userAgentMetadata` object for Emulation.setUserAgentOverride, all of
 * it derived from (and therefore consistent with) the profile.
 */
export declare function buildClientHints(fp: Fingerprint): {
    brands: {
        brand: string;
        version: string;
    }[];
    fullVersionList: {
        brand: string;
        version: string;
    }[];
    fullVersion: string;
    platform: string;
    platformVersion: string;
    architecture: string;
    bitness: string;
    model: string;
    mobile: boolean;
    wow64: boolean;
};
/**
 * A realistic weighted Accept-Language header from the languages list
 * (["en-US","en"] → "en-US,en;q=0.9"). The JS-observable `navigator.languages`
 * is set separately (masked getter) to the clean array so the "q=" qualifiers
 * from this header never leak into it.
 */
export declare function buildAcceptLanguage(languages: string[]): string;
/**
 * The JS the page runs before any site code (via addScriptToEvaluateOnNewDocument)
 * to apply the handful of fingerprint values CDP can't set. Every override is:
 *   - defined on the PROTOTYPE, so it is inherited (never an own-property tell);
 *   - given the native getter name ("get <prop>");
 *   - reported as "[native code]" by a single Function.prototype.toString proxy
 *     that also hides itself and leaves genuine native/user functions untouched.
 *
 * Values are inlined as JSON so the emitted script has no free variables.
 */
export declare function buildFingerprintStealth(fp: Fingerprint): string;
