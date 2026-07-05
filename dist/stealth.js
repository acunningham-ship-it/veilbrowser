export function buildStealth(opts = {}) {
    const maskWebgl = opts.maskWebgl ?? false;
    const vendor = opts.webglVendor ?? "Google Inc. (Intel)";
    const renderer = opts.webglRenderer ?? "ANGLE (Intel, Mesa Intel(R) UHD Graphics)";
    // Only emitted for SwiftShader hosts. When present it also needs the toString
    // mask so the getParameter override can't be read back as non-native.
    const webglBlock = maskWebgl
        ? String.raw `
  try {
    const proto = WebGLRenderingContext && WebGLRenderingContext.prototype;
    if (proto) {
      const getParameter = proto.getParameter;
      proto.getParameter = function (p) {
        if (p === 37445) return ${JSON.stringify(vendor)};
        if (p === 37446) return ${JSON.stringify(renderer)};
        return getParameter.apply(this, arguments);
      };
      const native = Function.prototype.toString;
      const masked = proto.getParameter;
      Function.prototype.toString = function () {
        if (this === masked || this === Function.prototype.toString) return 'function () { [native code] }';
        return native.call(this);
      };
    }
  } catch (e) {}`
        : "";
    return String.raw `
(() => {
  if (window.__veil) return;
  Object.defineProperty(window, '__veil', { value: true, enumerable: false });

  const patchGetter = (obj, prop, value) => {
    try { Object.defineProperty(obj, prop, { get: () => value, configurable: true, enumerable: true }); } catch (e) {}
  };

  // webdriver: fix ONLY if automation leaked it as true. Real Chrome's false is correct.
  try { if (navigator.webdriver === true) patchGetter(Object.getPrototypeOf(navigator), 'webdriver', false); } catch (e) {}

  // chrome object: add only if a stripped build is missing it.
  if (!window.chrome) window.chrome = { runtime: {} };

  // plugins: backfill only if empty (real desktop reports the PDF viewers).
  try {
    if (navigator.plugins && navigator.plugins.length === 0) {
      patchGetter(Object.getPrototypeOf(navigator), 'plugins', [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      ]);
    }
  } catch (e) {}

  // languages: backfill only if empty.
  if (!navigator.languages || navigator.languages.length === 0) {
    patchGetter(Object.getPrototypeOf(navigator), 'languages', ['en-US', 'en']);
  }

  // deviceMemory: the spec caps this at 8. Some Linux builds leak the raw host
  // RAM (e.g. 32) — an impossible value no real Chrome reports. Clamp ONLY when
  // it exceeds the spec max.
  try { if (navigator.deviceMemory > 8) patchGetter(Object.getPrototypeOf(navigator), 'deviceMemory', 8); } catch (e) {}

  // Taskbar inset: a bare virtual display (Xvfb, no window manager) reports
  // screen.availHeight === screen.height — no desktop furniture, a server tell.
  // A real desktop reserves ~48px for a taskbar/dock. Patch ONLY when avail
  // fills the whole screen (the anomaly); leave a real WM's values untouched.
  try {
    if (screen.availWidth === screen.width && screen.availHeight === screen.height) {
      patchGetter(screen, 'availHeight', screen.height - 48);
    }
  } catch (e) {}
${webglBlock}
})();
`;
}
/** Default stealth source: self-gating, no WebGL masking (authentic GPU fingerprint). */
export const STEALTH_SOURCE = buildStealth();
