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
 *
 * SHAPE NOTE (load-bearing): this is a STATIC template with exactly one
 * placeholder, `__VEIL_FP__`, replaced by a JSON object of the nine values the
 * body reads. It used to interpolate each value at its use site, which read
 * slightly better but made the script impossible to share: the Python front end
 * (`python/`) emits the SAME stealth bytes by doing the same one-token
 * substitution on the same file. Any other arrangement would mean a second
 * implementation of the fingerprint layer, and two implementations of a stealth
 * patch drift — which is not a cosmetic problem, it is one front end being
 * detectable while its tests pass. `tests/python-parity.test.ts` asserts the two
 * emit byte-identical text for every preset, so a change here that Python cannot
 * follow fails the build rather than shipping quietly.
 */
export declare const FINGERPRINT_STEALTH_BODY: string;
/**
 * The nine values the body reads, as a flat object.
 *
 * KEY ORDER IS PART OF THE CONTRACT. The emitted script is compared byte-for-byte
 * against the Python front end's output, and JSON.stringify preserves insertion
 * order — so reordering these keys is a real (if invisible) change. Add new keys
 * at the END and add them to the Python side in the same position.
 */
export declare function fingerprintStealthPayload(fp: Fingerprint): {
    hardwareConcurrency: number;
    deviceMemory: number;
    languages: string[];
    availWidth: number;
    availHeight: number;
    colorDepth: number;
    webglVendor: string;
    webglRenderer: string;
    seed: number;
};
/** The injected page-level stealth script for a profile: body + its values. */
export declare function buildFingerprintStealth(fp: Fingerprint): string;
/**
 * Ready-made, internally-consistent profiles. Each is a REAL Chrome-131 identity
 * for its OS — the UA, client-hint platform/arch, legacy navigator.platform,
 * WebGL vendor/renderer, screen and DPR all agree (e.g. an Apple-Silicon Mac
 * still reports the frozen "Intel Mac OS X 10_15_7" UA + "MacIntel" platform with
 * an "arm" architecture and an Apple Metal renderer — exactly as a real one does).
 * Use one directly, or as the coherent base for `Fingerprint.random`.
 */
export declare const PRESETS: Record<string, Fingerprint>;
export declare const SCREEN_SETS: Record<string, FingerprintScreen[]>;
export declare const US_TIMEZONES: string[];
export declare const TZ_COORDS: Record<string, FingerprintGeolocation>;
export declare namespace Fingerprint {
    /** The named presets, also reachable as `Fingerprint.presets`. */
    const presets: Record<string, Fingerprint>;
    /**
     * Build a SELF-CONSISTENT random desktop profile. It picks a platform first
     * (windows/mac/linux) — a full coherent preset — then varies only fields that
     * are independent of the UA (screen resolution from that OS's realistic set,
     * hardwareConcurrency, US timezone + matching coordinates). The coherence-
     * critical core (UA, client hints, navigator.platform, WebGL) comes straight
     * from the preset, so a randomized profile passes the same consistency checks.
     * Deterministic given a `seed`; omit it for a fresh random identity.
     */
    function random(seed?: number): Fingerprint;
}
