import { buildStealth } from "./stealth.js";
import { buildFingerprintStealth, buildClientHints, buildAcceptLanguage } from "./fingerprint.js";
import { Rng, mousePath, moveDelay, keyDelay, sleep } from "./human.js";
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
/**
 * Is this URL inside the agent's permitted origins?
 *
 * The problem (raised by u/zhonglin on r/AI_Agents): `Browser.connect()` to a
 * signed-in Chrome puts EVERY logged-in session inside the agent's reach. An agent
 * told "check my Amazon order" can navigate to mail.google.com and read the mailbox,
 * because it is the same browser with the same cookie jar. Documentation asks the
 * operator to be careful; this is the mechanism that doesn't.
 *
 * An entry matches its own host and its subdomains — `"github.com"` allows
 * `github.com` and `api.github.com`, but NOT `notgithub.com` (suffix matching without
 * the dot boundary is the classic hole). A scheme, port or path in an entry is
 * ignored: this gates WHERE the agent may go, not how it gets there.
 *
 * Non-http(s) URLs are always allowed — `about:blank` is how a tab starts and
 * `data:`/`blob:` carry no ambient credentials, so gating them buys nothing and
 * breaks newPage().
 */
export function isOriginAllowed(url, allow) {
    if (!allow.length)
        return true; // no list configured = no restriction
    let u;
    try {
        u = new URL(url);
    }
    catch {
        return true; // unparseable: leave it to the other guards rather than hard-failing
    }
    if (u.protocol !== "http:" && u.protocol !== "https:")
        return true;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return allow.some((entry) => {
        let e = entry.trim().toLowerCase();
        if (!e)
            return false;
        if (e.includes("://"))
            e = e.slice(e.indexOf("://") + 3); // tolerate a full origin
        e = e.split("/")[0].replace(/:\d+$/, "").replace(/^\*\./, ""); // drop path, port, leading *.
        e = e.replace(/^\[|\]$/g, "");
        return host === e || host.endsWith(`.${e}`);
    });
}
/** Loose same-target check for goto()'s silent-no-navigation retry: origin +
 *  pathname (trailing slash ignored) must match; query/hash differences don't
 *  count as "already there" (they're often the actual point of the nav — a
 *  different reel/post id in the query string, say). Unparseable URLs (a
 *  relative href, `about:blank`) fall back to a raw string compare. */
function sameTarget(a, b) {
    try {
        const ua = new URL(a), ub = new URL(b, a || undefined);
        return ua.origin === ub.origin && ua.pathname.replace(/\/$/, "") === ub.pathname.replace(/\/$/, "");
    }
    catch {
        return a === b;
    }
}
export function isPrivateHost(url) {
    let host;
    try {
        host = new URL(url).hostname.toLowerCase();
    }
    catch {
        return false;
    }
    host = host.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
    if (host === "localhost" || host.endsWith(".localhost"))
        return true;
    if (host === "::1" || host === "0.0.0.0")
        return true;
    // IPv6 unique-local (fc00::/7) — the v6 analog of RFC1918 LAN space. The
    // first hextet is fc00–fdff (never abbreviated, so exactly 4 hex chars).
    if (/^f[cd][0-9a-f]{2}:/.test(host))
        return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — same IPv4 host wearing a v6 hat; a
    // public page could reach ::ffff:127.0.0.1 to hit loopback. The URL parser
    // normalizes the tail to two hex hextets (::ffff:7f00:1), so fold it back to
    // a dotted quad and re-apply the IPv4 rules.
    if (host.startsWith("::ffff:"))
        return isPrivateIPv4(mappedToIPv4(host.slice(7)));
    return isPrivateIPv4(host);
}
/** Fold the tail of an ::ffff: IPv4-mapped address to a dotted quad. Accepts an
 * already-dotted tail (a.b.c.d) or the parser's two-hextet hex form (7f00:1). */
function mappedToIPv4(tail) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail))
        return tail;
    const g = tail.split(":");
    if (g.length !== 2)
        return "";
    const hi = parseInt(g[0], 16), lo = parseInt(g[1], 16);
    if (!Number.isFinite(hi) || !Number.isFinite(lo))
        return "";
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}
/** IPv4 dotted-quad private/loopback classifier (also reused for ::ffff: maps). */
function isPrivateIPv4(host) {
    const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
    if (!m)
        return false;
    const a = +m[1], b = +m[2];
    return (a === 127 || // 127.0.0.0/8 loopback
        a === 10 || // 10.0.0.0/8
        a === 0 || // 0.0.0.0/8
        (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT / Tailscale tailnet
        (a === 192 && b === 168) || // 192.168.0.0/16
        (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
        (a === 169 && b === 254) // 169.254.0.0/16 link-local
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
const RESOURCE_TYPES = {
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
const SYMBOL_KEYS = {
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
 * Printable symbols that require Shift on a US layout — the shifted half of each
 * physical key. Typing one must carry the Shift modifier so `KeyboardEvent
 * .shiftKey` / `getModifierState('Shift')` agree with the character produced: a
 * "!" or "@" reported with shiftKey:false is a self-contradiction (that symbol
 * is unreachable without Shift) — a behavioural bot-tell, and it breaks handlers
 * that gate on the shift state. Uppercase A–Z are detected directly in keyInfo.
 */
const SHIFTED_SYMBOLS = new Set('~!@#$%^&*()_+{}|:"<>?'.split(""));
/**
 * Build the combo string press() expects ("Control+a") from a bare key plus an
 * optional modifiers array — the MCP layer's `veil_press` tool takes them as two
 * separate params (`key`, `modifiers`), but press()'s own chord parsing only
 * understands them pre-joined with "+". Pure and tiny on purpose: this used to be
 * inlined at the one call site and the modifiers array was silently never read,
 * so a held Control/Alt/Meta/Shift never reached the page at all.
 */
export function pressCombo(key, modifiers) {
    return modifiers && modifiers.length ? `${modifiers.join("+")}+${key}` : key;
}
/**
 * Crawler UAs, in the order every hand-rolled skill verification currently
 * tries them — a bare 0-byte response proves nothing about the post, it means
 * you picked the wrong UA TODAY: measured 2026-08-05 Twitterbot worked and
 * facebookexternalhit returned 0 bytes; 2026-08-07 it was exactly reversed.
 * verifyUrl() loops all of them so a caller never has to hand-roll that dance.
 */
export const VERIFY_USER_AGENTS = [
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Twitterbot/1.0",
    "Googlebot/2.1 (+http://www.google.com/bot.html)",
];
/**
 * Fetch `url` completely OUTSIDE the browser/session (plain HTTP, no cookies,
 * no CDP) using a real crawler UA, and check whether one or more strings are
 * present in the response body. This is the primitive behind every posting
 * skill's own hand-rolled "did the post actually go live, served to someone
 * who ISN'T logged in as us" check — the tool's own return value can't be
 * trusted as evidence of the live effect (and shouldn't be), so an anonymous
 * external read is the only real proof. Collapses 4 near-identical
 * hand-written curl+grep blocks (post-instagram, post-tiktok, post-facebook,
 * and the general pattern in post-youtube) into one call, including the
 * multi-UA retry every one of them already had to do by hand.
 *
 * Tries each UA in `opts.userAgents` (default VERIFY_USER_AGENTS) in order,
 * stopping at the first that returns a non-empty body — an empty/blocked
 * response from one crawler UA is common and not itself a failure signal,
 * only "every UA came back empty" is.
 */
export async function verifyUrl(url, opts = {}) {
    const uas = opts.userAgents ?? VERIFY_USER_AGENTS;
    const wants = opts.expectText == null ? [] : Array.isArray(opts.expectText) ? opts.expectText : [opts.expectText];
    const timeout = opts.timeout ?? 15000;
    let lastError;
    for (const userAgent of uas) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const resp = await fetch(url, { headers: { "User-Agent": userAgent }, signal: controller.signal });
            const body = await resp.text();
            clearTimeout(timer);
            if (!body)
                continue; // this UA got nothing back — try the next one, not a hard fail yet
            const found = {};
            for (const w of wants)
                found[w] = body.includes(w);
            const allFound = wants.every((w) => found[w]);
            return {
                ok: resp.ok && (wants.length === 0 || allFound),
                status: resp.status,
                bytes: body.length,
                userAgent,
                found,
                snippet: body.slice(0, 300).replace(/\s+/g, " ").trim(),
            };
        }
        catch (e) {
            clearTimeout(timer);
            lastError = String(e?.message ?? e);
        }
    }
    return { ok: false, bytes: 0, found: {}, error: lastError ?? "every user-agent returned an empty body" };
}
/**
 * Resolve one character to a well-formed keystroke: the DOM `key`, the physical
 * `code`, the legacy `windowsVirtualKeyCode` (`vk`), the `text` to commit, and
 * whether the character needs the `shift` modifier held.
 * Filling these in is the whole point — a bare `text`-only key event leaves
 * `KeyboardEvent.keyCode === 0` and `code === ""`, which breaks keydown-driven
 * UIs and is a hard bot-tell on login forms. Letters, digits, Enter and the US
 * symbol keys are covered; anything else (accented/CJK/emoji) degrades to a
 * plain text commit, the way an IME delivers a composed character.
 */
export function keyInfo(ch) {
    if (ch === "\n" || ch === "\r")
        return { key: "Enter", code: "Enter", vk: 13, text: "\r", shift: false };
    if (/^[a-z]$/i.test(ch)) {
        const upper = ch.toUpperCase();
        return { key: ch, code: `Key${upper}`, vk: upper.charCodeAt(0), text: ch, shift: /^[A-Z]$/.test(ch) };
    }
    if (/^[0-9]$/.test(ch))
        return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), text: ch, shift: false };
    const sym = SYMBOL_KEYS[ch];
    if (sym)
        return { key: ch, code: sym.code, vk: sym.vk, text: ch, shift: SHIFTED_SYMBOLS.has(ch) };
    return { key: ch, code: "", vk: 0, text: ch, shift: false };
}
/** Run `fn` over `items` with at most `limit` in flight, preserving input order.
 *  Bounded on purpose: firing 500 CDP commands at once is a good way to make
 *  one slow page look like a hung browser. */
async function mapConcurrent(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length)
                return;
            out[i] = await fn(items[i]);
        }
    });
    await Promise.all(workers);
    return out;
}
/** How many DOM.getBoxModel calls snapshot() keeps in flight. */
const BOX_BATCH = 24;
/** Short leash for a first attempt at an Input.* command before assuming it's
 *  stalled (see Page.sendInput) — long enough that normal network/render jank
 *  never trips it, short enough that a real stall gets recovered well inside
 *  a caller's own tool-call timeout instead of eating all of it. */
