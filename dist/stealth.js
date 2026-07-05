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

  // DELIBERATELY NOT PATCHED — deviceMemory and screen.availHeight.
  // A tempting "fix" is to clamp deviceMemory to the spec max of 8, and to shave
  // a taskbar inset off availHeight on a WM-less Xvfb (where availHeight === height).
  // Both were tried and REMOVED: a JS getter override is itself the tell. A
  // fingerprinter reading the property descriptor's getter sees "() => value"
  // instead of "[native code]", or notices availHeight became an OWN property of
  // the screen instance instead of being inherited from Screen.prototype. That is
  // the exact "masking detected" signature veil exists to avoid — worse than the
  // anomalous value it hid. On a real user's machine these values are already sane
  // (Chrome caps deviceMemory at 8; a real desktop has a taskbar), so nothing needs
  // patching. On a headless server box that leaks an out-of-spec deviceMemory, fix
  // it at the source (the host), never with a getter a page can unmask.
${webglBlock}
})();
`;
}
/** Default stealth source: self-gating, no WebGL masking (authentic GPU fingerprint). */
export const STEALTH_SOURCE = buildStealth();
