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
// --- UA parsing / client-hint derivation ------------------------------------
/** Parse the Chrome major version (e.g. 131) out of a UA string; fallback 131. */
export function chromeMajor(ua) {
    return ua.match(/Chrome\/(\d+)/)?.[1] ?? "131";
}
/** Parse the full Chrome version (e.g. 131.0.6778.86) out of a UA; fallback "<major>.0.0.0". */
export function chromeFullVersion(ua) {
    const m = ua.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
    return m?.[1] ?? `${chromeMajor(ua)}.0.0.0`;
}
/**
 * The Sec-CH-UA-Platform label ("Windows" | "macOS" | "Linux" | "Android"),
 * derived from the profile so it can never disagree with navigator.platform.
 */
export function clientHintPlatform(fp) {
    if (/Android/i.test(fp.userAgent))
        return "Android";
    const p = fp.platform.toLowerCase();
    if (p.startsWith("win"))
        return "Windows";
    if (p.startsWith("mac"))
        return "macOS";
    if (p.startsWith("linux"))
        return "Linux";
    return "Unknown";
}
/**
 * Build the significant-version brand list (Sec-CH-UA). Keeps veil's existing
 * greased "Not?A_Brand" entry so it matches the rest of the codebase; the brand
 * versions are pinned to the profile's Chrome major so they agree with the UA.
 */
function significantBrands(major) {
    return [
        { brand: "Chromium", version: major },
        { brand: "Google Chrome", version: major },
        { brand: "Not?A_Brand", version: "99" },
    ];
}
/** Build the full-version brand list (Sec-CH-UA-Full-Version-List). */
function fullVersionBrands(full) {
    return [
        { brand: "Chromium", version: full },
        { brand: "Google Chrome", version: full },
        { brand: "Not?A_Brand", version: "99.0.0.0" },
    ];
}
/**
 * The full `userAgentMetadata` object for Emulation.setUserAgentOverride, all of
 * it derived from (and therefore consistent with) the profile.
 */
export function buildClientHints(fp) {
    const major = chromeMajor(fp.userAgent);
    const full = chromeFullVersion(fp.userAgent);
    return {
        brands: fp.brands ?? significantBrands(major),
        fullVersionList: fp.uaFullVersionList ?? fullVersionBrands(full),
        fullVersion: full,
        platform: clientHintPlatform(fp),
        platformVersion: fp.platformVersion,
        architecture: fp.architecture,
        bitness: fp.bitness ?? "64",
        model: fp.model,
        mobile: fp.mobile,
        wow64: false,
    };
}
/**
 * A realistic weighted Accept-Language header from the languages list
 * (["en-US","en"] → "en-US,en;q=0.9"). The JS-observable `navigator.languages`
 * is set separately (masked getter) to the clean array so the "q=" qualifiers
 * from this header never leak into it.
 */
export function buildAcceptLanguage(languages) {
    return languages
        .map((l, i) => (i === 0 ? l : `${l};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`))
        .join(",");
}
// --- Injected page-level layer (masked getters) -----------------------------
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
export function buildFingerprintStealth(fp) {
    const j = (v) => JSON.stringify(v);
    return String.raw `
(() => {
  try {
    // --- native-toString masking harness ---------------------------------
    // One Proxy over Function.prototype.toString: our patched functions report
    // native code, the proxy hides itself, and everything else is passed through
    // (so genuine native fns stay native and user fns keep their real source —
    // over-masking would be its own tell).
    const nativeToString = Function.prototype.toString;
    const patched = new Map(); // fn -> display label, e.g. "get platform"
    const proxy = new Proxy(nativeToString, {
      apply(target, thisArg, args) {
        const label = patched.get(thisArg);
        if (label !== undefined) return "function " + label + "() { [native code] }";
        return Reflect.apply(target, thisArg, args);
      },
    });
    // Redefine as a non-enumerable data prop, like the original.
    Object.defineProperty(Function.prototype, "toString", {
      value: proxy, writable: true, enumerable: false, configurable: true,
    });
    const markNative = (fn, label) => {
      try { Object.defineProperty(fn, "name", { value: label, configurable: true }); } catch (e) {}
      patched.set(fn, label);
      return fn;
    };
    const defineGetter = (obj, prop, value) => {
      try {
        const getter = markNative(function () { return value; }, "get " + prop);
        Object.defineProperty(obj, prop, { get: getter, set: undefined, enumerable: true, configurable: true });
      } catch (e) {}
    };

    // --- navigator (values CDP setUserAgentOverride does not cover) --------
    defineGetter(Navigator.prototype, "hardwareConcurrency", ${j(fp.hardwareConcurrency)});
    defineGetter(Navigator.prototype, "deviceMemory", ${j(fp.deviceMemory)});
    // navigator.languages: kept as the clean array (the Accept-Language header
    // carries the q-weights; the JS array must not). Frozen like the real one.
    defineGetter(Navigator.prototype, "languages", Object.freeze(${j(fp.languages)}));

    // --- screen inset + colour depth (screen.width/height + DPR come from CDP
    //     setDeviceMetricsOverride; only these are not settable that way) -----
    defineGetter(Screen.prototype, "availWidth", ${j(fp.screen.availWidth)});
    defineGetter(Screen.prototype, "availHeight", ${j(fp.screen.availHeight)});
    defineGetter(Screen.prototype, "colorDepth", ${j(fp.screen.colorDepth)});
    defineGetter(Screen.prototype, "pixelDepth", ${j(fp.screen.colorDepth)});
  } catch (e) {}
})();
`;
}
