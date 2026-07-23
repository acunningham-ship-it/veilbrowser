/**
 * The agent-facing page API.
 *
 * Design goal: an LLM agent should never write a CSS/XPath selector. Selectors
 * are the #1 source of automation breakage. Instead, `snapshot()` returns the
 * page as a flat, numbered list of meaningful elements pulled from Chrome's
 * accessibility tree — the same semantic layer a screen reader sees. The agent
 * acts on a stable integer `ref`; we resolve the geometry and drive real input.
 */
import type { CDP } from "./cdp.js";
import { buildStealth } from "./stealth.js";
import { buildFingerprintStealth, buildClientHints, buildAcceptLanguage, type Fingerprint } from "./fingerprint.js";
import { Rng, mousePath, moveDelay, keyDelay, sleep, type Point } from "./human.js";

export interface Element {
  ref: number;
  role: string;
  name: string;
  value?: string;
  center: Point;
}

export interface Snapshot {
  url: string;
  title: string;
  /** Human/agent-readable index, e.g. `[3] button "Sign in"`. */
  text: string;
  elements: Element[];
}

/** One account offered in a FedCM account chooser. */
export interface FedCmAccount {
  accountId: string;
  email?: string;
  name?: string;
  givenName?: string;
  idpConfigUrl?: string;
}

/** A FedCM dialog Chrome would normally render as native browser UI. */
export interface FedCmDialog {
  dialogId: string;
  /** "AccountChooser" | "AutoReauthn" | "ConfirmIdpLogin" | "SelectAccount" ... */
  type: string;
  title?: string;
  subtitle?: string;
  accounts: FedCmAccount[];
}

const INTERESTING = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
  "menuitem", "menuitemcheckbox", "tab", "switch", "slider", "option",
  "listbox", "spinbutton", "textarea",
]);

/**
 * True if `url` targets a loopback / private-network host. Fingerprinters
 * (iphey, pixelscan, …) port-scan these from page JS to profile the machine's
 * OTHER software — VNC on :5900, a local automation API on :3001, etc. — which
 * also leaks your LAN to every site you visit. Exotic IP encodings (decimal,
 * hex) are a known gap; real-world scanners use the canonical forms below.
 */
export function isPrivateHost(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  host = host.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  // IPv6 unique-local (fc00::/7) — the v6 analog of RFC1918 LAN space. The
  // first hextet is fc00–fdff (never abbreviated, so exactly 4 hex chars).
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — same IPv4 host wearing a v6 hat; a
  // public page could reach ::ffff:127.0.0.1 to hit loopback. The URL parser
  // normalizes the tail to two hex hextets (::ffff:7f00:1), so fold it back to
  // a dotted quad and re-apply the IPv4 rules.
  if (host.startsWith("::ffff:")) return isPrivateIPv4(mappedToIPv4(host.slice(7)));
  return isPrivateIPv4(host);
}

/** Fold the tail of an ::ffff: IPv4-mapped address to a dotted quad. Accepts an
 * already-dotted tail (a.b.c.d) or the parser's two-hextet hex form (7f00:1). */
function mappedToIPv4(tail: string): string {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail;
  const g = tail.split(":");
  if (g.length !== 2) return "";
  const hi = parseInt(g[0]!, 16), lo = parseInt(g[1]!, 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return "";
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/** IPv4 dotted-quad private/loopback classifier (also reused for ::ffff: maps). */
function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (!m) return false;
  const a = +m[1]!, b = +m[2]!;
  return (
    a === 127 ||                        // 127.0.0.0/8 loopback
    a === 10 ||                         // 10.0.0.0/8
    a === 0 ||                          // 0.0.0.0/8
    (a === 100 && b >= 64 && b <= 127) ||// 100.64.0.0/10 CGNAT / Tailscale tailnet
    (a === 192 && b === 168) ||         // 192.168.0.0/16
    (a === 172 && b >= 16 && b <= 31) ||// 172.16.0.0/12
    (a === 169 && b === 254)            // 169.254.0.0/16 link-local
  );
}

// Only these (private) requests are intercepted, so normal browsing keeps its
// exact timing — no global request pause. Globs over-capture slightly (e.g.
// 172.1*); isPrivateHost() is the real gate in the handler. http/https only:
// CDP's Fetch domain does not intercept WebSocket handshakes, so raw ws:// to a
// private host falls back to Chrome's own Private Network Access (a timeout, not
// a uniform block). Real port-scanners (and the :3001/:5900 probes) use HTTP.
// 100.6/7/8/9 + 100.1 coarsely cover the CGNAT range 100.64.0.0/10 (over-capture
// gated by isPrivateHost, same as 172.1*); [fc/[fd cover IPv6 unique-local
// fc00::/7; [::ffff: covers IPv4-mapped IPv6.
const PRIVATE_URL_PATTERNS = [
  "localhost", "127.", "0.0.0.0", "10.", "192.168.", "172.1", "172.2", "172.3",
  "169.254.", "100.6", "100.7", "100.8", "100.9", "100.1", "[::1]", "[fc", "[fd", "[::ffff:",
].flatMap((h) => ["http", "https"].map((s) => ({ urlPattern: `${s}://${h}*` })));

/**
 * Friendly resource-type names → the CDP Network.ResourceType values that
 * Fetch.requestPaused reports and Fetch patterns filter on. Lets blockResources()
 * take `"image"` instead of `"Image"` and forgive a few common aliases.
 */
const RESOURCE_TYPES: Record<string, string> = {
  image: "Image", images: "Image", img: "Image",
  font: "Font", fonts: "Font",
  media: "Media", video: "Media", audio: "Media",
  stylesheet: "Stylesheet", css: "Stylesheet", style: "Stylesheet",
  script: "Script", js: "Script",
  xhr: "XHR", fetch: "Fetch",
  document: "Document", doc: "Document",
  websocket: "WebSocket", ws: "WebSocket",
  eventsource: "EventSource",
  manifest: "Manifest",
  other: "Other",
};

/**
 * US-layout physical-key descriptor for the printable symbol keys — the ones we
 * can't derive from the character itself. A shifted symbol shares its base key's
 * `code` and `windowsVirtualKeyCode` (one physical key makes both `2` and `@`),
 * which is exactly what a real keyboard reports. Letters, digits, and Enter are
 * handled programmatically in keyInfo().
 */
const SYMBOL_KEYS: Record<string, { code: string; vk: number }> = {
  " ": { code: "Space", vk: 32 },
  "`": { code: "Backquote", vk: 192 }, "~": { code: "Backquote", vk: 192 },
  "-": { code: "Minus", vk: 189 }, "_": { code: "Minus", vk: 189 },
  "=": { code: "Equal", vk: 187 }, "+": { code: "Equal", vk: 187 },
  "[": { code: "BracketLeft", vk: 219 }, "{": { code: "BracketLeft", vk: 219 },
  "]": { code: "BracketRight", vk: 221 }, "}": { code: "BracketRight", vk: 221 },
  "\\": { code: "Backslash", vk: 220 }, "|": { code: "Backslash", vk: 220 },
  ";": { code: "Semicolon", vk: 186 }, ":": { code: "Semicolon", vk: 186 },
  "'": { code: "Quote", vk: 222 }, "\"": { code: "Quote", vk: 222 },
  ",": { code: "Comma", vk: 188 }, "<": { code: "Comma", vk: 188 },
  ".": { code: "Period", vk: 190 }, ">": { code: "Period", vk: 190 },
  "/": { code: "Slash", vk: 191 }, "?": { code: "Slash", vk: 191 },
  // Shifted digit row — code/vk of the underlying digit key.
  "!": { code: "Digit1", vk: 49 }, "@": { code: "Digit2", vk: 50 },
  "#": { code: "Digit3", vk: 51 }, "$": { code: "Digit4", vk: 52 },
  "%": { code: "Digit5", vk: 53 }, "^": { code: "Digit6", vk: 54 },
  "&": { code: "Digit7", vk: 55 }, "*": { code: "Digit8", vk: 56 },
  "(": { code: "Digit9", vk: 57 }, ")": { code: "Digit0", vk: 48 },
};

/**
 * Resolve one character to a well-formed keystroke: the DOM `key`, the physical
 * `code`, the legacy `windowsVirtualKeyCode` (`vk`), and the `text` to commit.
 * Filling these in is the whole point — a bare `text`-only key event leaves
 * `KeyboardEvent.keyCode === 0` and `code === ""`, which breaks keydown-driven
 * UIs and is a hard bot-tell on login forms. Letters, digits, Enter and the US
 * symbol keys are covered; anything else (accented/CJK/emoji) degrades to a
 * plain text commit, the way an IME delivers a composed character.
 */
export function keyInfo(ch: string): { key: string; code: string; vk: number; text: string } {
  if (ch === "\n" || ch === "\r") return { key: "Enter", code: "Enter", vk: 13, text: "\r" };
  if (/^[a-z]$/i.test(ch)) {
    const upper = ch.toUpperCase();
    return { key: ch, code: `Key${upper}`, vk: upper.charCodeAt(0), text: ch };
  }
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), text: ch };
  const sym = SYMBOL_KEYS[ch];
  if (sym) return { key: ch, code: sym.code, vk: sym.vk, text: ch };
  return { key: ch, code: "", vk: 0, text: ch };
}

