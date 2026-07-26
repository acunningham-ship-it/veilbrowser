/* GENERATED FROM src/fingerprint.ts FINGERPRINT_STEALTH_BODY by tools-gen-python-assets.ts — DO NOT EDIT.
   Edit the TypeScript source and re-run the generator; tests/python-parity.test.ts
   fails if this file and the TS disagree. */

(() => {
  const FP = __VEIL_FP__;
  try {
    // --- native-toString masking harness ---------------------------------
    // One Proxy over Function.prototype.toString: our patched functions report
    // native code, the proxy hides itself, and everything else is passed through
    // (so genuine native fns stay native and user fns keep their real source --
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
    defineGetter(Navigator.prototype, "hardwareConcurrency", FP.hardwareConcurrency);
    defineGetter(Navigator.prototype, "deviceMemory", FP.deviceMemory);
    // navigator.languages: kept as the clean array (the Accept-Language header
    // carries the q-weights; the JS array must not). Frozen like the real one.
    defineGetter(Navigator.prototype, "languages", Object.freeze(FP.languages));

    // --- screen inset + colour depth (screen.width/height + DPR come from CDP
    //     setDeviceMetricsOverride; only these are not settable that way) -----
    defineGetter(Screen.prototype, "availWidth", FP.availWidth);
    defineGetter(Screen.prototype, "availHeight", FP.availHeight);
    defineGetter(Screen.prototype, "colorDepth", FP.colorDepth);
    defineGetter(Screen.prototype, "pixelDepth", FP.colorDepth);

    // --- WebGL vendor / renderer -------------------------------------------
    // Answer the two UNMASKED_* parameters (37445/37446) with the profile's
    // values; everything else falls through to the real driver. The values must
    // be plausible for the claimed platform (don't put "Apple GPU" on Windows) --
    // that's the caller's job; presets keep them coherent.
    const WEBGL_VENDOR = FP.webglVendor;
    const WEBGL_RENDERER = FP.webglRenderer;
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
    const SEED = FP.seed;
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
    // deterministic delta -- the classic OfflineAudioContext hash then differs per
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
