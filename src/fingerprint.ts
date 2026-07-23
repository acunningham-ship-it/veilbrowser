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
  uaFullVersionList?: Array<{ brand: string; version: string }>;
  /** Sec-CH-UA brands (significant/major version only). Derived from the UA if omitted. */
  brands?: Array<{ brand: string; version: string }>;
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

// --- UA parsing / client-hint derivation ------------------------------------

/** Parse the Chrome major version (e.g. 131) out of a UA string; fallback 131. */
export function chromeMajor(ua: string): string {
  return ua.match(/Chrome\/(\d+)/)?.[1] ?? "131";
}

/** Parse the full Chrome version (e.g. 131.0.6778.86) out of a UA; fallback "<major>.0.0.0". */
export function chromeFullVersion(ua: string): string {
  const m = ua.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
  return m?.[1] ?? `${chromeMajor(ua)}.0.0.0`;
}

/**
 * The Sec-CH-UA-Platform label ("Windows" | "macOS" | "Linux" | "Android"),
 * derived from the profile so it can never disagree with navigator.platform.
 */
export function clientHintPlatform(fp: Pick<Fingerprint, "platform" | "userAgent" | "mobile">): string {
  if (/Android/i.test(fp.userAgent)) return "Android";
  const p = fp.platform.toLowerCase();
  if (p.startsWith("win")) return "Windows";
  if (p.startsWith("mac")) return "macOS";
  if (p.startsWith("linux")) return "Linux";
  return "Unknown";
}

/**
 * Build the significant-version brand list (Sec-CH-UA). Keeps veil's existing
 * greased "Not?A_Brand" entry so it matches the rest of the codebase; the brand
 * versions are pinned to the profile's Chrome major so they agree with the UA.
 */
function significantBrands(major: string): Array<{ brand: string; version: string }> {
  return [
    { brand: "Chromium", version: major },
    { brand: "Google Chrome", version: major },
    { brand: "Not?A_Brand", version: "99" },
  ];
}

/** Build the full-version brand list (Sec-CH-UA-Full-Version-List). */
function fullVersionBrands(full: string): Array<{ brand: string; version: string }> {
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
export function buildClientHints(fp: Fingerprint) {
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
export function buildAcceptLanguage(languages: string[]): string {
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
export function buildFingerprintStealth(fp: Fingerprint): string {
  const j = (v: unknown) => JSON.stringify(v);
  return String.raw`
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
    // Redefine a prototype METHOD (data property), masked like the getters above.
    const defineMethod = (obj, prop, fn) => {
      try {
        markNative(fn, prop);
        Object.defineProperty(obj, prop, { value: fn, writable: true, enumerable: false, configurable: true });
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

    // --- WebGL vendor / renderer -------------------------------------------
    // Answer the two UNMASKED_* parameters (37445/37446) with the profile's
    // values; everything else falls through to the real driver. The values must
    // be plausible for the claimed platform (don't put "Apple GPU" on Windows) —
    // that's the caller's job; presets keep them coherent.
    const WEBGL_VENDOR = ${j(fp.webglVendor)};
    const WEBGL_RENDERER = ${j(fp.webglRenderer)};
    const patchGL = (proto) => {
      if (!proto || !proto.getParameter) return;
      const orig = proto.getParameter;
      defineMethod(proto, "getParameter", function (p) {
        if (p === 37445) return WEBGL_VENDOR;   // UNMASKED_VENDOR_WEBGL
        if (p === 37446) return WEBGL_RENDERER;  // UNMASKED_RENDERER_WEBGL
        return orig.apply(this, arguments);
      });
    };
    patchGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
    patchGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

    // --- deterministic seeded noise ----------------------------------------
    // Stable per seed, NOT per call: repeated reads of the same canvas/buffer
    // return the SAME perturbed bytes (a per-call random would itself be the
    // tell). Different seed -> different pattern -> different hash, so a profile
    // has its own stable canvas/audio fingerprint instead of the host's.
    const SEED = ${j(fp.seed >>> 0)};
    const hash32 = (a, b) => {
      let x = (a ^ Math.imul(b >>> 0, 2654435761)) >>> 0;
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; return x >>> 0;
    };

    // Canvas (2D). Perturb a COPY for read-back, deterministic per (seed,pixel),
    // leaving alpha and the source bitmap untouched. WebGL-canvas read-back is
    // left to the vendor override above.
    if (window.CanvasRenderingContext2D && window.HTMLCanvasElement) {
      const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      const origToBlob = HTMLCanvasElement.prototype.toBlob;
      const perturb = (imageData) => {
        const copy = new Uint8ClampedArray(imageData.data);
        for (let p = 0; p < copy.length; p += 4) {
          const d = (hash32(SEED, p) % 3) - 1; // -1, 0, +1
          copy[p] += d; copy[p + 1] += d; copy[p + 2] += d; // RGB only
        }
        return new ImageData(copy, imageData.width, imageData.height);
      };
      defineMethod(CanvasRenderingContext2D.prototype, "getImageData", function () {
        const data = origGetImageData.apply(this, arguments);
        try { return perturb(data); } catch (e) { return data; }
      });
      const encodeNoisy = (canvas, encode) => {
        try {
          const ctx = canvas.getContext("2d");
          const w = canvas.width, h = canvas.height;
          if (!ctx || !w || !h) return null; // non-2D / empty -> caller uses original
          const noisy = perturb(origGetImageData.call(ctx, 0, 0, w, h));
          const tmp = document.createElement("canvas");
          tmp.width = w; tmp.height = h;
          tmp.getContext("2d").putImageData(noisy, 0, 0);
          return encode(tmp);
        } catch (e) { return null; }
      };
      defineMethod(HTMLCanvasElement.prototype, "toDataURL", function () {
        const args = arguments;
        const out = encodeNoisy(this, (tmp) => origToDataURL.apply(tmp, args));
        return out !== null ? out : origToDataURL.apply(this, args);
      });
      defineMethod(HTMLCanvasElement.prototype, "toBlob", function (cb) {
        const rest = Array.prototype.slice.call(arguments, 1);
        const done = encodeNoisy(this, (tmp) => { origToBlob.apply(tmp, [cb].concat(rest)); return true; });
        if (done === null) origToBlob.apply(this, arguments);
      });
    }

    // Audio. Perturb each rendered channel ONCE (WeakSet-guarded) by a tiny
    // deterministic delta — the classic OfflineAudioContext hash then differs per
    // seed while staying stable across reads, with no accumulation.
    if (window.AudioBuffer) {
      const origGCD = AudioBuffer.prototype.getChannelData;
      const noised = new WeakSet();
      defineMethod(AudioBuffer.prototype, "getChannelData", function () {
        const arr = origGCD.apply(this, arguments);
        try {
          if (arr && !noised.has(arr)) {
            noised.add(arr);
            for (let i = 0; i < arr.length; i++) {
              arr[i] += ((hash32(SEED, i) / 4294967295) - 0.5) * 1e-5;
            }
          }
        } catch (e) {}
        return arr;
      });
    }
  } catch (e) {}
})();
`;
}