export class Page {
  private rng = new Rng();
  private mouse: Point = { x: 100, y: 100 };
  private refs = new Map<number, { backendNodeId: number; center: Point }>();
  private closed = false;
  // Cross-origin iframe support: CDP site-isolates a cross-origin child frame into
  // its own renderer target ("OOPIF"), invisible to Accessibility/Runtime/Input
  // commands sent on the main page's session — the #1 wall a drag-and-drop page
  // builder (GHL, Webflow, etc.) hits, since the whole canvas is one child iframe.
  // Target.setAutoAttach (scoped to this page's own session) discovers those child
  // targets and hands us a session for each; `activeSessionId` is a single "which
  // session do commands go to" pointer that every existing method already goes
  // through via send(), so useFrame() retargets snapshot/click/fill/eval/type for
  // free without duplicating each method.
  private activeSessionId: string;
  private frameSessions: Array<{ sessionId: string; url: string; targetId: string }> = [];
  private frameOff?: () => void;
  // FedCM interception state (see enableFedCm).
  private fedcmOff?: () => void;
  private fedcmQueue: FedCmDialog[] = [];
  private fedcmWaiters: Array<(d: FedCmDialog) => void> = [];
  private lastFedcmDialogId?: string;
  // Fetch-interception state. The private-network guard and resource blocking
  // share ONE requestPaused handler: two independent handlers would both try to
  // answer the same paused request and the second continue/fail fails with
  // "Invalid InterceptionId". applyFetchInterception() reconciles both.
  private blockPrivateOn = false;
  // The active coherent identity, if applyFingerprint()/launch({fingerprint}) set one.
  private fingerprint?: Fingerprint;
  private blockedResourceTypes = new Set<string>(); // CDP ResourceType values, e.g. "Image"
  private blockedUrlSubstrings: string[] = [];
  private fetchOff?: () => void; // tears down the shared requestPaused + frameNavigated listeners
  private mainFrameId?: string;
  private topPrivate = false; // is the page's own top-level origin private?

  constructor(
    private cdp: CDP,
    public readonly sessionId: string,
    private targetId?: string,
  ) {
    this.activeSessionId = sessionId;
  }