const INPUT_STALL_MS = 5000;
export class Page {
    cdp;
    sessionId;
    targetId;
    rng = new Rng();
    mouse = { x: 100, y: 100 };
    refs = new Map();
    /**
     * Stable ref identity. A backendNodeId keeps the SAME number for the lifetime of
     * the document, so a number is NEVER reused for a different element.
     *
     * Refs used to be assigned 1..N per snapshot, which made them positional: removing
     * an element earlier in the tree shifted every later ref down one, and an agent
     * reusing a remembered number then actuated a DIFFERENT element and got success
     * back. Measured 2026-07-27 — and insertion is not predictable either
     * (`body.prepend` shifts, `appendChild` into a div above does not), so "did the DOM
     * change in a way that renumbers?" is not a question a caller can answer.
     * Memoising identity makes a stale ref either still correct, or loudly absent.
     */
    refByNode = new Map();
    nextRef = 0;
    closed = false;
    // Cross-origin iframe support: CDP site-isolates a cross-origin child frame into
    // its own renderer target ("OOPIF"), invisible to Accessibility/Runtime/Input
    // commands sent on the main page's session — the #1 wall a drag-and-drop page
    // builder (GHL, Webflow, etc.) hits, since the whole canvas is one child iframe.
    // Target.setAutoAttach (scoped to this page's own session) discovers those child
    // targets and hands us a session for each; `activeSessionId` is a single "which
    // session do commands go to" pointer that every existing method already goes
    // through via send(), so useFrame() retargets snapshot/click/fill/eval/type for
    // free without duplicating each method.
    activeSessionId;
    frameSessions = [];
    frameOff;
    // Download state (see enableDownloads / waitForDownload). Chrome under CDP
    // cancels downloads unless a target opts in, so this stays inert until asked.
    // `finishedDownload` exists because a small file can complete before the
    // caller awaits — without it, that download is lost to a race.
    // Recent Network.responseReceived, so waitForResponse() can be called AFTER
    // the click that caused the request without losing the race. Cleared on nav.
    recentResponses = [];
    downloadDir;
    pendingDownloads = new Map();
    downloadWaiter = null;
    finishedDownload = null;
    // FedCM interception state (see enableFedCm).
    fedcmOff;
    fedcmQueue = [];
    fedcmWaiters = [];
    lastFedcmDialogId;
    // Fetch-interception state. The private-network guard and resource blocking
    // share ONE requestPaused handler: two independent handlers would both try to
    // answer the same paused request and the second continue/fail fails with
    // "Invalid InterceptionId". applyFetchInterception() reconciles both.
    blockPrivateOn = false;
    allowOrigins = []; // empty = unrestricted
    // The active coherent identity, if applyFingerprint()/launch({fingerprint}) set one.
    fingerprint;
    blockedResourceTypes = new Set(); // CDP ResourceType values, e.g. "Image"
    blockedUrlSubstrings = [];
    fetchOff; // tears down the shared requestPaused + frameNavigated listeners
    mainFrameId;
    topPrivate = false; // is the page's own top-level origin private?
    /** Cached location.href as of the last goto() — see goto()'s silent-no-nav
     *  retry check. undefined until the first goto() completes. */
    lastKnownUrl;
    constructor(cdp, sessionId, targetId) {
        this.cdp = cdp;
        this.sessionId = sessionId;
        this.targetId = targetId;
        this.activeSessionId = sessionId;
    }
    /** Enable the domains we use and arm stealth injection on every document. */
    async init(opts = {}) {
        await this.send("Page.enable");
        await this.send("DOM.enable");
        await this.send("Accessibility.enable");
        this.trackDownloads(); // listeners only — downloads stay off until enableDownloads()
        this.trackResponses();
        // A fingerprint owns the UA + client hints; without one, just scrub any
        // leaked HeadlessChrome token from the real UA.
        if (!opts.fingerprint)
            await this.normalizeUserAgent();
        // Inject stealth before any page script runs, on every navigation/frame.
        // Only mask WebGL on SwiftShader hosts; with a real GPU the authentic vendor
        // is consistent and masking it would be a detectable lie. When a fingerprint
        // is active it owns the WebGL vendor/renderer, so skip the base SwiftShader
        // mask — otherwise two getParameter overrides would stack.
        const source = buildStealth({ maskWebgl: (opts.maskWebgl ?? false) && !opts.fingerprint });
        await this.send("Page.addScriptToEvaluateOnNewDocument", { source });
        // Apply the fingerprint AFTER the base stealth so its masked getters win over
        // any self-gating backfill, and before the first navigation.
        if (opts.fingerprint)
            await this.applyFingerprint(opts.fingerprint);
        if (opts.blockPrivateNetwork)
            await this.blockPrivateNetwork();
        if (opts.allowOrigins?.length)
            await this.restrictOrigins(opts.allowOrigins);
        // Auto-attach to cross-origin child iframes of THIS page (scoped by sessionId
        // on the command envelope, same as every other domain-enable here) so their
        // Accessibility/Runtime/Input traffic becomes reachable via useFrame().
        await this.send("Target.setAutoAttach", {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
        });
        const offAttach = this.cdp.on("Target.attachedToTarget", (p) => {
            if (p.targetInfo?.type === "iframe") {
                this.frameSessions.push({ sessionId: p.sessionId, url: p.targetInfo.url, targetId: p.targetInfo.targetId });
            }
        }, "*");
        // Prune child sessions when their iframe unmounts or navigates away, so
        // frames() never lists a dead frame and useFrame() can't retarget to a
        // destroyed session. detachedFromTarget carries the sessionId; targetDestroyed
        // only the targetId — handle both.
        const offDetach = this.cdp.on("Target.detachedFromTarget", (p) => { if (p.sessionId)
            this.removeFrameSession((f) => f.sessionId === p.sessionId); }, "*");
        const offDestroyed = this.cdp.on("Target.targetDestroyed", (p) => { if (p.targetId)
            this.removeFrameSession((f) => f.targetId === p.targetId); }, "*");
        this.frameOff = () => { offAttach(); offDetach(); offDestroyed(); };
    }
    /** Drop a dead child-frame session (its iframe unmounted or navigated). If it
     *  was the active target, fall back to the main page and clear now-meaningless
     *  refs so the next call errors cleanly instead of acting on a stale frame. */
    removeFrameSession(match) {
        const i = this.frameSessions.findIndex(match);
        if (i < 0)
            return;
        const [gone] = this.frameSessions.splice(i, 1);
        if (gone && this.activeSessionId === gone.sessionId) {
            this.activeSessionId = this.sessionId;
            this.resetRefs();
        }
    }
    /** List discovered cross-origin child iframes (same-origin iframes don't need
     *  this — they're already visible to the main session's Accessibility tree). */
    async frames() {
        return this.frameSessions.map((f, i) => ({ index: i + 1, url: f.url }));
    }
    /** Point every subsequent snapshot/click/fill/type/eval call at a child iframe
     *  (index from frames()), or back at the main page with null/undefined. Clears
     *  refs — a snapshot ref is only ever valid for the frame it was taken in. */
    useFrame(index) {
        this.resetRefs();
        if (index == null) {
            this.activeSessionId = this.sessionId;
            return;
        }
        const f = this.frameSessions[index - 1];
        if (!f)
            throw new Error(`useFrame: no frame at index ${index} — call frames() first (found ${this.frameSessions.length})`);
        this.activeSessionId = f.sessionId;
    }
    /**
     * Inject cookies before navigating — e.g. a logged-in session transferred
     * from another browser. Each cookie is a CDP CookieParam ({name, value,
     * domain, path, secure, httpOnly, expires?, sameSite?}). Lets the browser
     * ride an existing session instead of re-doing a bot-walled login.
     */
    async setCookies(cookies) {
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
    async getCookies(urls) {
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
    async normalizeUserAgent() {
        const realUA = await this.evaluate("navigator.userAgent");
        const cleanUA = realUA.replace("HeadlessChrome", "Chrome");
        if (cleanUA === realUA)
            return;
        await this.applyUserAgentOverride(cleanUA);
    }
    /** Set navigator.userAgent AND the matching Sec-CH-UA client-hint brands
     *  consistently — a UA string without the aligned hints is itself a tell.
     *  Shared by init's HeadlessChrome scrub and the public setUserAgent(). */
    async applyUserAgentOverride(ua) {
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
    async setUserAgent(userAgent) {
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
    async applyFingerprint(fp) {
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
        // 3. timezone + locale + optional geolocation — all browser-level, so they
        //    resolve natively (Intl.DateTimeFormat().resolvedOptions().timeZone,
        //    navigator.language, navigator.geolocation) with no JS getter to unmask.
        //    A US profile must carry a US timezone/locale (and, if given, US coords):
        //    a Windows/en-US UA reporting Asia/Shanghai is a contradiction detectors
        //    score. setLocaleOverride can reject if one is already mid-flight — that's
        //    non-fatal to the rest of the profile, so it's tolerated.
        await this.send("Emulation.setTimezoneOverride", { timezoneId: fp.timezone });
        try {
            await this.send("Emulation.setLocaleOverride", { locale: fp.locale });
        }
        catch { }
        if (fp.geolocation) {
            await this.send("Emulation.setGeolocationOverride", {
                latitude: fp.geolocation.latitude,
                longitude: fp.geolocation.longitude,
                accuracy: fp.geolocation.accuracy ?? 100,
            });
        }
        // 4. the masked page-level getter layer, armed on every future document.
        await this.send("Page.addScriptToEvaluateOnNewDocument", { source: buildFingerprintStealth(fp) });
    }
    /**
     * Set the viewport (and optionally device pixel ratio / mobile emulation) via
     * Emulation.setDeviceMetricsOverride — the page sees this as its
     * window.innerWidth/Height, screen size, and devicePixelRatio. Use it to
     * emulate a phone (`{width:390,height:844,deviceScaleFactor:3,mobile:true}`)
     * or force a fixed desktop size for reproducible screenshots.
     */
    async setViewport(opts) {
        await this.send("Emulation.setDeviceMetricsOverride", {
            width: opts.width,
            height: opts.height,
            deviceScaleFactor: opts.deviceScaleFactor ?? 1,
            mobile: opts.mobile ?? false,
        });
    }
    /** Commands go to whichever session is "active" — the main page by default,
     *  or a child iframe's own session after useFrame(). Input.* commands get an
     *  extra stall-recovery layer — see sendInput(). */
    send(method, params = {}) {
        if (method.startsWith("Input."))
            return this.sendInput(method, params);
        return this.cdp.send(method, params, this.activeSessionId);
    }
    /**
     * The Input domain (mouse/key dispatch) can stall for 120s+ on a
     * backgrounded/occluded target while every other domain (Runtime.evaluate,
     * DOM, Accessibility) stays instant — measured live (joe's pain-list #3):
     * clicks sitting past a 120s tool cap, completing minutes later once
     * something else woke the target. The known fix used to be a manual
     * `curl http://127.0.0.1:9333/json/activate/<targetId>` a caller had to
     * remember and run out-of-band; this makes the tool do it itself.
     *
     * Give an Input command a short leash (INPUT_STALL_MS). On that specific
     * timeout, bring the target to the foreground once (Page.bringToFront,
     * scoped to the top-level session even if the stalled command was on a
     * child iframe — bringing the PAGE forward is what un-stalls Input for
     * every frame in it) and retry the exact same command once at the normal
     * default timeout. Any other error passes straight through.
     */
    async sendInput(method, params) {
        try {
            return await this.cdp.send(method, params, this.activeSessionId, INPUT_STALL_MS);
        }
        catch (e) {
            if (!String(e?.message ?? "").includes("timed out"))
                throw e;
            await this.cdp.send("Page.bringToFront", {}, this.sessionId).catch(() => { });
            return this.cdp.send(method, params, this.activeSessionId);
        }
    }
    /** Navigate and wait. Always the main page, regardless of any active useFrame()
     *  — top-level navigation isn't a per-frame concept. `waitUntil` is "load"
     *  (default) or "networkidle" (no network for ~500ms — better for SPAs that
     *  fetch after the load event). Reset ref/session state so a prior useFrame()
     *  can't leak across the nav and a leftover ref can't click wrong coords. */
    async goto(url, opts = {}) {
        // beforeUrl + one retry closes joe's pain-list #6: goto("...facebook.com
        // /reel/<id>") once left the tab sitting on an hours-old page with no
        // signal anything was wrong — the routine #2 timeout swallow (below)
        // made a genuine "didn't navigate at all" indistinguishable from "navigated
        // fine, ignore the throw". Comparing location.href before/after and
        // retrying once when it silently never moved makes that failure visible
        // and self-healing instead of needing evaluate("location.href") by hand
        // to catch it after the fact.
        //
        // beforeUrl comes from the CACHED result of the last goto, not a fresh
        // evaluate() round-trip against the live document: probing the page right
        // as a new navigation is about to start is an unnecessary extra command
        // on the hot path of every single goto() call, for a comparison that only
        // matters on the (rare) silent-no-nav case. undefined on the very first
        // call ever (nothing to compare against yet) — skip the check then.
        const beforeUrl = this.lastKnownUrl;
        let result = await this.gotoOnce(url, opts);
        if (beforeUrl !== undefined && result.url === beforeUrl && !sameTarget(beforeUrl, url)) {
            result = await this.gotoOnce(url, opts);
            result.retried = true;
        }
        this.lastKnownUrl = result.url;
        return result;
    }
    /**
     * goto() + wait for a condition, in ONE call — collapses the goto/waitFor*
     * pair that opens almost every agent flow (phase-2 profiling: 2 of 8
     * round-trips in a representative scrape flow were exactly this pair).
     * Pass at most one of text/selector/expression; omit `wait` entirely to
     * just navigate with no wait (equivalent to plain goto() but through the
     * composite-shaped return). The wait outcome is reported honestly under
     * `wait` rather than folded into the top-level result — a wait TIMEOUT
     * here does not throw and does not mean the navigation failed; it means
     * exactly what it says.
     */
    async gotoAndWait(url, wait, opts = {}) {
        const nav = await this.goto(url, opts);
        if (!wait || (!wait.text && !wait.selector && !wait.expression))
            return nav;
        try {
            if (wait.text)
                await this.waitForText(wait.text, { timeout: wait.timeout });
            else if (wait.selector)
                await this.waitForSelector(wait.selector, { timeout: wait.timeout });
            else if (wait.expression)
                await this.waitFor(wait.expression, { timeout: wait.timeout });
            return { ...nav, wait: { ok: true } };
        }
        catch (e) {
            return { ...nav, wait: { ok: false, error: String(e?.message ?? e) } };
        }
    }
    async gotoOnce(url, opts = {}) {
        this.resetRefs();
        this.recentResponses = [];
        this.activeSessionId = this.sessionId;
        const timeout = opts.timeout ?? 30000;
        // Capture the main document's HTTP status so callers can detect 4xx/5xx: match
        // the Document response to THIS navigation's loaderId (redirects keep the
        // loaderId, so the final hop's status wins). Needs the Network domain enabled.
        await this.cdp.send("Network.enable", {}, this.sessionId).catch(() => { });
        const docStatus = new Map(); // loaderId -> HTTP status
        const docUrl = new Map(); // loaderId -> the response's own URL (post-redirect)
        const offResp = this.cdp.on("Network.responseReceived", (p) => {
            if (p.type === "Document" && p.loaderId) {
                docStatus.set(p.loaderId, p.response?.status);
                if (p.response?.url)
                    docUrl.set(p.loaderId, p.response.url);
            }
        }, this.sessionId);
        let loaderId;
        let offWithin;
        let timedOutWaitingForLoad = false;
        try {
            // Arm the waiter BEFORE navigating: we can't miss loadEventFired, and a
            // networkidle waiter is already counting the navigation's own requests.
            const waiter = this.waitForLoad(opts.waitUntil ?? "load", timeout);
            // A SAME-DOCUMENT navigation — a #fragment, or history/pushState — never
            // fires loadEventFired, because no new document loads. Waiting for it hangs
            // for the whole timeout and then throws. Measured on Chrome 150:
            // goto("https://example.com/#x") FAILED after 15001ms while real navigations
            // to the same origin took ~300ms. Anchor links and SPA routes are ordinary
            // things for an agent to follow, so this was a 30s stall (default timeout) on
            // a completely common path.
            //
            // Race Chrome's own same-document signal against the load waiter rather than
            // string-comparing the URLs: a comparison would have to normalise trailing
            // slashes, relative hrefs and percent-encoding, and would STILL miss
            // pushState navigations that change the path with no document load.
            const withinDoc = new Promise((resolve) => {
                offWithin = this.cdp.on("Page.navigatedWithinDocument", () => resolve("within"), this.sessionId);
            });
            // Page.navigate resolves with { frameId, loaderId, errorText? }. On a DNS or
            // connection failure Chrome STILL fires loadEventFired for its own error page,
            // so the load event alone can't tell success from failure — errorText can.
            const nav = await this.cdp.send("Page.navigate", { url }, this.sessionId);
            if (nav?.errorText) {
                waiter.catch(() => { }); // we're bailing; swallow the pending waiter rejection
                throw new Error(`goto(${url}) failed: ${nav.errorText}`);
            }
            loaderId = nav?.loaderId;
            // Whichever signal arrives first wins. On a same-document navigation the load
            // waiter will never settle, so swallow it — otherwise it surfaces as an
            // unhandled rejection long after goto() has already returned successfully.
            try {
                const how = await Promise.race([waiter.then(() => "loaded"), withinDoc]);
                if (how === "within")
                    waiter.catch(() => { });
            }
            catch (err) {
                // Page.loadEventFired never fired within the timeout — measured as routine
                // on Instagram, TikTok, Facebook, YouTube Studio, and plenty of ordinary CMS
                // sites (a persistent analytics/chat/long-poll connection can keep the
                // browser's notion of "loading" open long after the document is actually
                // interactive). This was previously a thrown exception on every one of
                // those, which trained every caller to catch-and-ignore goto() errors —
                // exactly when a REAL navigation failure needs to be noticed. So: only
                // swallow THIS specific, identified timeout, and only after confirming the
                // DOM actually landed; anything else still throws.
                if (!/Timed out waiting for Page\.loadEventFired/.test(String(err?.message ?? err)))
                    throw err;
                const ready = await this.evaluate("document.readyState").catch(() => "");
                if (ready !== "complete" && ready !== "interactive")
                    throw err; // genuinely never loaded — still a real error
                timedOutWaitingForLoad = true;
            }
        }
        finally {
            offWithin?.();
            offResp();
        }
        await sleep(this.rng.range(150, 400)); // settle, like a human reading
        // status stays undefined only when no Document response is observed for this
        // loaderId (e.g. about:blank) — additive, so callers that ignore it are fine.
        const status = loaderId ? docStatus.get(loaderId) : undefined;
        // Report the REAL current location, not an echo of the requested url — a
        // caller who trusted `res.url === requestedUrl` had no way to tell a
        // genuine silent no-navigation apart from success (joe's pain-list #6).
        // Read off the Document response's OWN url (captured by the SAME
        // Network.responseReceived listener already armed above for status, not
        // a separate CDP round-trip) — this is the post-redirect URL Chrome
        // actually landed on. A live extra command here (evaluate("location.href")
        // AND Page.getFrameTree were both tried) reproducibly killed the whole
        // CDP connection in testing right after a data: URL navigation; reusing
        // data already flowing through an existing listener sidesteps that
        // entirely instead of chasing why. Falls back to the requested url for
        // same-document navs (no Document response — the input WAS where it went).
        const actualUrl = (loaderId && docUrl.get(loaderId)) || url;
        return {
            url: actualUrl, status, ok: status == null ? undefined : status >= 200 && status < 400,
            ...(timedOutWaitingForLoad ? { timedOutWaitingForLoad: true } : {}),
        };
    }
    /** Reload the current page (Page.reload), waiting per `waitUntil`. */
    async reload(opts = {}) {
        this.resetRefs();
        this.activeSessionId = this.sessionId;
        const waiter = this.waitForLoad(opts.waitUntil ?? "load", opts.timeout ?? 30000);
        await this.cdp.send("Page.reload", {}, this.sessionId);
        await waiter;
        await sleep(this.rng.range(150, 400));
    }
    /** Go back one entry in session history. Throws if there's nothing earlier. */
    async back(opts = {}) {
        await this.historyGo(-1, opts);
    }
    /** Go forward one entry in session history. Throws if there's nothing later. */
    async forward(opts = {}) {
        await this.historyGo(1, opts);
    }
    /** Navigate `delta` entries through session history via
     *  Page.navigateToHistoryEntry (precise, and lets us reject cleanly when the
     *  target entry doesn't exist instead of silently no-op'ing like history.go). */
    async historyGo(delta, opts) {
        const { currentIndex, entries } = await this.cdp.send("Page.getNavigationHistory", {}, this.sessionId);
        const target = entries?.[currentIndex + delta];
        if (!target)
            throw new Error(delta < 0 ? "back(): no earlier history entry" : "forward(): no later history entry");
        this.resetRefs();
        this.activeSessionId = this.sessionId;
        const waiter = this.waitForLoad(opts.waitUntil ?? "load", opts.timeout ?? 30000);
        await this.cdp.send("Page.navigateToHistoryEntry", { entryId: target.id }, this.sessionId);
        await waiter;
        await sleep(this.rng.range(150, 400));
    }
    /** Resolve when the page finishes loading, per the `waitUntil` strategy. */
    waitForLoad(waitUntil, timeout) {
        if (waitUntil === "networkidle")
            return this.waitForNetworkIdle(timeout);
        return this.cdp.once("Page.loadEventFired", { sessionId: this.sessionId, timeout }).then(() => { });
    }
    /** Resolve once no network request has been in flight for `idleMs`, or reject
     *  after `timeout`. Tracks in-flight requests over the Network domain — the
     *  right signal for SPAs whose content arrives after the load event. */
    waitForNetworkIdle(timeout, idleMs = 500) {
        // Enable Network first (idempotent); listeners below are registered
        // synchronously so no event is missed once it takes effect.
        this.cdp.send("Network.enable", {}, this.sessionId).catch(() => { });
        return new Promise((resolve, reject) => {
            let inflight = 0;
            let idleTimer;
            let settled = false;
            const settle = (err) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(idleTimer);
                clearTimeout(hardTimer);
                offReq();
                offFin();
                offFail();
                err ? reject(err) : resolve();
            };
            const armIdle = () => {
                clearTimeout(idleTimer);
                idleTimer = setTimeout(() => settle(), idleMs);
            };
            const onReq = () => { inflight++; clearTimeout(idleTimer); };
            const onDone = () => { inflight = Math.max(0, inflight - 1); if (inflight === 0)
                armIdle(); };
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
    async evaluate(expression, opts = {}) {
        const timeout = opts.timeout ?? 30000;
        // Accept a FUNCTION as well as a string. Everyone arrives here from puppeteer or
        // playwright and writes `evaluate(() => document.title)`. That used to stringify
        // to "() => document.title", which Runtime.evaluate happily evaluates INTO A
        // FUNCTION OBJECT — and returnByValue cannot serialise a function, so CDP
        // answers "Invalid parameters (-32602)".
        //
        // That error is indistinguishable from a protocol regression, and it cost me
        // four probes hunting a Chrome 150 breakage that never existed. A wrong call
        // shape must not produce an error that blames the browser. Wrapping it in an
        // IIFE makes the intuitive form simply work.
        if (typeof expression === "function") {
            expression = `(${expression.toString()})()`;
        }
        let r;
        try {
            r = await this.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, this.activeSessionId, timeout);
        }
        catch (e) {
            if (String(e?.message ?? "").includes("timed out")) {
                throw new Error(`evaluate: timed out after ${timeout}ms (page wedged?)`);
            }
            throw e;
        }
        if (r.exceptionDetails)
            throw new Error(`evaluate: ${r.exceptionDetails.text}`);
        return r.result?.value;
    }
    async url() {
        return this.evaluate("location.href");
    }
    /** Drop every ref AND its identity map. Navigation and frame switches invalidate
     *  backendNodeIds wholesale, so keeping the old numbers would be meaningless. */
    resetRefs() {
        this.refs.clear();
        this.refByNode.clear();
        this.nextRef = 0;
    }
    /** Build the numbered element index from the accessibility tree. */
    async snapshot() {
        const { nodes } = await this.send("Accessibility.getFullAXTree");
        // Clear the live map (a node that is gone must stop resolving, so acting on its
        // ref errors loudly) but KEEP refByNode, which is what makes a number mean the
        // same element on the next snapshot.
        this.refs.clear();
        const elements = [];
        // Two passes on purpose. Pass 1 filters cheaply in memory; pass 2 asks
        // Chrome for the layout boxes ALL AT ONCE. The old shape awaited one
        // DOM.getBoxModel per candidate inside the loop, so a 150-element page paid
        // 150 sequential round-trips and a real app page (500+) paid 500. The CDP
        // client keys pending replies by message id, so concurrent commands are
        // safe; batching keeps one slow reply from blocking the rest.
        const candidates = [];
        for (const n of nodes) {
            if (n.ignored)
                continue;
            const role = n.role?.value ?? "";
            const name = (n.name?.value ?? "").trim();
            if (!INTERESTING.has(role))
                continue;
            if (!name && role !== "textbox" && role !== "searchbox" && role !== "textarea")
                continue;
            const backendNodeId = n.backendDOMNodeId;
            if (!backendNodeId)
                continue;
            candidates.push({ backendNodeId, role, name, value: n.value?.value });
        }
        const centers = await mapConcurrent(candidates, BOX_BATCH, (c) => this.boxCenter(c.backendNodeId));
        // Elements are LISTED in accessibility-tree order, but a ref is an IDENTITY, not
        // a position: a node that has been seen before keeps the number it was given.
        // Numbers are therefore ascending on first sight and may contain gaps afterwards
        // (an element was removed) or appear out of order (a new element was inserted
        // above older ones). That is the point — the alternative is renumbering, and a
        // renumbered ref actuates the wrong element without failing.
        for (let i = 0; i < candidates.length; i++) {
            const center = centers[i];
            if (!center)
                continue; // not visible / no layout box
            const c = candidates[i];
            let ref = this.refByNode.get(c.backendNodeId);
            if (ref === undefined) {
                ref = ++this.nextRef;
                this.refByNode.set(c.backendNodeId, ref);
            }
            this.refs.set(ref, { backendNodeId: c.backendNodeId, center });
            elements.push({ ref, role: c.role, name: c.name, value: c.value, center });
        }
        const [url, title] = await Promise.all([
            this.evaluate("location.href"),
            this.evaluate("document.title"),
        ]);
        const text = elements
            .map((e) => `[${e.ref}] ${e.role} ${JSON.stringify(e.name)}${e.value ? ` =${JSON.stringify(e.value)}` : ""}`)
            .join("\n");
        return { url, title, text, elements };
    }
    async boxCenter(backendNodeId) {
        try {
            const { model } = await this.send("DOM.getBoxModel", { backendNodeId });
            const q = model.content; // [x1,y1, x2,y2, x3,y3, x4,y4]
            const x = (q[0] + q[2] + q[4] + q[6]) / 4;
            const y = (q[1] + q[3] + q[5] + q[7]) / 4;
            if ((model.width ?? 0) <= 0 || (model.height ?? 0) <= 0)
                return null;
            return { x, y };
        }
        catch {
            return null;
        }
    }
    /**
     * Snapshot-free element locator — the one to reach for on heavy SPA editors
     * (Ancestry, Notion, Figma, YouTube Studio) where snapshot() stalls or times
     * out. snapshot() pulls Chrome's FULL accessibility tree
     * (Accessibility.getFullAXTree) plus a getBoxModel per node; on a big
     * virtualized DOM that is seconds of work or a hang. domSnapshot() does it in
     * ONE in-page evaluate: no AX tree, no per-node round-trips.
     *
     * It PIERCES shadow DOM (a plain document.querySelectorAll does not, so
     * web-component buttons — exactly the YouTube-Studio / Ancestry case — are
     * invisible to naive DOM scraping; that used to be snapshot()'s only edge).
     *
     * Every element carries its center in viewport coords: feed x,y straight to
     * clickAt() for a TRUSTED click (fires framework handlers a synthetic
     * .click() silently drops). clickText()/fillText() wrap the common cases.
     */
    async domSnapshot(opts = {}) {
        const max = opts.max ?? 300;
        const js = `(() => {
      const SEL = 'a,button,input,textarea,select,summary,label,[role=button],[role=link],[role=option],[role=menuitem],[role=menuitemcheckbox],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=combobox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]';
      const out = [], seen = new Set();
      const box = (e) => {
        const r = e.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return null;
        if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;
        const s = getComputedStyle(e);
        if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return null;
        return r;
      };
      const label = (e) => (
        e.getAttribute('aria-label') || (e.innerText || '').trim() || e.value ||
        e.placeholder || e.getAttribute('title') || e.getAttribute('name') || ''
      ).replace(/\\s+/g, ' ').trim().slice(0, 100);
      const walk = (root) => {
        let all;
        try { all = root.querySelectorAll('*'); } catch { return; }
        for (const e of all) {
          if (e.matches && e.matches(SEL) && !seen.has(e)) {
            seen.add(e);
            const r = box(e);
            if (r) {
              const tag = e.tagName.toLowerCase();
              out.push({
                i: out.length, tag, role: e.getAttribute('role') || '', t: label(e),
                x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
                w: Math.round(r.width), h: Math.round(r.height),
                editable: tag === 'input' || tag === 'textarea' || e.isContentEditable === true,
              });
            }
          }
          if (e.shadowRoot) walk(e.shadowRoot);
        }
      };
      walk(document);
      return out.slice(0, ${max});
    })()`;
        const elements = await this.evaluate(js);
        const [url, title] = await Promise.all([
            this.evaluate("location.href"),
            this.evaluate("document.title"),
        ]);
        const text = elements
            .map((e) => `[${e.i}] ${e.tag}${e.role ? `/${e.role}` : ""}${e.editable ? " (input)" : ""} ${JSON.stringify(e.t)} @${e.x},${e.y}`)
            .join("\n");
        return { url, title, text, elements };
    }
    /**
     * The matcher behind clickText/fillText. Ranks visible elements against `query`
     * by label: exact ▸ startsWith ▸ word-boundary ▸ substring; ties break toward
     * the shortest (most specific) label, then topmost. Returns the chosen element
     * or null. `nth` selects among equivalents; `editableOnly` restricts to fields.
     */
    async findText(query, opts = {}) {
        const { elements } = await this.domSnapshot();
        const q = query.toLowerCase().replace(/\s+/g, " ").trim();
        const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const wb = new RegExp(`\\b${esc}`);
        const scored = elements
            .filter((e) => (!opts.editableOnly || e.editable) && (!opts.role || e.role === opts.role))
            .map((e) => {
            const t = e.t.toLowerCase();
            let score = -1;
            if (t === q)
                score = 100;
            else if (opts.exact)
                score = -1;
            else if (t.startsWith(q))
                score = 80;
            else if (wb.test(t))
                score = 60;
            else if (t.includes(q))
                score = 40;
            return { e, score };
        })
            .filter((s) => s.score >= 0)
            .sort((a, b) => b.score - a.score || a.e.t.length - b.e.t.length || a.e.y - b.e.y);
        return scored[opts.nth ?? 0]?.e ?? null;
    }
    /**
     * The atomic locate-and-position primitive behind clickText/fillText — the one
     * that makes writing to a heavy SPA reliable instead of coin-flip.
     *
     * findText() ranks against a PRIOR domSnapshot: its coords are viewport-relative
     * and go stale the instant anything scrolls or re-lays-out (the exact bug that
     * made a live-tree hint-click land on nothing). locateText instead does the walk,
     * the scoring, the scroll-into-view AND the coord read in ONE in-page pass, so the
     * returned x,y are guaranteed fresh and on-screen for the trusted click that
     * follows. It also sees BELOW-THE-FOLD elements (its own walk isn't viewport-gated
     * like domSnapshot), so it can drive a form field the page hasn't scrolled to yet.
     *
     * `behavior:'instant'` defeats CSS scroll-behavior:smooth — otherwise getBounding-
     * ClientRect would read a mid-animation position and we'd click where the element
     * used to be. Returns the element (fresh center coords) or null.
     */
    async locateText(query, opts = {}) {
        if (typeof query !== "string" || !query.trim()) {
            // Fails loudly at the boundary instead of a cryptic "query.toLowerCase() of
            // undefined" — the real cause is almost always a caller passing the wrong
            // param name (e.g. `text` instead of `query`), which the MCP layer doesn't
            // validate before the handler runs.
            throw new Error(`locateText: "query" must be a non-empty string, got ${JSON.stringify(query)}`);
        }
        const spec = {
            q: query.toLowerCase().replace(/\s+/g, " ").trim(),
            exact: !!opts.exact,
            role: opts.role || "",
            editableOnly: !!opts.editableOnly,
            nth: opts.nth ?? 0,
        };
        const js = `(() => {
      const SPEC = ${JSON.stringify(spec)};
      const SEL = 'a,button,input,textarea,select,summary,label,[role=button],[role=link],[role=option],[role=menuitem],[role=menuitemcheckbox],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=combobox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]';
      const seen = new Set(), cand = [];
      const label = (e) => (
        e.getAttribute('aria-label') || (e.innerText || '').trim() || e.value ||
        e.placeholder || e.getAttribute('title') || e.getAttribute('name') || ''
      ).replace(/\\s+/g, ' ').trim();
      const vis = (e) => {
        const r = e.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const s = getComputedStyle(e);
        return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
      };
      const walk = (root) => {
        let all;
        try { all = root.querySelectorAll('*'); } catch { return; }
        for (const e of all) {
          if (e.matches && e.matches(SEL) && !seen.has(e)) {
            seen.add(e);
            if (vis(e)) {
              const tag = e.tagName.toLowerCase();
              const ed = tag === 'input' || tag === 'textarea' || e.isContentEditable === true;
              const role = e.getAttribute('role') || '';
              if ((!SPEC.editableOnly || ed) && (!SPEC.role || role === SPEC.role)) {
                cand.push({ e, t: label(e).toLowerCase(), tag, role, ed });
              }
            }
          }
          if (e.shadowRoot) walk(e.shadowRoot);
        }
      };
      walk(document);
      const scored = cand.map((c) => {
        const t = c.t; let s = -1;
        if (t === SPEC.q) s = 100;
        else if (!SPEC.exact) {
          if (t.startsWith(SPEC.q)) s = 80;
          else if ((' ' + t).includes(' ' + SPEC.q)) s = 60; // word-start, no regex
          else if (t.includes(SPEC.q)) s = 40;
        }
        return { c, s };
      }).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s || a.c.t.length - b.c.t.length);
      const pick = scored[SPEC.nth];
      if (!pick) return null;
      const el = pick.c.e;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return {
        i: 0, tag: pick.c.tag, role: pick.c.role, t: label(el).slice(0, 100),
        x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
        w: Math.round(r.width), h: Math.round(r.height), editable: pick.c.ed,
      };
    })()`;
        return this.evaluate(js);
    }
    /**
     * Locate the best element matching `query`, scroll it into view and TRUSTED-click
     * its FRESH center — no snapshot ref, works where snapshot() hangs. Throws if
     * nothing matches (so a miss is loud, not a silent no-op that reports success).
     * Returns the element. Verify the RESULT externally — a landed click is not a
     * completed action.
     */
    async clickText(query, opts = {}) {
        // P1 resilience (2026-08-30, judge #7733/#7734): one soft retry on a miss before
        // throwing. The common real-world case isn't "the element doesn't exist" — it's a page
        // mid-hydration/re-render where the target flickers out of the walk for one pass. A hard
        // fail on the FIRST miss made every transient DOM shift look identical to a genuine "not
        // found," which is exactly the brittleness intent-based primitives are supposed to remove.
        let el = await this.locateText(query, opts);
        if (!el) {
            await sleep(this.rng.range(500, 800));
            el = await this.locateText(query, opts);
        }
        if (!el)
            throw new Error(`clickText: no visible element matching ${JSON.stringify(query)}`);
        await sleep(this.rng.range(280, 460)); // let scroll + any reflow settle before the click
        await this.clickAt(el.x, el.y);
        return el;
    }
    /**
     * clickText() + wait for the effect, in ONE call — collapses the single
     * most common "did my action land" pattern (click, then a separate wait
     * call to confirm) across every posting/scraping flow. Same honesty rule
     * as gotoAndWait: a wait timeout is reported under `wait`, not thrown —
     * the click itself either succeeded (threw already if not) or it didn't;
     * whether the expected EFFECT showed up is a separate, honestly-reported
     * question.
     */
    async clickAndWait(query, wait, opts = {}) {
        const clicked = await this.clickText(query, opts);
        if (!wait || (!wait.text && !wait.selector && !wait.expression))
            return { clicked };
        try {
            if (wait.text)
                await this.waitForText(wait.text, { timeout: wait.timeout });
            else if (wait.selector)
                await this.waitForSelector(wait.selector, { timeout: wait.timeout });
            else if (wait.expression)
                await this.waitFor(wait.expression, { timeout: wait.timeout });
            return { clicked, wait: { ok: true } };
        }
        catch (e) {
            return { clicked, wait: { ok: false, error: String(e?.message ?? e) } };
        }
    }
    /**
     * Scroll the element matching `query` into view and return it, without
     * clicking or filling — the standalone version of the scroll-into-view
     * locateText already does internally for clickText/fillText/extractText.
     *
     * Fills the gap joe's pain-list #7 reported: veil_scroll(dy) dispatches a
     * raw wheel event at the viewport, which only moves the element actually
     * under the cursor — reporting "scrolled" while a target sitting inside an
     * inner/nested scroll container (a modal body, a chat panel, a sidebar
     * list) never moved. `el.scrollIntoView()` (what locateText already uses)
     * walks up to whichever ancestor is actually scrollable and moves THAT,
     * which is what a real "get this element on screen" primitive needs
     * instead of blind viewport coordinates. Throws if nothing matches.
     */
    async scrollToText(query, opts = {}) {
        const el = await this.locateText(query, opts);
        if (!el)
            throw new Error(`scrollToText: no visible element matching ${JSON.stringify(query)}`);
        return el;
    }
    /**
     * Focus an editable field matched by its label/placeholder/aria text (scrolled
     * into view first) and set `value`. The snapshot-free analogue of fill(ref,
     * text) — same native-setter + _valueTracker-reset fast path (2026-08-29,
     * judge #7702) for <input>/<textarea>, since fillText has no snapshot ref to
     * drive callOnRef with: it operates on document.activeElement right after
     * the click, and checks the click actually landed on a native field before
     * trusting that. contenteditable has no .value/tracker, so it still falls
     * back to real keystrokes. Throws if no editable field matches. Returns the
     * field.
     */
    async fillText(query, value, opts = {}) {
        // Same soft-retry as clickText — see that comment. A form field re-rendering (validation
        // message appearing, a label animating in) is the exact transient-miss shape this covers.
        let el = await this.locateText(query, { nth: opts.nth, editableOnly: true });
        if (!el) {
            await sleep(this.rng.range(500, 800));
            el = await this.locateText(query, { nth: opts.nth, editableOnly: true });
        }
        if (!el)
            throw new Error(`fillText: no editable field matching ${JSON.stringify(query)}`);
        await sleep(this.rng.range(280, 460)); // let scroll settle
        await this.clickAt(el.x, el.y);
        await sleep(this.rng.range(40, 90));
        if (el.tag === "input" || el.tag === "textarea") {
            // value travels via JSON.stringify into the expression string, not a raw
            // template interpolation of the RAW characters into veil's own source —
            // JSON.stringify always emits a syntactically valid, correctly-escaped
            // JS string literal, so this doesn't hit the bun non-ASCII source-escaping
            // bug that motivated passing text as a real callFunctionOn argument in
            // fill(ref, ...) (that bug is about bun mis-transpiling literal non-ASCII
            // in *veil's own* .ts source, not about a JSON-escaped runtime string).
            await this.evaluate(`(function(){
        const el = document.activeElement;
        if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) {
          throw new Error("fillText: focus did not land on the target field — a cookie banner, modal, or sticky header may be covering it");
        }
        const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        const prevValue = el.value;
        setter.call(el, ${JSON.stringify(value)});
        const tracker = el._valueTracker;
        if (tracker) tracker.setValue(prevValue);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
        }
        else {
            await this.sendKey({ key: "a", code: "KeyA", vk: 65, modifiers: 2 }); // Ctrl+A select-all
            await this.type(value);
        }
        return el;
    }
    /**
     * Fill several fields in one call — the multi-field form/composer case
     * (signup, a post editor with title+body+tags) every posting skill hits as
     * N separate fillText calls. `fields` maps each field's query (same
     * matching as fillText) to the value to type. v1 scope, deliberately:
     * plain text targets only (input/textarea/contenteditable, exactly what
     * fillText already handles) — a <select>/checkbox/radio needs a different
     * primitive (see Page.select) and is NOT folded in here; that's real depth
     * (option matching, multi-select, indeterminate checkboxes) worth its own
     * pass rather than rushed into this one. Runs fields in the given order
     * (order can matter — e.g. a field that only appears after an earlier one
     * is filled) and does NOT stop on a per-field failure: every field is
     * attempted, and each result is reported honestly (ok+element, or the
     * error) rather than the whole call failing opaquely on field 2 of 5 with
     * no way to tell whether fields 1, 3, 4, 5 landed.
     */
    async fillForm(fields) {
        const out = {};
        for (const [query, value] of Object.entries(fields)) {
            try {
                out[query] = { ok: true, element: await this.fillText(query, value) };
            }
            catch (e) {
                out[query] = { ok: false, error: String(e?.message ?? e) };
            }
        }
        return out;
    }
    /**
     * Read the content of the element(s) matching `query` by description — the missing verb
     * next to clickText/fillText (2026-08-30, judge #7733/#7734, P1 of the "veil as a real
     * high-level tool" plan). "extract the price" / "extract the status" without a snapshot ref
     * or a CSS selector: rank visible elements by label match (same algorithm as locateText, but
     * a WIDER element set — clickText/fillText only ever need interactive controls, extraction
     * routinely targets plain text: a price in a <span>, a status in a <div>, a headline). Returns
     * the FULL text/value, not the truncated ~100-char label locateText uses for matching.
     *
     * Pass `all: true` to return every match instead of just the best one — the single-page half
     * of "extract all posts/comments" (Armani's own example). This does NOT do cross-page
     * pagination or dedupe — that's the separately-scoped P2 harvesting build; this reads what's
     * already on the page.
     *
     * Container/leaf overlap (live-caught on example.com during this build, not just theorized):
     * a wrapping <p> and the <a> inside it can both match the same query with an IDENTICAL score
     * and label — a live query for "Learn more" there returned the <p> (href: null) over the
     * actual link before this was handled. Fixed with a leaf-preference pass: any candidate that
     * CONTAINS another surviving candidate is dropped, so the more specific element wins the tie
     * instead of the first one `querySelectorAll`'s document-order walk happens to visit. Still an
     * honest heuristic, not a proof — two genuinely SIBLING elements with identical text (a
     * repeated label pattern) are a real remaining ambiguity `nth`/`all` exist to work around.
     */
    async extractText(query, opts = {}) {
        const spec = {
            q: query.toLowerCase().replace(/\s+/g, " ").trim(),
            exact: !!opts.exact,
            role: opts.role || "",
            nth: opts.nth ?? 0,
            all: !!opts.all,
        };
        if (!spec.q)
            throw new Error(`extractText: "query" must be a non-empty string, got ${JSON.stringify(query)}`);
        const js = `(() => {
      const SPEC = ${JSON.stringify(spec)};
      // Wider than locateText's interactive-only SEL: extraction routinely targets plain
      // content, not a control. Interactive tags stay included (extracting a button's label
      // or a select's current value is legitimate too).
      const SEL = 'a,button,input,textarea,select,summary,label,span,p,li,article,td,th,dd,dt,'
        + 'blockquote,figcaption,h1,h2,h3,h4,h5,h6,[role],[aria-label]';
      const seen = new Set(), cand = [];
      const label = (e) => (
        e.getAttribute('aria-label') || (e.innerText || '').trim() || e.value ||
        e.placeholder || e.getAttribute('title') || e.getAttribute('name') || ''
      ).replace(/\\s+/g, ' ').trim();
      const vis = (e) => {
        const r = e.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const s = getComputedStyle(e);
        return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
      };
      const walk = (root) => {
        let all;
        try { all = root.querySelectorAll('*'); } catch { return; }
        for (const e of all) {
          if (e.matches && e.matches(SEL) && !seen.has(e)) {
            seen.add(e);
            if (vis(e)) {
              const tag = e.tagName.toLowerCase();
              const role = e.getAttribute('role') || '';
              if (!SPEC.role || role === SPEC.role) cand.push({ e, t: label(e).toLowerCase(), tag, role });
            }
          }
          if (e.shadowRoot) walk(e.shadowRoot);
        }
      };
      walk(document);
      const scored = cand.map((c) => {
        const t = c.t; let s = -1;
        if (t === SPEC.q) s = 100;
        else if (!SPEC.exact) {
          if (t.startsWith(SPEC.q)) s = 80;
          else if ((' ' + t).includes(' ' + SPEC.q)) s = 60;
          else if (t.includes(SPEC.q)) s = 40;
        }
        return { c, s };
      }).filter((x) => x.s >= 0);
      // Leaf preference (live-verified 2026-08-30 against example.com, judge #7734 test-drive
      // prep): a wrapping <p> and the <a> it contains can both match the SAME query with the
      // SAME score and SAME label length — a plain score+length sort has no way to break that
      // tie and can hand back the generic container with href:null instead of the actual link.
      // Drop any candidate that CONTAINS another surviving candidate — the more specific
      // (deeper/leaf) element is virtually always the one a description like "the X" means.
      const leaves = scored.filter((x) => !scored.some((y) => y !== x && x.c.e.contains(y.c.e)));
      leaves.sort((a, b) => b.s - a.s || a.c.t.length - b.c.t.length);
      const read = (c) => {
        const e = c.e;
        const isField = e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT';
        return {
          tag: c.tag, role: c.role, label: label(e).slice(0, 100),
          text: (e.innerText ?? e.textContent ?? '').trim(),
          value: isField ? (e.value ?? null) : null,
          href: e.tagName === 'A' ? (e.getAttribute('href') || null) : null,
        };
      };
      if (SPEC.all) return leaves.map((s) => read(s.c));
      const pick = leaves[SPEC.nth];
      return pick ? read(pick.c) : null;
    })()`;
        const result = await this.evaluate(js);
        if (opts.all)
            return result ?? [];
        if (!result)
            throw new Error(`extractText: no visible element matching ${JSON.stringify(query)}`);
        return result;
    }
    /**
     * Read several named facts off the current page in ONE call — `fields`
     * maps a name you choose (e.g. "title", "price") to the query extractText
     * would use to find it. Collapses the "read N facts off the same loaded
     * page" tail every scrape ends with (N extractText calls -> 1). Every
     * field is attempted independently and reported honestly: a miss on one
     * field (ok:false + error) does not stop or hide the others.
     */
    async extractMany(fields) {
        const out = {};
        for (const [name, query] of Object.entries(fields)) {
            try {
                out[name] = { ok: true, value: (await this.extractText(query)) };
            }
            catch (e) {
                out[name] = { ok: false, error: String(e?.message ?? e) };
            }
        }
        return out;
    }
    /** Move the cursor along a human curve to a target point. `buttons` mirrors
     *  CDP's bitmask (1 = left button down) — pass 1 while dragging so the move
     *  itself carries mousemove-with-button-held events a drag-and-drop library
     *  listens for, not plain hover moves. */
    async moveTo(target, buttons = 0) {
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
    /**
     * Re-read an element's live centre, instead of trusting the one snapshot()
     * recorded. Any re-render between snapshot and action — a banner appearing,
     * a list growing, an accordion opening, lazy images landing — moves the
     * element, and the recorded centre then points at whatever slid into those
     * coordinates. Dispatching a real mouse event there clicks the wrong thing
     * and throws nothing, which is the worst shape a failure can take for an
     * agent: it looks like it worked.
     *
     * Throws if the node has detached or has no layout box (display:none,
     * removed, collapsed) rather than clicking empty space. Also refreshes the
     * cached centre so a later action on the same ref starts from truth.
     */
    async freshCenter(ref, action) {
        const target = this.refs.get(ref);
        if (!target) {
            throw new Error(`${action}: no element with ref ${ref} — this snapshot has ${this.refs.size} refs. Call snapshot() first.`);
        }
        const center = await this.boxCenter(target.backendNodeId);
        if (!center) {
            throw new Error(`${action}: ref ${ref} is no longer clickable — the node has detached or has no layout box ` +
                `(removed, display:none, or zero-sized). Re-run snapshot() after the page changes.`);
        }
        target.center = center; // keep the cache honest for the next action on this ref
        return center;
    }
    /**
     * Hit-test the point we are about to click: is the target actually the
     * topmost element there? A real mouse event goes to whatever is on top, which
     * on a live page is routinely a cookie banner, a modal backdrop, a sticky
     * header, or a loading veil that hasn't torn down. The overlay takes the
     * click, the target never fires, and nothing throws.
     *
     * Deliberately tuned for PRECISION, not recall — this runs on every click, so
     * a false positive breaks working code, which is the failure that gets a
     * check deleted. Anything in the same containment chain (a <span> inside the
     * button, or a wrapper around it) is treated as a hit. Only a genuinely
     * unrelated topmost element counts as occlusion.
     */
    async assertHittable(ref, p, action) {
        const blocker = await this.callOnRef(ref, `function(x, y){
        // elementFromPoint stops at a shadow HOST — it will not look inside an
        // open shadow root. A web component's real button therefore reads as
        // "covered by <div#host>", which is a false positive on every design
        // system, Salesforce Lightning, and most modern admin panels. Descend
        // through shadow roots to find what is genuinely topmost.
        let top = document.elementFromPoint(x, y);
        if (!top) return "(nothing — the point is outside the viewport; scroll it into view)";
        for (let i = 0; i < 10 && top && top.shadowRoot; i++) {
          const inner = top.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === top) break;
          top = inner;
        }
        // Containment, walking across shadow boundaries in BOTH directions,
        // because contains() does not cross them. Strictly ancestor-or-self —
        // NOT "share an ancestor", which is true of every pair of nodes at
        // <body> and would neuter the check entirely.
        const up = (n) => n.parentNode || n.host || null;
        for (let n = top; n; n = up(n)) if (n === this) return null;   // top is us, or inside us
        for (let n = this; n; n = up(n)) if (n === top) return null;   // we are inside top
        const cls = typeof top.className === "string" && top.className.trim()
          ? "." + top.className.trim().split(/\\s+/)[0] : "";
        return "<" + top.tagName.toLowerCase() + (top.id ? "#" + top.id : "") + cls + ">";
      }`, [p.x, p.y]);
        if (blocker) {
            throw new Error(`${action}: ref ${ref} is covered by ${blocker} — the click would go to that element instead. ` +
                `Dismiss the overlay (cookie banner, modal, sticky header) or scroll, then snapshot() again.`);
        }
    }
    /** Click an element by its snapshot ref. */
    async click(ref) {
        const center = await this.freshCenter(ref, "click");
        await this.assertHittable(ref, center, "click");
        const target = { center };
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
    async dragCore(fromX, fromY, toX, toY) {
        await this.moveTo({ x: fromX, y: fromY });
        await sleep(this.rng.range(30, 90));
        const downCommon = { x: fromX, y: fromY, button: "left", clickCount: 1 };
        await this.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...downCommon });
        await sleep(this.rng.range(40, 100)); // dwell so the library's own drag-start threshold fires
        await this.moveTo({ x: toX, y: toY }, 1); // move WITH the button held — this is what a DnD listener sees as "dragging"
        await sleep(this.rng.range(40, 100));
        const upCommon = { x: toX, y: toY, button: "left", clickCount: 1 };
        await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...upCommon });
    }
    /** Drag an element by snapshot ref to an absolute viewport point. Re-reads the
     *  source centre first — a drag from a stale coordinate grabs whatever moved
     *  into that spot, which on a board UI means dragging the wrong card. */
    async dragRefTo(ref, toX, toY) {
        const from = await this.freshCenter(ref, "dragRefTo");
        await this.dragCore(from.x, from.y, toX, toY);
    }
    /** Drag between two absolute viewport points — for when neither the source
     *  card nor the drop target has a resolvable snapshot ref. */
    async dragAt(fromX, fromY, toX, toY) {
        await this.dragCore(fromX, fromY, toX, toY);
    }
    /**
     * Drag through a sequence of waypoints instead of straight to the target,
     * with a longer dwell at each stop. Two real problems on infinite-canvas
     * editors (n8n, GHL's builder) need this over a straight dragCore:
     *   1. Auto-scroll: dragging a node past the visible edge only pans the
     *      canvas if the pointer LINGERS near the edge — a straight A-to-B move
     *      passes through that zone in one frame and never triggers it. Route
     *      through an edge point, dwell, then continue.
     *   2. Connector snapping: n8n's output->input connection drag highlights
     *      the nearest valid target as you approach it; hovering just short of
     *      the final point before completing gives that highlight a frame to
     *      render, same as a human's hand slowing down on approach.
     */
    async dragPathCore(points) {
        if (points.length < 2)
            throw new Error("dragPath: need at least 2 points (from, ...via, to)");
        const [first, ...rest] = points;
        await this.moveTo(first);
        await sleep(this.rng.range(30, 90));
        const downCommon = { x: first.x, y: first.y, button: "left", clickCount: 1 };
        await this.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...downCommon });
        await sleep(this.rng.range(40, 100)); // dwell so the library's own drag-start threshold fires
        for (const p of rest) {
            await this.moveTo(p, 1); // move WITH the button held
            await sleep(this.rng.range(80, 180)); // longer dwell per waypoint than a plain 2-point drag
        }
        const last = points[points.length - 1];
        await sleep(this.rng.range(40, 100));
        const upCommon = { x: last.x, y: last.y, button: "left", clickCount: 1 };
        await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...upCommon });
    }
    /** Drag an element by ref through a sequence of intermediate viewport points to a final drop. */
    async dragRefToPath(ref, via) {
        const from = await this.freshCenter(ref, "dragRefToPath");
        await this.dragPathCore([from, ...via]);
    }
    /** Drag through a sequence of absolute viewport points (first = pickup, last = drop). */
    async dragAtPath(points) {
        await this.dragPathCore(points);
    }
    /** Bring this page's target to the foreground — CDP Input only routes to the active target. */
    async bringToFront() {
        await this.send("Page.bringToFront");
    }
    /** Trusted click at absolute viewport coords (when you can't resolve a snapshot ref). */
    async clickAt(x, y) {
        await this.moveTo({ x, y });
        await sleep(this.rng.range(30, 90));
        const common = { x, y, button: "left", clickCount: 1 };
        await this.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...common });
        await sleep(this.rng.range(40, 110));
        await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...common });
    }
    /**
     * Double-click: two press/release pairs, second one carrying clickCount:2 —
     * that's the field Chrome actually keys `dblclick` off, not two fast
     * single clicks. Needed for n8n's canvas (double-click a node opens its
     * config panel) and GHL's builder (double-click an element to edit it
     * in place) — a plain click() only selects/focuses on both.
     */
    async doubleClickCore(x, y) {
        await this.moveTo({ x, y });
        await sleep(this.rng.range(30, 90));
        const base = { x, y, button: "left" };
        await this.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, clickCount: 1, ...base });
        await sleep(this.rng.range(20, 40));
        await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, clickCount: 1, ...base });
        await sleep(this.rng.range(30, 80)); // well inside the OS double-click window (~500ms), but not simultaneous
        await this.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, clickCount: 2, ...base });
        await sleep(this.rng.range(20, 40));
        await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, clickCount: 2, ...base });
    }
    /** Double-click an element by snapshot ref. */
    async doubleClick(ref) {
        const center = await this.freshCenter(ref, "doubleClick");
        await this.assertHittable(ref, center, "doubleClick");
        await this.doubleClickCore(center.x, center.y);
    }
    /** Double-click at absolute viewport coords (canvas nodes rarely have a resolvable ref). */
    async doubleClickAt(x, y) {
        await this.doubleClickCore(x, y);
    }
    /**
     * Right-click: opens the context menu — n8n's "add node here" canvas menu,
     * a node's duplicate/delete/pin menu, GHL's element context menu. The menu
     * itself then just needs a normal click() or clickText() on the option.
     */
    async rightClickCore(x, y) {
        await this.moveTo({ x, y });
        await sleep(this.rng.range(30, 90));
        const common = { x, y, button: "right", clickCount: 1 };
        await this.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 2, ...common });
        await sleep(this.rng.range(40, 110));
        await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...common });
    }
    /** Right-click an element by snapshot ref. */
    async rightClick(ref) {
        const center = await this.freshCenter(ref, "rightClick");
        await this.assertHittable(ref, center, "rightClick");
        await this.rightClickCore(center.x, center.y);
    }
    /** Right-click at absolute viewport coords. */
    async rightClickAt(x, y) {
        await this.rightClickCore(x, y);
    }
    /**
     * Dispatch one well-formed key: rawKeyDown, then a `char` event only if the
     * key produces text, then keyUp (no text) — the exact shape press() relies on,
     * always carrying key/code/windowsVirtualKeyCode/nativeVirtualKeyCode so the
     * page never sees a `keyCode === 0` bot-tell. `modifiers` is a CDP bitfield
     * (Alt 1, Ctrl 2, Meta 4, Shift 8) for shortcuts like Ctrl+A.
     */
    async sendKey(opts) {
        const base = {
            key: opts.key,
            code: opts.code,
            windowsVirtualKeyCode: opts.vk,
            nativeVirtualKeyCode: opts.vk,
            ...(opts.modifiers ? { modifiers: opts.modifiers } : {}),
        };
        await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, ...(opts.text ? { text: opts.text } : {}) });
        if (opts.text)
            await this.send("Input.dispatchKeyEvent", { type: "char", ...base, text: opts.text });
        await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    }
    /**
     * Scroll the page by a pixel delta via a real mouse-wheel event dispatched at
     * the current cursor position (positive dy scrolls down, positive dx right).
     * Use it to reveal lazy-loaded / off-screen content before snapshot().
     */
    /**
     * `ctrl:true` sends the wheel event with the Ctrl modifier bit set — this is
     * how a real trackpad pinch-zoom (and Chrome's own Ctrl+scroll zoom) reads
     * at the DOM level, and it's what infinite-canvas libraries (n8n's Vue Flow,
     * most GHL/Webflow-style builders) key their zoom-vs-pan branch off. Plain
     * scroll pans/scrolls the canvas; Ctrl+scroll zooms it.
     */
    async scroll(dx, dy, opts = {}) {
        // Measure whatever's actually scrollable under the cursor BEFORE and AFTER
        // — a wheel event at viewport coords only moves the element under the
        // cursor, not necessarily the page. Reporting "scrolled" unconditionally
        // (the old behavior) was joe's pain-list #7: a nested scroll container
        // (modal body, chat panel, sidebar list) never moved and the tool claimed
        // success anyway. Falls back to window scroll if nothing under the point
        // is independently scrollable.
        const readPos = `(() => {
      const el = document.elementFromPoint(${this.mouse.x}, ${this.mouse.y});
      let n = el;
      while (n && n !== document.body && n.scrollHeight <= n.clientHeight && n.scrollWidth <= n.clientWidth) n = n.parentElement;
      if (n && n !== document.documentElement && (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)) {
        return [n.scrollLeft, n.scrollTop];
      }
      return [window.scrollX, window.scrollY];
    })()`;
        const [beforeX, beforeY] = await this.evaluate(readPos).catch(() => [0, 0]);
        await this.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: this.mouse.x,
            y: this.mouse.y,
            deltaX: dx,
            deltaY: dy,
            modifiers: opts.ctrl ? 2 : 0, // CDP bitfield: Ctrl=2
        });
        await sleep(this.rng.range(80, 200)); // settle, like a human watching content load
        const [afterX, afterY] = await this.evaluate(readPos).catch(() => [beforeX, beforeY]);
        const movedDx = afterX - beforeX, movedDy = afterY - beforeY;
        return { moved: movedDx !== 0 || movedDy !== 0, dx: movedDx, dy: movedDy };
    }
    /** Type text into the focused element with human cadence. Each character is
     *  dispatched as a real keydown/char/keyUp with the right key, code, and
     *  virtual-key code (see keyInfo) — the bare text-only events this used to send
     *  read as keyCode===0 and broke keydown-driven login forms. Characters that
     *  need Shift (uppercase letters, "!"/"@"/…) carry the Shift modifier so
     *  KeyboardEvent.shiftKey agrees with the produced character. */
    async type(text) {
        for (const ch of text) {
            const k = keyInfo(ch);
            await this.sendKey({ key: k.key, code: k.code, vk: k.vk, text: k.text, modifiers: k.shift ? 8 : 0 });
            await sleep(keyDelay(this.rng, ch));
        }
    }
    /** Clear the focused field: select-all (Ctrl+A) then Delete, via the Input
     *  domain like the rest of our key dispatch. Playwright's fill() clears first;
     *  without this, filling a pre-populated input yields "oldnewvalue". Shared by
     *  the public fill() and clear() — both need a real keystroke here, not
     *  execCommand, which some sites' own JS silently reverts. */
    async clearField() {
        await this.sendKey({ key: "a", code: "KeyA", vk: 65, modifiers: 2 }); // Ctrl+A → select all
        await this.sendKey({ key: "Delete", code: "Delete", vk: 46 }); // delete the selection
    }
    /**
     * Click a field, clear any existing value, then type into it.
     *
     * Guarded at both ends, because every step after the click is a BLIND
     * keyboard dispatch to whatever currently holds focus. If focus never landed
     * in an editable field, Ctrl+A selects the whole document, Delete does
     * nothing useful, the text goes nowhere — and fill() used to return
     * successfully, leaving the agent believing a form was filled.
     *
     *  - before touching the page: refuse a target that cannot accept text
     *    (disabled, readonly, or simply not a field), so a bad ref can't clobber
     *    the document selection
     *  - after the click: confirm the element actually took focus. A cookie
     *    banner, modal, or sticky header covering the field swallows the click,
     *    and this is where that shows up as an error instead of as lost text.
     */
    async fill(ref, text) {
        await this.checkEditable(ref, "fill", "nothing was typed");
        await this.focusRef(ref, "fill", "nothing was typed");
        const isNativeField = await this.callOnRef(ref, `function(){ return this.tagName === "INPUT" || this.tagName === "TEXTAREA"; }`);
        if (isNativeField) {
            // Fast path for <input>/<textarea>: set the value once via the native
            // property setter instead of dispatching one real keydown/char/keyUp
            // triple per character. Two problems this fixes at once (2026-08-29,
            // judge #7702 — Bold.org essay textarea):
            //   1. SPEED: ~2900 chars of per-keystroke dispatch took 120s+. One
            //      native-setter call + one 'input' event is ~instant regardless
            //      of length.
            //   2. A live page's own React re-render firing on every single
            //      keystroke (autosave, live word-count, validation) can throw
            //      mid-dispatch on some sites — reproduced as "undefined is not
            //      an object (evaluating 'text')" on a controlled textarea. A
            //      one-shot value commit never gives that per-keystroke render
            //      churn a chance to run, so it can't trip over its own state.
            // `value` travels as a real CDP argument (Runtime.callFunctionOn
            // `arguments`), not interpolated into the function's source text — so
            // non-ASCII (em-dashes, etc.) can never hit a source-string escaping
            // bug the way template-literal interpolation could.
            await this.callOnRef(ref, `function(value){
          const proto = this.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          const prevValue = this.value;
          setter.call(this, value);
          // React (16+) shadows the native value setter with its own and caches the
          // last-known value on a hidden _valueTracker so its synthetic 'change'
          // handler can tell whether a raw 'input' event actually changed anything.
          // Calling the native setter directly (above) writes the DOM value but
          // never updates that tracker, so React still believes the value is
          // whatever it was before — the dispatched 'input' event below gets
          // silently ignored and the framework's own state never updates (this is
          // the documented React controlled-input testing gotcha, same fix RTL/
          // Enzyme use). Resetting the tracker to the OLD value first makes React's
          // own comparison see a real change when 'input' fires.
          const tracker = this._valueTracker;
          if (tracker) tracker.setValue(prevValue);
          this.dispatchEvent(new Event("input", { bubbles: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
        }`, [text]);
        }
        else {
            // contenteditable has no .value/_valueTracker to drive — and execCommand
            // is silently reverted by some sites' own JS (see clearField's comment) —
            // so this path still needs real keystrokes.
            await this.clearField();
            await this.type(text);
        }
    }
    /** Empty a field (input, textarea, or contenteditable) by ref: click it, then
     *  select-all + Delete via the same real Input-domain key dispatch fill() already
     *  relies on — NOT document.execCommand, which some sites' own JS silently
     *  reverts (a real keystroke is indistinguishable from a human's to the page).
     *  Returns the resulting text length so the caller can assert the field is
     *  actually empty instead of trusting the tool's own return value. */
    async clear(ref) {
        await this.checkEditable(ref, "clear", "nothing was changed");
        await this.focusRef(ref, "clear", "nothing was changed");
        await this.clearField();
        return this.callOnRef(ref, `function(){
        const t = this.tagName;
        if (t === "INPUT" || t === "TEXTAREA") return this.value.length;
        // textContent, not innerText: Chromium leaves a lone placeholder <br> in a
        // just-cleared contenteditable, and innerText reads that as "\\n" (length
        // 1) — a false "not actually empty" right after the clear that produced it.
        return (this.textContent || "").length;
      }`);
    }
    /** Shared by fill()/clear(): refuse a ref that can't take text at all (disabled,
     *  readonly, or simply not a field) before either one touches the page — a bad
     *  ref could otherwise clobber whatever the document selection currently holds. */
    async checkEditable(ref, caller, consequence) {
        const state = await this.callOnRef(ref, `function(){
        const t = this.tagName;
        if (this.disabled) return { ok:false, why:"the field is disabled" };
        if (this.readOnly) return { ok:false, why:"the field is readonly" };
        const editable = this.isContentEditable || t === "INPUT" || t === "TEXTAREA";
        if (!editable) return { ok:false, why:"<" + t.toLowerCase() + "> is not an editable field" };
        return { ok:true, why:"" };
      }`);
        if (!state.ok)
            throw new Error(`${caller}: ref ${ref} — ${state.why}. ${consequence}.`);
    }
    /** Shared by fill()/clear(): click a ref and confirm focus actually landed there
     *  before doing anything destructive to the current selection — every step after
     *  the click is a BLIND keyboard dispatch to whatever currently holds focus. A
     *  cookie banner, modal, or sticky header covering the field swallows the click,
     *  and this is where that shows up as an error instead of as lost/mangled text.
     *
     *  document.activeElement stops at a shadow HOST — inside a web component it
     *  returns the host, never the field. Descend through shadow roots or every
     *  shadow-DOM fill/clear reads as "focus didn't land". */
    async focusRef(ref, caller, consequence) {
        await this.click(ref);
        await sleep(this.rng.range(60, 160));
        const focused = await this.callOnRef(ref, `function(){
        let a = document.activeElement;
        for (let i = 0; i < 10 && a && a.shadowRoot && a.shadowRoot.activeElement; i++) a = a.shadowRoot.activeElement;
        return a === this;
      }`);
        if (!focused) {
            throw new Error(`${caller}: ref ${ref} — the click did not put focus in the field, so ${consequence}. ` +
                `Something is probably covering it (cookie banner, modal, sticky header).`);
        }
    }
    /** Resolve a snapshot ref to a live JS object handle (objectId) — the bridge
     *  from an accessibility-tree ref to callFunctionOn, so we can read/drive one
     *  specific element instead of the whole page. */
    async resolveRefObject(ref) {
        const target = this.refs.get(ref);
        if (!target)
            throw new Error(`No element with ref ${ref}. Call snapshot() first.`);
        const { object } = await this.send("DOM.resolveNode", { backendNodeId: target.backendNodeId });
        if (!object?.objectId)
            throw new Error(`Could not resolve ref ${ref} to a live node (it may have detached).`);
        return object.objectId;
    }
    /** Call a function with `this` bound to the element behind a snapshot ref and
     *  return its by-value result. Uses Runtime.callFunctionOn (no Runtime.enable
     *  needed) and always releases the node handle so it can't leak. */
    async callOnRef(ref, fn, args = []) {
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
            return r.result?.value;
        }
        finally {
            this.send("Runtime.releaseObject", { objectId }).catch(() => { });
        }
    }
    /**
     * Set a `<select>` (resolved from a snapshot ref) to `value` and fire the
     * `input` + `change` events a framework listens for — the reliable way to
     * drive a native dropdown, which a click()+type() can't. `value` matches an
     * option's `value`, then its visible label/text. Returns the select's
     * resulting value; throws if the ref isn't a `<select>` or nothing matched.
     */
    async select(ref, value) {
        return this.callOnRef(ref, `function(v){
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
      }`, [value]);
    }
    /**
     * Read one element's rendered text (innerText, falling back to textContent)
     * by snapshot ref. Agents often want a single element's text — a price, a
     * status, a result cell — not the whole-page innerText() dump.
     */
    async text(ref) {
        return this.callOnRef(ref, `function(){ return this.innerText ?? this.textContent ?? ""; }`);
    }
    /**
     * Read one attribute of an element by snapshot ref (e.g. `href`, `value`,
     * `aria-label`, a `data-*`). Returns the raw attribute string, or null if the
     * element has no such attribute.
     */
    async attribute(ref, name) {
        return this.callOnRef(ref, `function(n){ return this.getAttribute(n); }`, [name]);
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
    async screenshot(opts = {}) {
        const params = { format: "png" };
        if (opts.ref != null) {
            const target = this.refs.get(opts.ref);
            if (!target)
                throw new Error(`No element with ref ${opts.ref}. Call snapshot() first.`);
            const { model } = await this.send("DOM.getBoxModel", { backendNodeId: target.backendNodeId });
            const q = model.border; // border box: [x1,y1, x2,y2, x3,y3, x4,y4]
            const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
            const x = Math.min(...xs), y = Math.min(...ys);
            params.clip = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, scale: 1 };
            params.captureBeyondViewport = true; // element may be scrolled out of the viewport
        }
        else if (opts.clip) {
            params.clip = { ...opts.clip, scale: 1 };
            params.captureBeyondViewport = true;
        }
        else if (opts.fullPage) {
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
    async pdf(opts = {}) {
        const { data } = await this.cdp.send("Page.printToPDF", { transferMode: "ReturnAsBase64", printBackground: opts.printBackground ?? true, ...opts }, this.sessionId);
        return Buffer.from(data, "base64");
    }
    /** Poll an expression until truthy (replaces flaky fixed sleeps). Each probe is
     *  bounded by the time remaining, so a wedged page can't make waitFor overrun
     *  its own timeout — it fails as a waitFor timeout, not a 30s evaluate hang. */
    async waitFor(expression, opts = {}) {
        const timeout = opts.timeout ?? 10000;
        const poll = opts.poll ?? 100;
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const remaining = timeout - (Date.now() - start);
            try {
                if (await this.evaluate(`!!(${expression})`, { timeout: remaining }))
                    return;
            }
            catch (e) {
                // A wedged page makes the probe time out — that's a waitFor timeout, not a
                // crash. Any other evaluate error (e.g. a bad expression) propagates.
                if (String(e?.message ?? "").includes("timed out"))
                    break;
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
    async waitForSelector(selector, opts = {}) {
        const timeout = opts.timeout ?? 10000;
        const visible = opts.visible ?? false;
        const sel = JSON.stringify(selector);
        // querySelector does not cross shadow boundaries, so waiting for anything
        // rendered by a web component timed out even though the element was there.
        // Try the light DOM first (the common case, one call), then walk open
        // shadow roots only if that missed.
        const find = `(() => { const q = ${sel};` +
            ` const light = document.querySelector(q); if (light) return light;` +
            ` const walk = (root, depth) => { if (depth > 10) return null;` +
            `   for (const el of root.querySelectorAll("*")) {` +
            `     if (!el.shadowRoot) continue;` +
            `     const hit = el.shadowRoot.querySelector(q); if (hit) return hit;` +
            `     const deeper = walk(el.shadowRoot, depth + 1); if (deeper) return deeper; }` +
            `   return null; };` +
            ` return walk(document, 0); })()`;
        const expr = visible
            ? `(() => { const el = ${find}; if (!el) return false;` +
                ` const r = el.getBoundingClientRect(); const s = getComputedStyle(el);` +
                ` return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; })()`
            : find;
        try {
            await this.waitFor(expr, { timeout, poll: opts.poll });
        }
        catch (e) {
            if (String(e?.message ?? "").includes("waitFor timed out")) {
                throw new Error(`waitForSelector: "${selector}" not found${visible ? " (visible)" : ""} within ${timeout}ms`);
            }
            throw e;
        }
    }
    /**
     * Poll until `needle` appears anywhere in the page's rendered text —
     * including inside shadow roots, which plain innerText/textContent do not
     * cross. The gap this fills (joe's pain-list #5): `waitFor("document.body
     * .innerText.includes('X')")` reported false negatives on text that
     * `evaluate` confirmed WAS present at that exact moment, because
     * `document.body.innerText` alone misses anything rendered inside an open
     * shadow root (a growing share of real sites — YouTube Studio, many design
     * systems). Case-insensitive, whitespace-normalized substring match.
     *
     * On timeout, the error reports a snippet of what the page DOES currently
     * show instead of just failing blind — a wait primitive with false
     * negatives and no diagnostic is worse than none (joe's exact complaint).
     */
    async waitForText(needle, opts = {}) {
        const timeout = opts.timeout ?? 10000;
        const poll = opts.poll ?? 100;
        const q = JSON.stringify(needle.toLowerCase().replace(/\s+/g, " ").trim());
        const expr = `(() => {
      let s = "";
      const walk = (root) => {
        if (!root) return; // mid-navigation, document.body/documentElement can be
                            // transiently null — that's "no text yet", not a crash
        for (const n of root.childNodes) {
          if (n.nodeType === 3) s += n.textContent;
          else if (n.nodeType === 1) { if (n.shadowRoot) walk(n.shadowRoot); walk(n); }
        }
      };
      walk(document.body || document.documentElement);
      return s.toLowerCase().replace(/\\s+/g, " ").includes(${q});
    })()`;
        try {
            await this.waitFor(expr, { timeout, poll });
        }
        catch (e) {
            if (!String(e?.message ?? "").includes("waitFor timed out"))
                throw e;
            const snippet = await this
                .evaluate(`(document.body ? document.body.innerText : "").replace(/\\s+/g, " ").trim().slice(0, 300)`)
                .catch(() => "(couldn't read page text)");
            throw new Error(`waitForText: ${JSON.stringify(needle)} not found within ${timeout}ms. Page currently shows: ${JSON.stringify(snippet)}`);
        }
    }
    /**
     * Wait for a network response whose URL contains `match` (string) or matches
     * it (RegExp), and return its status.
     *
     * The gap this fills: an agent clicks Save, the button goes into a spinner,
     * and the only ways to find out whether the write actually succeeded were to
     * poll the DOM for a toast that may never appear, or to sleep and hope. The
     * status code is the ground truth and it was not reachable at all.
     *
     * Resolves for a matching response even if it arrives before the await —
     * responses seen since the last goto() are checked first, so the very common
     * "click, then wait" ordering doesn't race. `status` is reported as-is; a 500
     * RESOLVES rather than rejecting, because "the request failed" is an answer
     * the caller wants, not an exception. Only a timeout rejects.
     */
    async waitForResponse(match, opts = {}) {
        const timeout = opts.timeout ?? 15_000;
        const hits = (u) => (typeof match === "string" ? u.includes(match) : match.test(u));
        const already = this.recentResponses.find((r) => hits(r.url));
        if (already)
            return already;
        await this.cdp.send("Network.enable", {}, this.sessionId).catch(() => { });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                off();
                const seen = this.recentResponses.length;
                reject(new Error(`waitForResponse: nothing matching ${match} within ${timeout}ms (${seen} response${seen === 1 ? "" : "s"} seen since the last navigation)`));
            }, timeout);
            const off = this.cdp.on("Network.responseReceived", (p) => {
                const url = p?.response?.url ?? "";
                if (!hits(url))
                    return;
                clearTimeout(timer);
                off();
                const status = p.response.status;
                resolve({ url, status, ok: status >= 200 && status < 400 });
            }, this.sessionId);
        });
    }
    /** Keep a small window of recent responses so waitForResponse() can be called
     *  AFTER the click that triggered the request without losing the race. Bounded
     *  so a chatty SPA can't grow it without limit, and cleared on navigation. */
    trackResponses() {
        this.cdp.on("Network.responseReceived", (p) => {
            const url = p?.response?.url ?? "";
            const status = p?.response?.status ?? 0;
            this.recentResponses.push({ url, status, ok: status >= 200 && status < 400 });
            if (this.recentResponses.length > 200)
                this.recentResponses.shift();
        }, this.sessionId);
    }
    /**
     * Turn downloads on and send them to `dir`.
     *
     * Chrome running under CDP cancels downloads by default, so clicking an
     * export/report/invoice link did nothing at all and reported nothing — the
     * agent saw a successful click and no file. This opts the target in and
     * enables the progress events waitForDownload() listens for.
     *
     * `dir` must be an absolute path that already exists; Chrome will not create
     * it, and a missing directory fails silently at the browser layer.
     */
    async enableDownloads(dir) {
        if (!dir.startsWith("/"))
            throw new Error(`enableDownloads: dir must be an absolute path, got ${JSON.stringify(dir)}`);
        this.downloadDir = dir;
        await this.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true }, this.sessionId);
    }
    /**
     * Wait for the next download to finish and return where it landed.
     *
     * Call it AFTER the click that starts the download — the events are tracked
     * from enableDownloads() onward, so a download that completes before you
     * await is still returned rather than lost to a race.
     *
     * Rejects on a download Chrome cancelled, and on timeout, instead of hanging
     * or handing back a path to a file that isn't there.
     */
    async waitForDownload(opts = {}) {
        if (!this.downloadDir)
            throw new Error("waitForDownload: call enableDownloads(dir) first");
        const timeout = opts.timeout ?? 30_000;
        const dir = this.downloadDir;
        const done = this.finishedDownload;
        if (done) {
            this.finishedDownload = null;
            return done;
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`waitForDownload: no download completed within ${timeout}ms`));
            }, timeout);
            const cleanup = () => {
                clearTimeout(timer);
                this.downloadWaiter = null;
            };
            this.downloadWaiter = (err, result) => {
                cleanup();
                if (err)
                    reject(err);
                else
                    resolve({ ...result, path: `${dir.replace(/\/$/, "")}/${result.filename}` });
            };
        });
    }
    /**
     * enableDownloads + trigger + waitForDownload, in the right order, in one call —
     * the sequence agents were hand-rolling for every export/report button on a heavy
     * SPA (Ancestry, GEDCOM tools). `dir` is only required the first time on this page;
     * pass it again to switch directories. `trigger` runs after downloads are armed, so
     * a download that finishes before the trigger's own promise resolves still isn't lost.
     */
    async downloadAfter(trigger, opts = {}) {
        const dir = opts.dir ?? this.downloadDir;
        if (!dir)
            throw new Error("downloadAfter: pass dir (no prior enableDownloads call on this page)");
        if (opts.dir || !this.downloadDir)
            await this.enableDownloads(dir);
        await trigger();
        return this.waitForDownload({ timeout: opts.timeout });
    }
    /** Wire the Browser download events once, at init. */
    trackDownloads() {
        this.cdp.on("Browser.downloadWillBegin", (p) => {
            this.pendingDownloads.set(p.guid, { filename: p.suggestedFilename ?? p.guid, url: p.url ?? "" });
        });
        this.cdp.on("Browser.downloadProgress", (p) => {
            if (p.state === "inProgress")
                return;
            const meta = this.pendingDownloads.get(p.guid) ?? { filename: p.guid, url: "" };
            this.pendingDownloads.delete(p.guid);
            const dir = (this.downloadDir ?? "").replace(/\/$/, "");
            if (p.state === "canceled") {
                const err = new Error(`download of ${JSON.stringify(meta.filename)} was canceled by the browser`);
                if (this.downloadWaiter)
                    this.downloadWaiter(err);
                return;
            }
            const result = { filename: meta.filename, url: meta.url, path: `${dir}/${meta.filename}` };
            if (this.downloadWaiter)
                this.downloadWaiter(null, result);
            else
                this.finishedDownload = result; // completed before anyone awaited — don't lose it
        });
    }
    /**
     * Attach local files to a file `<input>` — even a hidden one — without an OS
     * file picker. Uses CDP DOM.setFileInputFiles (the same primitive Playwright
     * uses under the hood), which sets `input.files` and fires `change` directly.
     * `selector` defaults to the first file input; pass a more specific one if the
     * page has several. Paths must be absolute.
     */
    async uploadFile(paths, selector = 'input[type="file"]') {
        for (const p of paths) {
            if (!p.startsWith("/"))
                throw new Error(`uploadFile: paths must be absolute, got ${JSON.stringify(p)}`);
        }
        const { root } = await this.send("DOM.getDocument", { depth: 0 });
        const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector });
        if (nodeId) {
            await this.send("DOM.setFileInputFiles", { files: paths, nodeId });
            return;
        }
        // DOM.querySelector does not cross shadow boundaries, so a file input owned
        // by a web component looked absent. Fall back to a shadow-piercing search
        // and drive it by objectId instead of nodeId.
        const { result } = await this.send("Runtime.evaluate", {
            expression: `(() => { const q = ${JSON.stringify(selector)};` +
                ` const walk = (root, depth) => { if (depth > 10) return null;` +
                `   const hit = root.querySelector(q); if (hit) return hit;` +
                `   for (const el of root.querySelectorAll("*")) {` +
                `     if (el.shadowRoot) { const deep = walk(el.shadowRoot, depth + 1); if (deep) return deep; } }` +
                `   return null; };` +
                ` return walk(document, 0); })()`,
        });
        const objectId = result?.objectId;
        if (!objectId) {
            throw new Error(`uploadFile: no element matching ${selector} (searched the document and any open shadow roots)`);
        }
        try {
            await this.send("DOM.setFileInputFiles", { files: paths, objectId });
        }
        finally {
            this.send("Runtime.releaseObject", { objectId }).catch(() => { });
        }
    }
    /**
     * Attach files through a control that opens a file picker (e.g. an "Upload
     * files" menu item) WITHOUT an OS dialog. Intercepts the chooser via CDP,
     * clicks the trigger, then feeds the paths to the input it opened for. This is
     * the path for SPAs (like Gemini) that create the `<input>` lazily on click.
     * Paths must be absolute.
     */
    async uploadViaPicker(triggerRef, paths, opts = {}) {
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
        }
        finally {
            await this.send("Page.setInterceptFileChooserDialog", { enabled: false });
        }
    }
    /** Read the page's visible text (for scraping a model response, etc.). */
    async innerText() {
        return this.evaluate("document.body ? document.body.innerText : ''");
    }
    /** Press a single named key on the focused element (Enter, Tab, Escape, arrows,
     *  Delete, Home/End, PageUp/PageDown...). `count` repeats it with a human-ish
     *  gap between each — the difference between one call and a 200-call loop to
     *  walk Backspace across a long field (joe's pain-list #8). */
    async press(key, count = 1) {
        for (let i = 0; i < count; i++) {
            await this.pressOnce(key);
            if (i < count - 1)
                await sleep(keyDelay(this.rng, key.length === 1 ? key : " "));
        }
    }
    async pressOnce(key) {
        const KEYS = {
            Enter: { code: "Enter", vk: 13, text: "\r" },
            Tab: { code: "Tab", vk: 9 },
            Escape: { code: "Escape", vk: 27 },
            Backspace: { code: "Backspace", vk: 8 },
            Delete: { code: "Delete", vk: 46 },
            ArrowDown: { code: "ArrowDown", vk: 40 },
            ArrowUp: { code: "ArrowUp", vk: 38 },
            ArrowLeft: { code: "ArrowLeft", vk: 37 },
            ArrowRight: { code: "ArrowRight", vk: 39 },
            Home: { code: "Home", vk: 36 },
            End: { code: "End", vk: 35 },
            PageUp: { code: "PageUp", vk: 33 },
            PageDown: { code: "PageDown", vk: 34 },
        };
        // Modifier combos: "Control+a", "Shift+Tab", "Control+Shift+k", "Meta+c".
        // Agents need these constantly — select-all before retyping, copy/paste,
        // Shift+Tab to walk a form backwards, Ctrl+Enter to submit — and every one
        // of them was previously unreachable through the public API even though
        // sendKey already understood modifiers.
        const parts = key.split("+");
        const bare = parts.pop() ?? "";
        let modifiers = 0;
        for (const p of parts) {
            const m = p.trim().toLowerCase();
            if (m === "alt")
                modifiers |= 1;
            else if (m === "control" || m === "ctrl")
                modifiers |= 2;
            else if (m === "meta" || m === "cmd" || m === "command")
                modifiers |= 4;
            else if (m === "shift")
                modifiers |= 8;
            else
                throw new Error(`press: unknown modifier ${JSON.stringify(p)} in ${JSON.stringify(key)} (Alt, Control, Meta, Shift)`);
        }
        const named = KEYS[bare];
        if (!named && bare.length !== 1) {
            // Message shape is part of the contract — tests/key-dispatch.test.ts
            // matches on it. Keep "unsupported key <k>" unquoted.
            throw new Error(`press: unsupported key ${bare} — use a single character or one of: ${Object.keys(KEYS).join(", ")}`);
        }
        // With a non-Shift modifier held, the chord is a COMMAND, not text: sending
        // a char event too would type a literal "a" into the field alongside the
        // Ctrl+A. Shift alone still produces text (an uppercase letter).
        const isCommand = (modifiers & ~8) !== 0;
        if (named) {
            await this.sendKey({ key: bare, code: named.code, vk: named.vk, text: isCommand ? undefined : named.text, modifiers });
            return;
        }
        const info = keyInfo(bare);
        await this.sendKey({
            key: info.key,
            code: info.code,
            vk: info.vk,
            text: isCommand ? undefined : info.text,
            modifiers: modifiers || (info.shift ? 8 : 0),
        });
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
    async enableFedCm(opts = {}) {
        const autoSelect = opts.autoSelectFirst ?? true;
        // FedCM is a top-level-page flow: enable it (and every later FedCm.* command)
        // on the MAIN session explicitly, matching the dialogShown listener below —
        // otherwise a useFrame() before sign-in would point these at a child session
        // and the RP's navigator.credentials.get() would hang unresolved.
        await this.cdp.send("FedCm.enable", { disableRejectionDelay: true }, this.sessionId);
        // A prior dismissal drops the IdP into a cooldown where the dialog silently
        // won't reappear; clear it so the next trigger actually shows.
        try {
            await this.cdp.send("FedCm.resetCooldown", {}, this.sessionId);
        }
        catch { }
        if (this.fedcmOff)
            return;
        this.fedcmOff = this.cdp.on("FedCm.dialogShown", (p) => {
            const dialog = {
                dialogId: p.dialogId,
                type: p.dialogType,
                title: p.title,
                subtitle: p.subtitle,
                accounts: (p.accounts ?? []).map((a) => ({
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
                this.selectFedCmAccount(0, dialog.dialogId).catch(() => { });
            }
            const waiter = this.fedcmWaiters.shift();
            if (waiter)
                waiter(dialog);
            else
                this.fedcmQueue.push(dialog);
        }, this.sessionId);
    }
    /** Resolve with the next FedCM dialog (or one already queued since enable). */
    async waitForFedCmDialog(opts = {}) {
        const queued = this.fedcmQueue.shift();
        if (queued)
            return queued;
        return new Promise((resolve, reject) => {
            const waiter = (d) => {
                clearTimeout(timer);
                resolve(d);
            };
            const timer = setTimeout(() => {
                const i = this.fedcmWaiters.indexOf(waiter);
                if (i >= 0)
                    this.fedcmWaiters.splice(i, 1);
                reject(new Error("waitForFedCmDialog: timed out (is FedCM enabled, and are you signed in to the IdP?)"));
            }, opts.timeout ?? 30000);
            this.fedcmWaiters.push(waiter);
        });
    }
    /** Pick an account in the current FedCM dialog (index into dialog.accounts). */
    async selectFedCmAccount(accountIndex = 0, dialogId = this.lastFedcmDialogId) {
        if (!dialogId)
            throw new Error("selectFedCmAccount: no FedCM dialog has appeared yet");
        // Target the main session explicitly (not activeSessionId): this also runs
        // from the dialogShown auto-select handler, which can fire after a useFrame().
        await this.cdp.send("FedCm.selectAccount", { dialogId, accountIndex }, this.sessionId);
    }
    /** Dismiss the current FedCM dialog (decline the sign-in). */
    async dismissFedCm(dialogId = this.lastFedcmDialogId) {
        if (!dialogId)
            return;
        await this.cdp.send("FedCm.dismissDialog", { dialogId, triggerCooldown: false }, this.sessionId);
    }
    /** Stop intercepting FedCM. Call after a sign-in so a later navigation that
     *  probes FedCM isn't left hanging on us. */
    async disableFedCm() {
        this.fedcmOff?.();
        this.fedcmOff = undefined;
        this.fedcmQueue = [];
        this.fedcmWaiters = [];
        try {
            await this.cdp.send("FedCm.disable", {}, this.sessionId);
        }
        catch { }
    }
    /**
     * One call to complete an active federated sign-in: enables FedCM, clicks the
     * "Sign in with Google" button (a snapshot ref), waits for the account
     * chooser, selects an account, and returns it. For passive/one-tap flows that
     * fire on page load, enableFedCm() BEFORE navigating, then
     * waitForFedCmDialog() — the default autoSelectFirst signs you straight in.
     */
    async signInWithFedCm(opts = {}) {
        await this.enableFedCm({ autoSelectFirst: false });
        if (opts.triggerRef != null)
            await this.click(opts.triggerRef);
        const dialog = await this.waitForFedCmDialog({ timeout: opts.timeout });
        const idx = opts.accountIndex ?? 0;
        const account = dialog.accounts[idx];
        if (!account)
            throw new Error(`signInWithFedCm: no account at index ${idx} (dialog had ${dialog.accounts.length})`);
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
    /**
     * Confine this page to a set of origins: any DOCUMENT navigation (top-level or
     * sub-frame) to a host outside the list fails with AccessDenied.
     *
     * This is the mechanism behind the `Browser.connect()` warning. Attaching to a
     * signed-in Chrome hands the agent every session in that profile; an allowlist is
     * how you say "this run may touch github.com and nothing else" instead of trusting
     * it to stay on task.
     *
     * Scope, stated so it is not over-trusted:
     *  - gates NAVIGATION, not subresources. A real page loads images/fonts/scripts from
     *    other origins; gating those breaks every site, and a guard that breaks sites
     *    gets turned off. Cross-origin reads are already stopped by the same-origin policy.
     *  - anything ON an allowed origin is fully reachable, as the signed-in user.
     *  - a beacon-style POST to a non-allowed origin is NOT blocked (it is not a Document).
     */
    async restrictOrigins(origins) {
        this.allowOrigins = origins.filter((o) => o.trim());
        await this.applyFetchInterception();
    }
    /** Lift the origin allowlist. */
    async unrestrictOrigins() {
        this.allowOrigins = [];
        await this.applyFetchInterception();
    }
    async blockPrivateNetwork() {
        if (this.blockPrivateOn)
            return;
        this.blockPrivateOn = true;
        // Learn the main frame so the handler can tell an agent nav from a page's own
        // probe. (Fetch runs on the MAIN session — see applyFetchInterception.)
        try {
            const { frameTree } = await this.cdp.send("Page.getFrameTree", {}, this.sessionId);
            this.mainFrameId = frameTree?.frame?.id;
            this.topPrivate = isPrivateHost(frameTree?.frame?.url ?? "");
        }
        catch { }
        await this.applyFetchInterception();
    }
    /** Lift the private-network block (re-allows localhost/LAN requests). Leaves any
     *  resource blocking in place. */
    async unblockPrivateNetwork() {
        if (!this.blockPrivateOn)
            return;
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
    async blockResources(types = [], opts = {}) {
        for (const t of types) {
            const cdpType = RESOURCE_TYPES[t.toLowerCase()];
            if (!cdpType)
                throw new Error(`blockResources: unknown type "${t}" (known: ${Object.keys(RESOURCE_TYPES).join(", ")})`);
            this.blockedResourceTypes.add(cdpType);
        }
        if (opts.urls)
            this.blockedUrlSubstrings.push(...opts.urls);
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
    fetchPatterns() {
        const patterns = [];
        if (this.blockPrivateOn)
            patterns.push(...PRIVATE_URL_PATTERNS);
        // Documents only — the allowlist gates navigation, so there is no reason to pause
        // (and pay the round-trip on) every image and script the page pulls.
        if (this.allowOrigins.length)
            patterns.push({ urlPattern: "*", resourceType: "Document" });
        for (const t of this.blockedResourceTypes)
            patterns.push({ urlPattern: "*", resourceType: t });
        for (const sub of this.blockedUrlSubstrings)
            patterns.push({ urlPattern: `*${sub}*` });
        return patterns;
    }
    /** Decide the fate of one paused request against every active guard, in one
     *  place. Commands target this.sessionId explicitly: requestPaused fires on the
     *  MAIN session and may arrive after a useFrame() repointed activeSessionId, and
     *  a continue/fail sent to the wrong session can't find the requestId (hang). */
    handleFetchPaused(p) {
        const url = p.request?.url ?? "";
        const rtype = p.resourceType ?? "";
        const requestId = p.requestId;
        const respond = (fn, extra = {}) => this.cdp.send(`Fetch.${fn}`, { requestId, ...extra }, this.sessionId).catch(() => { });
        // 0. Origin allowlist: where may this agent GO? Gates DOCUMENT requests only —
        //    top-level and sub-frame. Subresources are deliberately NOT gated: a real page
        //    pulls images, fonts and scripts from CDNs on other origins, so gating them
        //    breaks every site and the guard gets switched off, which protects nothing.
        //    Cross-origin READS are already stopped by the same-origin policy; what this
        //    closes is the agent navigating to an origin and acting as the signed-in user.
        //    NOTE: no main-frame exemption here, unlike the private-network guard below —
        //    the top-level navigation IS the threat.
        if (this.allowOrigins.length && rtype === "Document" && !isOriginAllowed(url, this.allowOrigins)) {
            return void respond("failRequest", { errorReason: "AccessDenied" });
        }
        // 1. Private-network guard: a PUBLIC page reaching a private host (the scan).
        //    Allowed: the agent's own top-level nav, and a private page's own resources.
        if (this.blockPrivateOn && isPrivateHost(url)) {
            const isMainNav = rtype === "Document" && p.frameId === this.mainFrameId;
            if (!isMainNav && !this.topPrivate)
                return void respond("failRequest", { errorReason: "AccessDenied" });
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
    async applyFetchInterception() {
        const patterns = this.fetchPatterns();
        if (patterns.length === 0) {
            this.fetchOff?.();
            this.fetchOff = undefined;
            try {
                await this.cdp.send("Fetch.disable", {}, this.sessionId);
            }
            catch { }
            return;
        }
        if (!this.fetchOff) {
            const offNav = this.cdp.on("Page.frameNavigated", (p) => {
                const f = p.frame;
                if (f && !f.parentId) {
                    this.mainFrameId = f.id;
                    this.topPrivate = isPrivateHost(f.url ?? "");
                }
            }, this.sessionId);
            const offFetch = this.cdp.on("Fetch.requestPaused", (p) => this.handleFetchPaused(p), this.sessionId);
            this.fetchOff = () => { offNav(); offFetch(); };
        }
        await this.cdp.send("Fetch.enable", { patterns }, this.sessionId);
    }
    /** Close this page and detach its target from the browser. Idempotent. */
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        this.resetRefs();
        this.frameOff?.();
        this.fetchOff?.();
        this.frameSessions = [];
        if (this.targetId) {
            try {
                // Target.closeTarget closes the page/target and frees its resources.
                // Send to browser context (no sessionId) since we're closing the target itself.
                await this.cdp.send("Target.closeTarget", { targetId: this.targetId });
            }
            catch {
                // Target already closed or doesn't exist; this is OK.
            }
        }
        // Clean up any lingering event handlers for this session
        this.cdp.clearHandlers(this.sessionId);
    }
}