  /** Enable the domains we use and arm stealth injection on every document. */
  async init(opts: { maskWebgl?: boolean; blockPrivateNetwork?: boolean; fingerprint?: Fingerprint } = {}) {
    await this.send("Page.enable");
    await this.send("DOM.enable");
    await this.send("Accessibility.enable");
    // A fingerprint owns the UA + client hints; without one, just scrub any
    // leaked HeadlessChrome token from the real UA.
    if (!opts.fingerprint) await this.normalizeUserAgent();
    // Inject stealth before any page script runs, on every navigation/frame.
    // Only mask WebGL on SwiftShader hosts; with a real GPU the authentic vendor
    // is consistent and masking it would be a detectable lie.
    const source = buildStealth({ maskWebgl: opts.maskWebgl ?? false });
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source });
    // Apply the fingerprint AFTER the base stealth so its masked getters win over
    // any self-gating backfill, and before the first navigation.
    if (opts.fingerprint) await this.applyFingerprint(opts.fingerprint);
    if (opts.blockPrivateNetwork) await this.blockPrivateNetwork();
    // Auto-attach to cross-origin child iframes of THIS page (scoped by sessionId
    // on the command envelope, same as every other domain-enable here) so their
    // Accessibility/Runtime/Input traffic becomes reachable via useFrame().
    await this.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    const offAttach = this.cdp.on(
      "Target.attachedToTarget",
      (p: any) => {
        if (p.targetInfo?.type === "iframe") {
          this.frameSessions.push({ sessionId: p.sessionId, url: p.targetInfo.url, targetId: p.targetInfo.targetId });
        }
      },
      "*", // the event's own sessionId varies by Chrome version; match any and filter by type
    );
    // Prune child sessions when their iframe unmounts or navigates away, so
    // frames() never lists a dead frame and useFrame() can't retarget to a
    // destroyed session. detachedFromTarget carries the sessionId; targetDestroyed
    // only the targetId — handle both.
    const offDetach = this.cdp.on(
      "Target.detachedFromTarget",
      (p: any) => { if (p.sessionId) this.removeFrameSession((f) => f.sessionId === p.sessionId); },
      "*",
    );
    const offDestroyed = this.cdp.on(
      "Target.targetDestroyed",
      (p: any) => { if (p.targetId) this.removeFrameSession((f) => f.targetId === p.targetId); },
      "*",
    );
    this.frameOff = () => { offAttach(); offDetach(); offDestroyed(); };
  }

  /** Drop a dead child-frame session (its iframe unmounted or navigated). If it
   *  was the active target, fall back to the main page and clear now-meaningless
   *  refs so the next call errors cleanly instead of acting on a stale frame. */
  private removeFrameSession(match: (f: { sessionId: string; targetId: string }) => boolean) {
    const i = this.frameSessions.findIndex(match);
    if (i < 0) return;
    const [gone] = this.frameSessions.splice(i, 1);
    if (gone && this.activeSessionId === gone.sessionId) {
      this.activeSessionId = this.sessionId;
      this.refs.clear();
    }
  }

  /** List discovered cross-origin child iframes (same-origin iframes don't need
   *  this — they're already visible to the main session's Accessibility tree). */
  async frames(): Promise<Array<{ index: number; url: string }>> {
    return this.frameSessions.map((f, i) => ({ index: i + 1, url: f.url }));
  }

  /** Point every subsequent snapshot/click/fill/type/eval call at a child iframe
   *  (index from frames()), or back at the main page with null/undefined. Clears
   *  refs — a snapshot ref is only ever valid for the frame it was taken in. */
  useFrame(index?: number | null) {
    this.refs.clear();
    if (index == null) {
      this.activeSessionId = this.sessionId;
      return;
    }
    const f = this.frameSessions[index - 1];
    if (!f) throw new Error(`useFrame: no frame at index ${index} — call frames() first (found ${this.frameSessions.length})`);
    this.activeSessionId = f.sessionId;
  }

  /**
   * Inject cookies before navigating — e.g. a logged-in session transferred
   * from another browser. Each cookie is a CDP CookieParam ({name, value,
   * domain, path, secure, httpOnly, expires?, sameSite?}). Lets the browser
   * ride an existing session instead of re-doing a bot-walled login.
   */
  async setCookies(cookies: Array<Record<string, any>>) {
    await this.send("Network.enable");
    await this.send("Network.setCookies", { cookies });
  }

  /**
   * Read the browser's current cookies (the symmetric counterpart to
   * setCookies) — e.g. to export a session established interactively and reuse
   * it elsewhere. Each entry is a CDP Cookie ({name, value, domain, path,
   * expires, size, httpOnly, secure, session, sameSite?, ...}). With no `urls`,
   * returns the cookies visible to the frames the page is currently on; pass
   * `urls` to scope the read to specific origins.
   */
  async getCookies(urls?: string[]): Promise<Array<Record<string, any>>> {
    await this.send("Network.enable");
    const { cookies } = await this.send("Network.getCookies", urls ? { urls } : {});
    return cookies ?? [];
  }

  /**
   * Scrub the "HeadlessChrome" token from the UA and the matching client-hint
   * brands. headless=new leaks it in both navigator.userAgent AND the Sec-CH-UA
   * request headers; setUserAgentOverride with metadata fixes both at once. A
   * no-op for headful Chrome, whose UA is already clean.
   */
  private async normalizeUserAgent() {
    const realUA = await this.evaluate<string>("navigator.userAgent");
    const cleanUA = realUA.replace("HeadlessChrome", "Chrome");
    if (cleanUA === realUA) return;
    await this.applyUserAgentOverride(cleanUA);
  }

  /** Set navigator.userAgent AND the matching Sec-CH-UA client-hint brands
   *  consistently — a UA string without the aligned hints is itself a tell.
   *  Shared by init's HeadlessChrome scrub and the public setUserAgent(). */
  private async applyUserAgentOverride(ua: string) {
    const major = (ua.match(/Chrome\/(\d+)/)?.[1]) ?? "148";
    await this.send("Emulation.setUserAgentOverride", {
      userAgent: ua,
      acceptLanguage: "en-US,en;q=0.9",
      platform: "Linux x86_64",
      userAgentMetadata: {
        brands: [
          { brand: "Chromium", version: major },
          { brand: "Google Chrome", version: major },
          { brand: "Not?A_Brand", version: "99" },
        ],
        fullVersion: `${major}.0.0.0`,
        platform: "Linux",
        platformVersion: "6.8.0",
        architecture: "x86",
        model: "",
        mobile: false,
      },
    });
  }

  /**
   * Override the User-Agent at runtime, keeping the Sec-CH-UA client-hint brands
   * aligned with it (reuses init's normalization path — a bare UA string with
   * mismatched hints is a fingerprint tell). Applies to subsequent requests.
   */
  async setUserAgent(userAgent: string) {
    await this.applyUserAgentOverride(userAgent);
  }

  /**
   * Apply a coherent {@link Fingerprint} to this page. Two layers (see
   * fingerprint.ts): the CLEAN browser-level CDP overrides — UA + the full
   * `userAgentMetadata` client hints + the legacy `navigator.platform`, and the
   * screen dimensions + `devicePixelRatio` — plus a masked page-level getter
   * script for the values CDP can't reach (`hardwareConcurrency`, `deviceMemory`,
   * `languages`, and `screen.avail*` / colour depth).
   *
   * Coherence is the whole point: every derived value (client-hint platform,
   * brand versions, Accept-Language) is computed FROM the profile, so the UA,
   * client hints, `navigator.platform` and screen can't drift out of agreement —
   * an inconsistency between them is itself a detection signal.
   *
   * Apply it BEFORE the first navigation for full effect: the injected getters
   * take hold on the next document, the CDP overrides on subsequent requests.
   * `Browser.launch({ fingerprint })` wires this in automatically at page
   * creation. (Timezone/locale/geolocation and WebGL/canvas/audio noise are
   * layered on by later methods.)
   */
  async applyFingerprint(fp: Fingerprint) {
    this.fingerprint = fp;
    // 1. UA + client hints. The top-level `platform` ALSO sets the legacy
    //    navigator.platform, so it needs no injected getter (cleaner — a
    //    browser-level value has no getter a page can unmask).
    await this.send("Emulation.setUserAgentOverride", {
      userAgent: fp.userAgent,
      acceptLanguage: buildAcceptLanguage(fp.languages),
      platform: fp.platform,
      userAgentMetadata: buildClientHints(fp),
    });
    // 2. screen dimensions + devicePixelRatio, WITHOUT touching the viewport
    //    (width/height:0 leave window.innerWidth/Height alone). availWidth/
    //    availHeight/colorDepth aren't settable this way — the injected getters
    //    below carry them.
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: 0,
      height: 0,
      deviceScaleFactor: fp.devicePixelRatio,
      mobile: fp.mobile,
      screenWidth: fp.screen.width,
      screenHeight: fp.screen.height,
    });
    // 3. the masked page-level getter layer, armed on every future document.
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: buildFingerprintStealth(fp) });
  }

  /**
   * Set the viewport (and optionally device pixel ratio / mobile emulation) via
   * Emulation.setDeviceMetricsOverride — the page sees this as its
   * window.innerWidth/Height, screen size, and devicePixelRatio. Use it to
   * emulate a phone (`{width:390,height:844,deviceScaleFactor:3,mobile:true}`)
   * or force a fixed desktop size for reproducible screenshots.
   */
  async setViewport(opts: { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean }) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: opts.deviceScaleFactor ?? 1,
      mobile: opts.mobile ?? false,
    });
  }

  /** Commands go to whichever session is "active" — the main page by default,
   *  or a child iframe's own session after useFrame(). */
  private send<T = any>(method: string, params: Record<string, any> = {}) {
    return this.cdp.send<T>(method, params, this.activeSessionId);
  }

  /** Navigate and wait. Always the main page, regardless of any active useFrame()
   *  — top-level navigation isn't a per-frame concept. `waitUntil` is "load"
   *  (default) or "networkidle" (no network for ~500ms — better for SPAs that
   *  fetch after the load event). Reset ref/session state so a prior useFrame()
   *  can't leak across the nav and a leftover ref can't click wrong coords. */
  async goto(
    url: string,
    opts: { timeout?: number; waitUntil?: "load" | "networkidle" } = {},
  ): Promise<{ url: string; status?: number; ok?: boolean }> {
    this.refs.clear();
    this.activeSessionId = this.sessionId;
    const timeout = opts.timeout ?? 30000;
    // Capture the main document's HTTP status so callers can detect 4xx/5xx: match
    // the Document response to THIS navigation's loaderId (redirects keep the
    // loaderId, so the final hop's status wins). Needs the Network domain enabled.
    await this.cdp.send("Network.enable", {}, this.sessionId).catch(() => {});
    const docStatus = new Map<string, number>(); // loaderId -> HTTP status
    const offResp = this.cdp.on(
      "Network.responseReceived",
      (p: any) => { if (p.type === "Document" && p.loaderId) docStatus.set(p.loaderId, p.response?.status); },
      this.sessionId,
    );
    let loaderId: string | undefined;
    try {
      // Arm the waiter BEFORE navigating: we can't miss loadEventFired, and a
      // networkidle waiter is already counting the navigation's own requests.
      const waiter = this.waitForLoad(opts.waitUntil ?? "load", timeout);
      // Page.navigate resolves with { frameId, loaderId, errorText? }. On a DNS or
      // connection failure Chrome STILL fires loadEventFired for its own error page,
      // so the load event alone can't tell success from failure — errorText can.
      const nav = await this.cdp.send<{ errorText?: string; loaderId?: string }>("Page.navigate", { url }, this.sessionId);
      if (nav?.errorText) {
        waiter.catch(() => {}); // we're bailing; swallow the pending waiter rejection
        throw new Error(`goto(${url}) failed: ${nav.errorText}`);
      }
      loaderId = nav?.loaderId;
      await waiter;
    } finally {
      offResp();
    }
    await sleep(this.rng.range(150, 400)); // settle, like a human reading
    // status stays undefined only when no Document response is observed for this
    // loaderId (e.g. about:blank) — additive, so callers that ignore it are fine.
    const status = loaderId ? docStatus.get(loaderId) : undefined;
    return { url, status, ok: status == null ? undefined : status >= 200 && status < 400 };
  }

  /** Reload the current page (Page.reload), waiting per `waitUntil`. */
  async reload(opts: { timeout?: number; waitUntil?: "load" | "networkidle" } = {}) {
    this.refs.clear();
    this.activeSessionId = this.sessionId;
    const waiter = this.waitForLoad(opts.waitUntil ?? "load", opts.timeout ?? 30000);
    await this.cdp.send("Page.reload", {}, this.sessionId);
    await waiter;
    await sleep(this.rng.range(150, 400));
  }

  /** Go back one entry in session history. Throws if there's nothing earlier. */
  async back(opts: { timeout?: number; waitUntil?: "load" | "networkidle" } = {}) {
    await this.historyGo(-1, opts);
  }

  /** Go forward one entry in session history. Throws if there's nothing later. */
  async forward(opts: { timeout?: number; waitUntil?: "load" | "networkidle" } = {}) {
    await this.historyGo(1, opts);
  }

  /** Navigate `delta` entries through session history via
   *  Page.navigateToHistoryEntry (precise, and lets us reject cleanly when the
   *  target entry doesn't exist instead of silently no-op'ing like history.go). */
  private async historyGo(delta: -1 | 1, opts: { timeout?: number; waitUntil?: "load" | "networkidle" }) {
    const { currentIndex, entries } = await this.cdp.send<{ currentIndex: number; entries: Array<{ id: number; url: string }> }>(
      "Page.getNavigationHistory", {}, this.sessionId,
    );
    const target = entries?.[currentIndex + delta];
    if (!target) throw new Error(delta < 0 ? "back(): no earlier history entry" : "forward(): no later history entry");
    this.refs.clear();
    this.activeSessionId = this.sessionId;
    const waiter = this.waitForLoad(opts.waitUntil ?? "load", opts.timeout ?? 30000);
    await this.cdp.send("Page.navigateToHistoryEntry", { entryId: target.id }, this.sessionId);
    await waiter;
    await sleep(this.rng.range(150, 400));
  }

  /** Resolve when the page finishes loading, per the `waitUntil` strategy. */
  private waitForLoad(waitUntil: "load" | "networkidle", timeout: number): Promise<void> {
    if (waitUntil === "networkidle") return this.waitForNetworkIdle(timeout);
    return this.cdp.once("Page.loadEventFired", { sessionId: this.sessionId, timeout }).then(() => {});
  }

  /** Resolve once no network request has been in flight for `idleMs`, or reject
   *  after `timeout`. Tracks in-flight requests over the Network domain — the
   *  right signal for SPAs whose content arrives after the load event. */
  private waitForNetworkIdle(timeout: number, idleMs = 500): Promise<void> {
    // Enable Network first (idempotent); listeners below are registered
    // synchronously so no event is missed once it takes effect.
    this.cdp.send("Network.enable", {}, this.sessionId).catch(() => {});
    return new Promise<void>((resolve, reject) => {
      let inflight = 0;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        clearTimeout(hardTimer);
        offReq(); offFin(); offFail();
        err ? reject(err) : resolve();
      };
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => settle(), idleMs);
      };
      const onReq = () => { inflight++; clearTimeout(idleTimer); };
      const onDone = () => { inflight = Math.max(0, inflight - 1); if (inflight === 0) armIdle(); };
      const offReq = this.cdp.on("Network.requestWillBeSent", onReq, this.sessionId);
      const offFin = this.cdp.on("Network.loadingFinished", onDone, this.sessionId);
      const offFail = this.cdp.on("Network.loadingFailed", onDone, this.sessionId);
      const hardTimer = setTimeout(() => settle(new Error(`waitUntil networkidle: timed out after ${timeout}ms`)), timeout);
      armIdle(); // start the idle window; the navigation's first request cancels it
    });
  }

  /** Evaluate JS in the page WITHOUT Runtime.enable (avoids the CDP tell).
   *  Bounded by `timeout` (default 30s): a wedged renderer — or an
   *  awaitPromise expression that never settles — otherwise leaves this pending
   *  forever, so we race the CDP send against a timer and reject cleanly. */
  async evaluate<T = any>(expression: string, opts: { timeout?: number } = {}): Promise<T> {
    const timeout = opts.timeout ?? 30000;
    let r: any;
    try {
      r = await this.cdp.send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        this.activeSessionId,
        timeout,
      );
    } catch (e: any) {
      if (String(e?.message ?? "").includes("timed out")) {
        throw new Error(`evaluate: timed out after ${timeout}ms (page wedged?)`);
      }
      throw e;
    }
    if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.text}`);
    return r.result?.value as T;
  }

  async url(): Promise<string> {
    return this.evaluate<string>("location.href");
  }

  /** Build the numbered element index from the accessibility tree. */
  async snapshot(): Promise<Snapshot> {
    const { nodes } = await this.send("Accessibility.getFullAXTree");
    this.refs.clear();
    const elements: Element[] = [];
    let ref = 0;

    for (const n of nodes) {
      if (n.ignored) continue;
      const role: string = n.role?.value ?? "";
      const name: string = (n.name?.value ?? "").trim();
      if (!INTERESTING.has(role)) continue;
      if (!name && role !== "textbox" && role !== "searchbox" && role !== "textarea") continue;
      const backendNodeId = n.backendDOMNodeId;
      if (!backendNodeId) continue;

      const center = await this.boxCenter(backendNodeId);
      if (!center) continue; // not visible / no layout box

      ref++;
      const value: string | undefined = n.value?.value;
      this.refs.set(ref, { backendNodeId, center });
      elements.push({ ref, role, name, value, center });
    }

    const [url, title] = await Promise.all([
      this.evaluate<string>("location.href"),
      this.evaluate<string>("document.title"),
    ]);
    const text = elements
      .map((e) => `[${e.ref}] ${e.role} ${JSON.stringify(e.name)}${e.value ? ` =${JSON.stringify(e.value)}` : ""}`)
      .join("\n");
    return { url, title, text, elements };
  }

  private async boxCenter(backendNodeId: number): Promise<Point | null> {
    try {
      const { model } = await this.send("DOM.getBoxModel", { backendNodeId });
      const q = model.content as number[]; // [x1,y1, x2,y2, x3,y3, x4,y4]
      const x = (q[0] + q[2] + q[4] + q[6]) / 4;
      const y = (q[1] + q[3] + q[5] + q[7]) / 4;
      if ((model.width ?? 0) <= 0 || (model.height ?? 0) <= 0) return null;
      return { x, y };
    } catch {
      return null;
    }
  }

  /** Move the cursor along a human curve to a target point. `buttons` mirrors
   *  CDP's bitmask (1 = left button down) — pass 1 while dragging so the move
   *  itself carries mousemove-with-button-held events a drag-and-drop library
   *  listens for, not plain hover moves. */
  private async moveTo(target: Point, buttons: 0 | 1 = 0) {
    const path = mousePath(this.mouse, target, this.rng);
    for (const p of path) {
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: p.x,
        y: p.y,
        buttons,
      });
      await sleep(moveDelay(this.rng));
    }
    this.mouse = target;
  }

  /** Click an element by its snapshot ref. */
  async click(ref: number) {
    const target = this.refs.get(ref);
    if (!target) throw new Error(`No element with ref ${ref}. Call snapshot() first.`);
    await this.moveTo(target.center);
    await sleep(this.rng.range(30, 90));
    const common = { x: target.center.x, y: target.center.y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...common });
    await sleep(this.rng.range(40, 110)); // press dwell
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...common });
  }

  /**
   * Drag from one point to another. Many drag-drop site/page builders (GHL,
   * Webflow, most "drag a card onto a canvas" UIs) use pointer-based DnD
   * libraries that key off real mousedown -> mousemove(button held) -> mouseup,
   * not the legacy HTML5 dragstart/drop events, or any semantic role an a11y
   * tree would expose — click() alone can't reach these; this can. Both ends
   * are viewport coordinates, since the draggable card AND its drop target are
   * usually plain divs with no accessible ref of their own — read them off a
   * veil_screenshot.
   */
  private async dragCore(fromX: number, fromY: number, toX: number, toY: number) {
    await this.moveTo({ x: fromX, y: fromY });
    await sleep(this.rng.range(30, 90));
    const downCommon = { x: fromX, y: fromY, button: "left" as const, clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...downCommon });
    await sleep(this.rng.range(40, 100)); // dwell so the library's own drag-start threshold fires
    await this.moveTo({ x: toX, y: toY }, 1); // move WITH the button held — this is what a DnD listener sees as "dragging"
    await sleep(this.rng.range(40, 100));
    const upCommon = { x: toX, y: toY, button: "left" as const, clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...upCommon });
  }

  /** Drag an element by snapshot ref to an absolute viewport point. */
  async dragRefTo(ref: number, toX: number, toY: number) {
    const from = this.refs.get(ref);
    if (!from) throw new Error(`No element with ref ${ref}. Call snapshot() first.`);
    await this.dragCore(from.center.x, from.center.y, toX, toY);
  }

  /** Drag between two absolute viewport points — for when neither the source
   *  card nor the drop target has a resolvable snapshot ref. */
  async dragAt(fromX: number, fromY: number, toX: number, toY: number) {
    await this.dragCore(fromX, fromY, toX, toY);
  }

  /** Bring this page's target to the foreground — CDP Input only routes to the active target. */
  async bringToFront() {
    await this.send("Page.bringToFront");
  }

  /** Trusted click at absolute viewport coords (when you can't resolve a snapshot ref). */
  async clickAt(x: number, y: number) {
    await this.moveTo({ x, y });
    await sleep(this.rng.range(30, 90));
    const common = { x, y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...common });
    await sleep(this.rng.range(40, 110));
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...common });
  }

  /**
   * Dispatch one well-formed key: rawKeyDown, then a `char` event only if the
   * key produces text, then keyUp (no text) — the exact shape press() relies on,
   * always carrying key/code/windowsVirtualKeyCode/nativeVirtualKeyCode so the
   * page never sees a `keyCode === 0` bot-tell. `modifiers` is a CDP bitfield
   * (Alt 1, Ctrl 2, Meta 4, Shift 8) for shortcuts like Ctrl+A.
   */
  private async sendKey(opts: { key: string; code: string; vk: number; text?: string; modifiers?: number }) {
    const base = {
      key: opts.key,
      code: opts.code,
      windowsVirtualKeyCode: opts.vk,
      nativeVirtualKeyCode: opts.vk,
      ...(opts.modifiers ? { modifiers: opts.modifiers } : {}),
    };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, ...(opts.text ? { text: opts.text } : {}) });
    if (opts.text) await this.send("Input.dispatchKeyEvent", { type: "char", ...base, text: opts.text });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /**
   * Scroll the page by a pixel delta via a real mouse-wheel event dispatched at
   * the current cursor position (positive dy scrolls down, positive dx right).
   * Use it to reveal lazy-loaded / off-screen content before snapshot().
   */
  async scroll(dx: number, dy: number) {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: this.mouse.x,
      y: this.mouse.y,
      deltaX: dx,
      deltaY: dy,
    });
    await sleep(this.rng.range(80, 200)); // settle, like a human watching content load
  }

  /** Type text into the focused element with human cadence. Each character is
   *  dispatched as a real keydown/char/keyUp with the right key, code, and
   *  virtual-key code (see keyInfo) — the bare text-only events this used to send
   *  read as keyCode===0 and broke keydown-driven login forms. */
  async type(text: string) {
    for (const ch of text) {
      const k = keyInfo(ch);
      await this.sendKey({ key: k.key, code: k.code, vk: k.vk, text: k.text });
      await sleep(keyDelay(this.rng, ch));
    }
  }

  /** Clear the focused field: select-all (Ctrl+A) then Delete, via the Input
   *  domain like the rest of our key dispatch. Playwright's fill() clears first;
   *  without this, filling a pre-populated input yields "oldnewvalue". */
  private async clearField() {
    await this.sendKey({ key: "a", code: "KeyA", vk: 65, modifiers: 2 }); // Ctrl+A → select all
    await this.sendKey({ key: "Delete", code: "Delete", vk: 46 });        // delete the selection
  }

  /** Click a field, clear any existing value, then type into it. */
  async fill(ref: number, text: string) {
    await this.click(ref);
    await sleep(this.rng.range(60, 160));
    await this.clearField();
    await this.type(text);
  }

  /** Resolve a snapshot ref to a live JS object handle (objectId) — the bridge
   *  from an accessibility-tree ref to callFunctionOn, so we can read/drive one
   *  specific element instead of the whole page. */
  private async resolveRefObject(ref: number): Promise<string> {
    const target = this.refs.get(ref);
    if (!target) throw new Error(`No element with ref ${ref}. Call snapshot() first.`);
    const { object } = await this.send("DOM.resolveNode", { backendNodeId: target.backendNodeId });
    if (!object?.objectId) throw new Error(`Could not resolve ref ${ref} to a live node (it may have detached).`);
    return object.objectId;
  }

  /** Call a function with `this` bound to the element behind a snapshot ref and
   *  return its by-value result. Uses Runtime.callFunctionOn (no Runtime.enable
   *  needed) and always releases the node handle so it can't leak. */
  private async callOnRef<T = any>(ref: number, fn: string, args: any[] = []): Promise<T> {
    const objectId = await this.resolveRefObject(ref);
    try {
      const r = await this.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: fn,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "callFunctionOn failed");
      }
      return r.result?.value as T;
    } finally {
      this.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }

  /**
   * Set a `<select>` (resolved from a snapshot ref) to `value` and fire the
   * `input` + `change` events a framework listens for — the reliable way to
   * drive a native dropdown, which a click()+type() can't. `value` matches an
   * option's `value`, then its visible label/text. Returns the select's
   * resulting value; throws if the ref isn't a `<select>` or nothing matched.
   */
  async select(ref: number, value: string): Promise<string> {
    return this.callOnRef<string>(
      ref,
      `function(v){
        if (this.tagName !== "SELECT") throw new Error("select: ref <" + this.tagName.toLowerCase() + "> is not a <select>");
        let matched = false;
        for (const opt of this.options) {
          const hit = opt.value === v || opt.label === v || opt.text === v;
          opt.selected = hit;
          if (hit) matched = true;
        }
        if (!matched) throw new Error("select: no <option> matching " + JSON.stringify(v));
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return this.value;
      }`,
      [value],
    );
  }

  /**
   * Read one element's rendered text (innerText, falling back to textContent)
   * by snapshot ref. Agents often want a single element's text — a price, a
   * status, a result cell — not the whole-page innerText() dump.
   */
  async text(ref: number): Promise<string> {
    return this.callOnRef<string>(ref, `function(){ return this.innerText ?? this.textContent ?? ""; }`);
  }

  /**
   * Read one attribute of an element by snapshot ref (e.g. `href`, `value`,
   * `aria-label`, a `data-*`). Returns the raw attribute string, or null if the
   * element has no such attribute.
   */
  async attribute(ref: number, name: string): Promise<string | null> {
    return this.callOnRef<string | null>(ref, `function(n){ return this.getAttribute(n); }`, [name]);
  }

  /**
   * Capture a PNG screenshot (Buffer) — feed to a vision model. Always the main
   * page's viewport (Page.captureScreenshot isn't a per-frame concept), regardless
   * of any active useFrame(). Scope options (mutually exclusive; `ref` wins, then
   * `clip`, then `fullPage`):
   *   - `{ ref }`      just that element's bounding box (from DOM.getBoxModel).
   *   - `{ clip }`     an explicit page-coordinate rectangle {x,y,width,height}.
   *   - `{ fullPage }` the whole scrollable page, not just the viewport.
   * Default (no options): the current viewport.
   */
  async screenshot(
    opts: { fullPage?: boolean; ref?: number; clip?: { x: number; y: number; width: number; height: number } } = {},
  ): Promise<Buffer> {
    const params: any = { format: "png" };
    if (opts.ref != null) {
      const target = this.refs.get(opts.ref);
      if (!target) throw new Error(`No element with ref ${opts.ref}. Call snapshot() first.`);
      const { model } = await this.send("DOM.getBoxModel", { backendNodeId: target.backendNodeId });
      const q = model.border as number[]; // border box: [x1,y1, x2,y2, x3,y3, x4,y4]
      const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
      const x = Math.min(...xs), y = Math.min(...ys);
      params.clip = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, scale: 1 };
      params.captureBeyondViewport = true; // element may be scrolled out of the viewport
    } else if (opts.clip) {
      params.clip = { ...opts.clip, scale: 1 };
      params.captureBeyondViewport = true;
    } else if (opts.fullPage) {
      params.captureBeyondViewport = true;
    }
    const { data } = await this.cdp.send("Page.captureScreenshot", params, this.sessionId);
    return Buffer.from(data, "base64");
  }

  /**
   * Render the current page to a PDF (Buffer) via Page.printToPDF. NOTE: Chrome
   * only supports PDF printing in HEADLESS mode — in headful it throws
   * "PrintToPDF is not implemented". Options pass straight through to CDP
   * (landscape, printBackground, scale, paperWidth/Height in inches, margin*,
   * pageRanges, ...); printBackground defaults to true so backgrounds render.
   * Always the main page, like screenshot().
   */
  async pdf(opts: {
    landscape?: boolean;
    printBackground?: boolean;
    scale?: number;
    paperWidth?: number;
    paperHeight?: number;
    marginTop?: number;
    marginBottom?: number;
    marginLeft?: number;
    marginRight?: number;
    pageRanges?: string;
    preferCSSPageSize?: boolean;
  } = {}): Promise<Buffer> {
    const { data } = await this.cdp.send(
      "Page.printToPDF",
      { transferMode: "ReturnAsBase64", printBackground: opts.printBackground ?? true, ...opts },
      this.sessionId,
    );
    return Buffer.from(data, "base64");
  }

  /** Poll an expression until truthy (replaces flaky fixed sleeps). Each probe is
   *  bounded by the time remaining, so a wedged page can't make waitFor overrun
   *  its own timeout — it fails as a waitFor timeout, not a 30s evaluate hang. */
  async waitFor(expression: string, opts: { timeout?: number; poll?: number } = {}) {
    const timeout = opts.timeout ?? 10000;
    const poll = opts.poll ?? 100;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const remaining = timeout - (Date.now() - start);
      try {
        if (await this.evaluate<boolean>(`!!(${expression})`, { timeout: remaining })) return;
      } catch (e: any) {
        // A wedged page makes the probe time out — that's a waitFor timeout, not a
        // crash. Any other evaluate error (e.g. a bad expression) propagates.
        if (String(e?.message ?? "").includes("timed out")) break;
        throw e;
      }
      await sleep(poll);
    }
    throw new Error(`waitFor timed out: ${expression}`);
  }

  /**
   * Poll until a CSS selector matches — the selector-shaped convenience over
   * waitFor(), for the common "wait for this element to appear" case. With
   * {visible:true} it also requires a non-zero layout box and a visible
   * computed style (not display:none / visibility:hidden), so an element that
   * exists in the DOM but is still hidden doesn't resolve early. Throws a
   * selector-named error on timeout.
   */
  async waitForSelector(
    selector: string,
    opts: { timeout?: number; visible?: boolean; poll?: number } = {},
  ): Promise<void> {
    const timeout = opts.timeout ?? 10000;
    const visible = opts.visible ?? false;
    const sel = JSON.stringify(selector);
    const expr = visible
      ? `(() => { const el = document.querySelector(${sel}); if (!el) return false;` +
        ` const r = el.getBoundingClientRect(); const s = getComputedStyle(el);` +
        ` return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; })()`
      : `document.querySelector(${sel})`;
    try {
      await this.waitFor(expr, { timeout, poll: opts.poll });
    } catch (e: any) {
      if (String(e?.message ?? "").includes("waitFor timed out")) {
        throw new Error(`waitForSelector: "${selector}" not found${visible ? " (visible)" : ""} within ${timeout}ms`);
      }
      throw e;
    }
  }

  /**
   * Attach local files to a file `<input>` — even a hidden one — without an OS
   * file picker. Uses CDP DOM.setFileInputFiles (the same primitive Playwright
   * uses under the hood), which sets `input.files` and fires `change` directly.
   * `selector` defaults to the first file input; pass a more specific one if the
   * page has several. Paths must be absolute.
   */
  async uploadFile(paths: string[], selector = 'input[type="file"]') {
    const { root } = await this.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await this.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    });
    if (!nodeId) throw new Error(`uploadFile: no element matching ${selector}`);
    await this.send("DOM.setFileInputFiles", { files: paths, nodeId });
  }

  /**
   * Attach files through a control that opens a file picker (e.g. an "Upload
   * files" menu item) WITHOUT an OS dialog. Intercepts the chooser via CDP,
   * clicks the trigger, then feeds the paths to the input it opened for. This is
   * the path for SPAs (like Gemini) that create the `<input>` lazily on click.
   * Paths must be absolute.
   */
  async uploadViaPicker(triggerRef: number, paths: string[], opts: { timeout?: number } = {}) {
    await this.send("Page.setInterceptFileChooserDialog", { enabled: true });
    try {
      // Listen on any session — the chooser event can arrive without our page
      // sessionId attached, which silently filtered it out before.
      const chooser = this.cdp.once("Page.fileChooserOpened", {
        timeout: opts.timeout ?? 15000,
      });
      await this.click(triggerRef);
      const ev = await chooser;
      await this.send("DOM.setFileInputFiles", { files: paths, backendNodeId: ev.backendNodeId });
    } finally {
      await this.send("Page.setInterceptFileChooserDialog", { enabled: false });
    }
  }

  /** Read the page's visible text (for scraping a model response, etc.). */
  async innerText(): Promise<string> {
    return this.evaluate<string>("document.body ? document.body.innerText : ''");
  }

  /** Press a single named key on the focused element (Enter, Tab, Escape, arrows...). */
  async press(key: string) {
    const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
      Enter: { code: "Enter", vk: 13, text: "\r" },
      Tab: { code: "Tab", vk: 9 },
      Escape: { code: "Escape", vk: 27 },
      Backspace: { code: "Backspace", vk: 8 },
      ArrowDown: { code: "ArrowDown", vk: 40 },
      ArrowUp: { code: "ArrowUp", vk: 38 },
    };
    const k = KEYS[key];
    if (!k) throw new Error(`press: unsupported key ${key}`);
    await this.sendKey({ key, code: k.code, vk: k.vk, text: k.text });
  }

  // --- FedCM: drive federated sign-in ("Sign in with Google" one-tap, etc.) ---
  // Chrome renders FedCM account choosers as native browser UI that no synthetic
  // mouse click can reach (the button is a cross-origin IdP iframe, and the
  // chooser itself is browser chrome). FedCm.enable routes the dialog to us over
  // CDP instead, so an agent can actually complete a federated login.
  // End-to-end run: examples/fedcm.ts.

  /**
   * Start intercepting FedCM on this page. Call it ON DEMAND, right before the
   * sign-in you're driving — never as blanket startup setup. Any page that
   * silently probes FedCM at load (GoHighLevel, many SaaS logins) will HANG if
   * interception is on and nothing resolves the probe, so keep it off until you
   * need it and disableFedCm() afterwards.
   *
   * With {autoSelectFirst:true} (default) veil selects account 0 on every dialog
   * automatically — the one-liner for "just sign me in". Pass false to inspect
   * accounts via waitForFedCmDialog() and choose with selectFedCmAccount().
   */
  async enableFedCm(opts: { autoSelectFirst?: boolean } = {}) {
    const autoSelect = opts.autoSelectFirst ?? true;
    // FedCM is a top-level-page flow: enable it (and every later FedCm.* command)
    // on the MAIN session explicitly, matching the dialogShown listener below —
    // otherwise a useFrame() before sign-in would point these at a child session
    // and the RP's navigator.credentials.get() would hang unresolved.
    await this.cdp.send("FedCm.enable", { disableRejectionDelay: true }, this.sessionId);
    // A prior dismissal drops the IdP into a cooldown where the dialog silently
    // won't reappear; clear it so the next trigger actually shows.
    try { await this.cdp.send("FedCm.resetCooldown", {}, this.sessionId); } catch {}
    if (this.fedcmOff) return;
    this.fedcmOff = this.cdp.on(
      "FedCm.dialogShown",
      (p: any) => {
        const dialog: FedCmDialog = {
          dialogId: p.dialogId,
          type: p.dialogType,
          title: p.title,
          subtitle: p.subtitle,
          accounts: (p.accounts ?? []).map((a: any) => ({
            accountId: a.accountId,
            email: a.email,
            name: a.name,
            givenName: a.givenName,
            idpConfigUrl: a.idpConfigUrl,
          })),
        };
        this.lastFedcmDialogId = dialog.dialogId;
        // Bind selection to THIS session. CDP strips the sessionId off the event
        // params, and selecting on the wrong target leaves the dialog — and the
        // RP page's navigator.credentials.get() — hanging unresolved.
        if (autoSelect && dialog.accounts.length) {
          this.selectFedCmAccount(0, dialog.dialogId).catch(() => {});
        }
        const waiter = this.fedcmWaiters.shift();
        if (waiter) waiter(dialog);
        else this.fedcmQueue.push(dialog);
      },
      this.sessionId,
    );
  }

  /** Resolve with the next FedCM dialog (or one already queued since enable). */
  async waitForFedCmDialog(opts: { timeout?: number } = {}): Promise<FedCmDialog> {
    const queued = this.fedcmQueue.shift();
    if (queued) return queued;
    return new Promise<FedCmDialog>((resolve, reject) => {
      const waiter = (d: FedCmDialog) => {
        clearTimeout(timer);
        resolve(d);
      };
      const timer = setTimeout(() => {
        const i = this.fedcmWaiters.indexOf(waiter);
        if (i >= 0) this.fedcmWaiters.splice(i, 1);
        reject(new Error("waitForFedCmDialog: timed out (is FedCM enabled, and are you signed in to the IdP?)"));
      }, opts.timeout ?? 30000);
      this.fedcmWaiters.push(waiter);
    });
  }

  /** Pick an account in the current FedCM dialog (index into dialog.accounts). */
  async selectFedCmAccount(accountIndex = 0, dialogId = this.lastFedcmDialogId) {
    if (!dialogId) throw new Error("selectFedCmAccount: no FedCM dialog has appeared yet");
    // Target the main session explicitly (not activeSessionId): this also runs
    // from the dialogShown auto-select handler, which can fire after a useFrame().
    await this.cdp.send("FedCm.selectAccount", { dialogId, accountIndex }, this.sessionId);
  }

  /** Dismiss the current FedCM dialog (decline the sign-in). */
  async dismissFedCm(dialogId = this.lastFedcmDialogId) {
    if (!dialogId) return;
    await this.cdp.send("FedCm.dismissDialog", { dialogId, triggerCooldown: false }, this.sessionId);
  }

  /** Stop intercepting FedCM. Call after a sign-in so a later navigation that
   *  probes FedCM isn't left hanging on us. */
  async disableFedCm() {
    this.fedcmOff?.();
    this.fedcmOff = undefined;
    this.fedcmQueue = [];
    this.fedcmWaiters = [];
    try { await this.cdp.send("FedCm.disable", {}, this.sessionId); } catch {}
  }

  /**
   * One call to complete an active federated sign-in: enables FedCM, clicks the
   * "Sign in with Google" button (a snapshot ref), waits for the account
   * chooser, selects an account, and returns it. For passive/one-tap flows that
   * fire on page load, enableFedCm() BEFORE navigating, then
   * waitForFedCmDialog() — the default autoSelectFirst signs you straight in.
   */
  async signInWithFedCm(opts: { triggerRef?: number; accountIndex?: number; timeout?: number } = {}): Promise<FedCmAccount> {
    await this.enableFedCm({ autoSelectFirst: false });
    if (opts.triggerRef != null) await this.click(opts.triggerRef);
    const dialog = await this.waitForFedCmDialog({ timeout: opts.timeout });
    const idx = opts.accountIndex ?? 0;
    const account = dialog.accounts[idx];
    if (!account) throw new Error(`signInWithFedCm: no account at index ${idx} (dialog had ${dialog.accounts.length})`);
    await this.selectFedCmAccount(idx, dialog.dialogId);
    return account;
  }

  /**
   * Stop the page — and any site it loads — from reaching loopback / private
   * hosts. Detectors port-scan 127.0.0.1 from JS to fingerprint the machine's
   * other software (and it leaks your LAN to every site). With this on, each
   * such request is failed UNIFORMLY (same instant error, open port or closed),
   * so the scan can't tell them apart and comes back empty. Only private-host
   * requests are intercepted, so normal browsing keeps its exact timing.
   *
   * Still allowed: the agent's own top-level navigation to a private host
   * (page.goto("http://localhost:3000")), and a localhost page loading its own
   * localhost resources — only a PUBLIC page reaching a private host is blocked.
   */
  async blockPrivateNetwork() {
    if (this.blockPrivateOn) return;
    this.blockPrivateOn = true;
    // Learn the main frame so the handler can tell an agent nav from a page's own
    // probe. (Fetch runs on the MAIN session — see applyFetchInterception.)
    try {
      const { frameTree } = await this.cdp.send("Page.getFrameTree", {}, this.sessionId);
      this.mainFrameId = frameTree?.frame?.id;
      this.topPrivate = isPrivateHost(frameTree?.frame?.url ?? "");
    } catch {}
    await this.applyFetchInterception();
  }

  /** Lift the private-network block (re-allows localhost/LAN requests). Leaves any
   *  resource blocking in place. */
  async unblockPrivateNetwork() {
    if (!this.blockPrivateOn) return;
    this.blockPrivateOn = false;
    await this.applyFetchInterception();
  }

  /**
   * Block resource loads — a big speed and footprint win for scraping. Block by
   * type (`["image","font","media","stylesheet"]`) and/or by URL substring
   * (`{ urls: ["analytics","doubleclick"] }`); matching requests are failed via
   * CDP's Fetch domain. Calls accumulate. Coexists with the private-network guard
   * (both share one interception handler). Lift it all with unblockResources().
   * Types accept friendly names (image, font, media, stylesheet, script, xhr,
   * fetch, document, websocket, ...).
   */
  async blockResources(types: string[] = [], opts: { urls?: string[] } = {}) {
    for (const t of types) {
      const cdpType = RESOURCE_TYPES[t.toLowerCase()];
      if (!cdpType) throw new Error(`blockResources: unknown type "${t}" (known: ${Object.keys(RESOURCE_TYPES).join(", ")})`);
      this.blockedResourceTypes.add(cdpType);
    }
    if (opts.urls) this.blockedUrlSubstrings.push(...opts.urls);
    await this.applyFetchInterception();
  }

  /** Lift resource blocking (leaves the private-network guard untouched). */
  async unblockResources() {
    this.blockedResourceTypes.clear();
    this.blockedUrlSubstrings = [];
    await this.applyFetchInterception();
  }

  /** The union of Fetch patterns for whatever guards are currently active. Only
   *  matching requests get paused, so anything unblocked keeps its exact timing. */
  private fetchPatterns(): Array<Record<string, string>> {
    const patterns: Array<Record<string, string>> = [];
    if (this.blockPrivateOn) patterns.push(...PRIVATE_URL_PATTERNS);
    for (const t of this.blockedResourceTypes) patterns.push({ urlPattern: "*", resourceType: t });
    for (const sub of this.blockedUrlSubstrings) patterns.push({ urlPattern: `*${sub}*` });
    return patterns;
  }

  /** Decide the fate of one paused request against every active guard, in one
   *  place. Commands target this.sessionId explicitly: requestPaused fires on the
   *  MAIN session and may arrive after a useFrame() repointed activeSessionId, and
   *  a continue/fail sent to the wrong session can't find the requestId (hang). */
  private handleFetchPaused(p: any) {
    const url: string = p.request?.url ?? "";
    const rtype: string = p.resourceType ?? "";
    const requestId = p.requestId;
    const respond = (fn: "failRequest" | "continueRequest", extra: Record<string, any> = {}) =>
      this.cdp.send(`Fetch.${fn}`, { requestId, ...extra }, this.sessionId).catch(() => {});
    // 1. Private-network guard: a PUBLIC page reaching a private host (the scan).
    //    Allowed: the agent's own top-level nav, and a private page's own resources.
    if (this.blockPrivateOn && isPrivateHost(url)) {
      const isMainNav = rtype === "Document" && p.frameId === this.mainFrameId;
      if (!isMainNav && !this.topPrivate) return void respond("failRequest", { errorReason: "AccessDenied" });
    }
    // 2. Resource blocking: by CDP resource type or URL substring.
    if (this.blockedResourceTypes.has(rtype) || this.blockedUrlSubstrings.some((s) => url.includes(s))) {
      return void respond("failRequest", { errorReason: "BlockedByClient" });
    }
    return void respond("continueRequest");
  }

  /** (Re)configure the shared Fetch interception for the currently-active guards:
   *  register the single requestPaused + frameNavigated listeners once, enable
   *  Fetch with the union of patterns, and fully tear down when nothing is active. */
  private async applyFetchInterception() {
    const patterns = this.fetchPatterns();
    if (patterns.length === 0) {
      this.fetchOff?.();
      this.fetchOff = undefined;
      try { await this.cdp.send("Fetch.disable", {}, this.sessionId); } catch {}
      return;
    }
    if (!this.fetchOff) {
      const offNav = this.cdp.on(
        "Page.frameNavigated",
        (p: any) => {
          const f = p.frame;
          if (f && !f.parentId) { this.mainFrameId = f.id; this.topPrivate = isPrivateHost(f.url ?? ""); }
        },
        this.sessionId,
      );
      const offFetch = this.cdp.on("Fetch.requestPaused", (p: any) => this.handleFetchPaused(p), this.sessionId);
      this.fetchOff = () => { offNav(); offFetch(); };
    }
    await this.cdp.send("Fetch.enable", { patterns }, this.sessionId);
  }

  /** Close this page and detach its target from the browser. Idempotent. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.refs.clear();
    this.frameOff?.();
    this.fetchOff?.();
    this.frameSessions = [];
    if (this.targetId) {
      try {
        // Target.closeTarget closes the page/target and frees its resources.
        // Send to browser context (no sessionId) since we're closing the target itself.
        await this.cdp.send("Target.closeTarget", { targetId: this.targetId });
      } catch {
        // Target already closed or doesn't exist; this is OK.
      }
    }
    // Clean up any lingering event handlers for this session
    this.cdp.clearHandlers(this.sessionId);
  }
}
