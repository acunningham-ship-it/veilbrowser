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
import { type Fingerprint } from "./fingerprint.js";
import { type Point } from "./human.js";
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
/** One actionable element from domSnapshot() — located in-page, addressed by
 *  viewport coordinates (feed x,y straight to clickAt), not an AX-tree ref. */
export interface DomElement {
    /** Position in this snapshot's list (not stable across snapshots). */
    i: number;
    tag: string;
    role: string;
    /** Best available label: aria-label ▸ innerText ▸ value ▸ placeholder ▸ title ▸ name. */
    t: string;
    /** Center of the element in viewport coordinates — pass to clickAt(x, y). */
    x: number;
    y: number;
    w: number;
    h: number;
    editable: boolean;
}
export interface DomSnapshot {
    url: string;
    title: string;
    /** `[0] button "Sign in" @120,340` per line. */
    text: string;
    elements: DomElement[];
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
export declare function isOriginAllowed(url: string, allow: string[]): boolean;
export declare function isPrivateHost(url: string): boolean;
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
export declare function keyInfo(ch: string): {
    key: string;
    code: string;
    vk: number;
    text: string;
    shift: boolean;
};
export declare class Page {
    private cdp;
    readonly sessionId: string;
    private targetId?;
    private rng;
    private mouse;
    private refs;
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
    private refByNode;
    private nextRef;
    private closed;
    private activeSessionId;
    private frameSessions;
    private frameOff?;
    private recentResponses;
    private downloadDir?;
    private pendingDownloads;
    private downloadWaiter;
    private finishedDownload;
    private fedcmOff?;
    private fedcmQueue;
    private fedcmWaiters;
    private lastFedcmDialogId?;
    private blockPrivateOn;
    private allowOrigins;
    private fingerprint?;
    private blockedResourceTypes;
    private blockedUrlSubstrings;
    private fetchOff?;
    private mainFrameId?;
    private topPrivate;
    constructor(cdp: CDP, sessionId: string, targetId?: string | undefined);
    /** Enable the domains we use and arm stealth injection on every document. */
    init(opts?: {
        maskWebgl?: boolean;
        blockPrivateNetwork?: boolean;
        allowOrigins?: string[];
        fingerprint?: Fingerprint;
    }): Promise<void>;
    /** Drop a dead child-frame session (its iframe unmounted or navigated). If it
     *  was the active target, fall back to the main page and clear now-meaningless
     *  refs so the next call errors cleanly instead of acting on a stale frame. */
    private removeFrameSession;
    /** List discovered cross-origin child iframes (same-origin iframes don't need
     *  this — they're already visible to the main session's Accessibility tree). */
    frames(): Promise<Array<{
        index: number;
        url: string;
    }>>;
    /** Point every subsequent snapshot/click/fill/type/eval call at a child iframe
     *  (index from frames()), or back at the main page with null/undefined. Clears
     *  refs — a snapshot ref is only ever valid for the frame it was taken in. */
    useFrame(index?: number | null): void;
    /**
     * Inject cookies before navigating — e.g. a logged-in session transferred
     * from another browser. Each cookie is a CDP CookieParam ({name, value,
     * domain, path, secure, httpOnly, expires?, sameSite?}). Lets the browser
     * ride an existing session instead of re-doing a bot-walled login.
     */
    setCookies(cookies: Array<Record<string, any>>): Promise<void>;
    /**
     * Read the browser's current cookies (the symmetric counterpart to
     * setCookies) — e.g. to export a session established interactively and reuse
     * it elsewhere. Each entry is a CDP Cookie ({name, value, domain, path,
     * expires, size, httpOnly, secure, session, sameSite?, ...}). With no `urls`,
     * returns the cookies visible to the frames the page is currently on; pass
     * `urls` to scope the read to specific origins.
     */
    getCookies(urls?: string[]): Promise<Array<Record<string, any>>>;
    /**
     * Scrub the "HeadlessChrome" token from the UA and the matching client-hint
     * brands. headless=new leaks it in both navigator.userAgent AND the Sec-CH-UA
     * request headers; setUserAgentOverride with metadata fixes both at once. A
     * no-op for headful Chrome, whose UA is already clean.
     */
    private normalizeUserAgent;
    /** Set navigator.userAgent AND the matching Sec-CH-UA client-hint brands
     *  consistently — a UA string without the aligned hints is itself a tell.
     *  Shared by init's HeadlessChrome scrub and the public setUserAgent(). */
    private applyUserAgentOverride;
    /**
     * Override the User-Agent at runtime, keeping the Sec-CH-UA client-hint brands
     * aligned with it (reuses init's normalization path — a bare UA string with
     * mismatched hints is a fingerprint tell). Applies to subsequent requests.
     */
    setUserAgent(userAgent: string): Promise<void>;
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
    applyFingerprint(fp: Fingerprint): Promise<void>;
    /**
     * Set the viewport (and optionally device pixel ratio / mobile emulation) via
     * Emulation.setDeviceMetricsOverride — the page sees this as its
     * window.innerWidth/Height, screen size, and devicePixelRatio. Use it to
     * emulate a phone (`{width:390,height:844,deviceScaleFactor:3,mobile:true}`)
     * or force a fixed desktop size for reproducible screenshots.
     */
    setViewport(opts: {
        width: number;
        height: number;
        deviceScaleFactor?: number;
        mobile?: boolean;
    }): Promise<void>;
    /** Commands go to whichever session is "active" — the main page by default,
     *  or a child iframe's own session after useFrame(). */
    private send;
    /** Navigate and wait. Always the main page, regardless of any active useFrame()
     *  — top-level navigation isn't a per-frame concept. `waitUntil` is "load"
     *  (default) or "networkidle" (no network for ~500ms — better for SPAs that
     *  fetch after the load event). Reset ref/session state so a prior useFrame()
     *  can't leak across the nav and a leftover ref can't click wrong coords. */
    goto(url: string, opts?: {
        timeout?: number;
        waitUntil?: "load" | "networkidle";
    }): Promise<{
        url: string;
        status?: number;
        ok?: boolean;
    }>;
    /** Reload the current page (Page.reload), waiting per `waitUntil`. */
    reload(opts?: {
        timeout?: number;
        waitUntil?: "load" | "networkidle";
    }): Promise<void>;
    /** Go back one entry in session history. Throws if there's nothing earlier. */
    back(opts?: {
        timeout?: number;
        waitUntil?: "load" | "networkidle";
    }): Promise<void>;
    /** Go forward one entry in session history. Throws if there's nothing later. */
    forward(opts?: {
        timeout?: number;
        waitUntil?: "load" | "networkidle";
    }): Promise<void>;
    /** Navigate `delta` entries through session history via
     *  Page.navigateToHistoryEntry (precise, and lets us reject cleanly when the
     *  target entry doesn't exist instead of silently no-op'ing like history.go). */
    private historyGo;
    /** Resolve when the page finishes loading, per the `waitUntil` strategy. */
    private waitForLoad;
    /** Resolve once no network request has been in flight for `idleMs`, or reject
     *  after `timeout`. Tracks in-flight requests over the Network domain — the
     *  right signal for SPAs whose content arrives after the load event. */
    private waitForNetworkIdle;
    /** Evaluate JS in the page WITHOUT Runtime.enable (avoids the CDP tell).
     *  Bounded by `timeout` (default 30s): a wedged renderer — or an
     *  awaitPromise expression that never settles — otherwise leaves this pending
     *  forever, so we race the CDP send against a timer and reject cleanly. */
    evaluate<T = any>(expression: string | ((...args: any[]) => any), opts?: {
        timeout?: number;
    }): Promise<T>;
    url(): Promise<string>;
    /** Drop every ref AND its identity map. Navigation and frame switches invalidate
     *  backendNodeIds wholesale, so keeping the old numbers would be meaningless. */
    private resetRefs;
    /** Build the numbered element index from the accessibility tree. */
    snapshot(): Promise<Snapshot>;
    private boxCenter;
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
    domSnapshot(opts?: {
        max?: number;
    }): Promise<DomSnapshot>;
    /**
     * The matcher behind clickText/fillText. Ranks visible elements against `query`
     * by label: exact ▸ startsWith ▸ word-boundary ▸ substring; ties break toward
     * the shortest (most specific) label, then topmost. Returns the chosen element
     * or null. `nth` selects among equivalents; `editableOnly` restricts to fields.
     */
    findText(query: string, opts?: {
        nth?: number;
        exact?: boolean;
        role?: string;
        editableOnly?: boolean;
    }): Promise<DomElement | null>;
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
    locateText(query: string, opts?: {
        nth?: number;
        exact?: boolean;
        role?: string;
        editableOnly?: boolean;
    }): Promise<DomElement | null>;
    /**
     * Locate the best element matching `query`, scroll it into view and TRUSTED-click
     * its FRESH center — no snapshot ref, works where snapshot() hangs. Throws if
     * nothing matches (so a miss is loud, not a silent no-op that reports success).
     * Returns the element. Verify the RESULT externally — a landed click is not a
     * completed action.
     */
    clickText(query: string, opts?: {
        nth?: number;
        exact?: boolean;
        role?: string;
    }): Promise<DomElement>;
    /**
     * Focus an editable field matched by its label/placeholder/aria text (scrolled
     * into view first), clear it (Ctrl+A) and type `value`. The snapshot-free analogue
     * of fill(ref, text). Throws if no editable field matches. Returns the field.
     */
    fillText(query: string, value: string, opts?: {
        nth?: number;
    }): Promise<DomElement>;
    /** Move the cursor along a human curve to a target point. `buttons` mirrors
     *  CDP's bitmask (1 = left button down) — pass 1 while dragging so the move
     *  itself carries mousemove-with-button-held events a drag-and-drop library
     *  listens for, not plain hover moves. */
    private moveTo;
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
    private freshCenter;
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
    private assertHittable;
    /** Click an element by its snapshot ref. */
    click(ref: number): Promise<void>;
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
    private dragCore;
    /** Drag an element by snapshot ref to an absolute viewport point. Re-reads the
     *  source centre first — a drag from a stale coordinate grabs whatever moved
     *  into that spot, which on a board UI means dragging the wrong card. */
    dragRefTo(ref: number, toX: number, toY: number): Promise<void>;
    /** Drag between two absolute viewport points — for when neither the source
     *  card nor the drop target has a resolvable snapshot ref. */
    dragAt(fromX: number, fromY: number, toX: number, toY: number): Promise<void>;
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
    private dragPathCore;
    /** Drag an element by ref through a sequence of intermediate viewport points to a final drop. */
    dragRefToPath(ref: number, via: Point[]): Promise<void>;
    /** Drag through a sequence of absolute viewport points (first = pickup, last = drop). */
    dragAtPath(points: Point[]): Promise<void>;
    /** Bring this page's target to the foreground — CDP Input only routes to the active target. */
    bringToFront(): Promise<void>;
    /** Trusted click at absolute viewport coords (when you can't resolve a snapshot ref). */
    clickAt(x: number, y: number): Promise<void>;
    /**
     * Double-click: two press/release pairs, second one carrying clickCount:2 —
     * that's the field Chrome actually keys `dblclick` off, not two fast
     * single clicks. Needed for n8n's canvas (double-click a node opens its
     * config panel) and GHL's builder (double-click an element to edit it
     * in place) — a plain click() only selects/focuses on both.
     */
    private doubleClickCore;
    /** Double-click an element by snapshot ref. */
    doubleClick(ref: number): Promise<void>;
    /** Double-click at absolute viewport coords (canvas nodes rarely have a resolvable ref). */
    doubleClickAt(x: number, y: number): Promise<void>;
    /**
     * Right-click: opens the context menu — n8n's "add node here" canvas menu,
     * a node's duplicate/delete/pin menu, GHL's element context menu. The menu
     * itself then just needs a normal click() or clickText() on the option.
     */
    private rightClickCore;
    /** Right-click an element by snapshot ref. */
    rightClick(ref: number): Promise<void>;
    /** Right-click at absolute viewport coords. */
    rightClickAt(x: number, y: number): Promise<void>;
    /**
     * Dispatch one well-formed key: rawKeyDown, then a `char` event only if the
     * key produces text, then keyUp (no text) — the exact shape press() relies on,
     * always carrying key/code/windowsVirtualKeyCode/nativeVirtualKeyCode so the
     * page never sees a `keyCode === 0` bot-tell. `modifiers` is a CDP bitfield
     * (Alt 1, Ctrl 2, Meta 4, Shift 8) for shortcuts like Ctrl+A.
     */
    private sendKey;
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
    scroll(dx: number, dy: number, opts?: {
        ctrl?: boolean;
    }): Promise<void>;
    /** Type text into the focused element with human cadence. Each character is
     *  dispatched as a real keydown/char/keyUp with the right key, code, and
     *  virtual-key code (see keyInfo) — the bare text-only events this used to send
     *  read as keyCode===0 and broke keydown-driven login forms. Characters that
     *  need Shift (uppercase letters, "!"/"@"/…) carry the Shift modifier so
     *  KeyboardEvent.shiftKey agrees with the produced character. */
    type(text: string): Promise<void>;
    /** Clear the focused field: select-all (Ctrl+A) then Delete, via the Input
     *  domain like the rest of our key dispatch. Playwright's fill() clears first;
     *  without this, filling a pre-populated input yields "oldnewvalue". */
    private clearField;
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
    fill(ref: number, text: string): Promise<void>;
    /** Resolve a snapshot ref to a live JS object handle (objectId) — the bridge
     *  from an accessibility-tree ref to callFunctionOn, so we can read/drive one
     *  specific element instead of the whole page. */
    private resolveRefObject;
    /** Call a function with `this` bound to the element behind a snapshot ref and
     *  return its by-value result. Uses Runtime.callFunctionOn (no Runtime.enable
     *  needed) and always releases the node handle so it can't leak. */
    private callOnRef;
    /**
     * Set a `<select>` (resolved from a snapshot ref) to `value` and fire the
     * `input` + `change` events a framework listens for — the reliable way to
     * drive a native dropdown, which a click()+type() can't. `value` matches an
     * option's `value`, then its visible label/text. Returns the select's
     * resulting value; throws if the ref isn't a `<select>` or nothing matched.
     */
    select(ref: number, value: string): Promise<string>;
    /**
     * Read one element's rendered text (innerText, falling back to textContent)
     * by snapshot ref. Agents often want a single element's text — a price, a
     * status, a result cell — not the whole-page innerText() dump.
     */
    text(ref: number): Promise<string>;
    /**
     * Read one attribute of an element by snapshot ref (e.g. `href`, `value`,
     * `aria-label`, a `data-*`). Returns the raw attribute string, or null if the
     * element has no such attribute.
     */
    attribute(ref: number, name: string): Promise<string | null>;
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
    screenshot(opts?: {
        fullPage?: boolean;
        ref?: number;
        clip?: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
    }): Promise<Buffer>;
    /**
     * Render the current page to a PDF (Buffer) via Page.printToPDF. NOTE: Chrome
     * only supports PDF printing in HEADLESS mode — in headful it throws
     * "PrintToPDF is not implemented". Options pass straight through to CDP
     * (landscape, printBackground, scale, paperWidth/Height in inches, margin*,
     * pageRanges, ...); printBackground defaults to true so backgrounds render.
     * Always the main page, like screenshot().
     */
    pdf(opts?: {
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
    }): Promise<Buffer>;
    /** Poll an expression until truthy (replaces flaky fixed sleeps). Each probe is
     *  bounded by the time remaining, so a wedged page can't make waitFor overrun
     *  its own timeout — it fails as a waitFor timeout, not a 30s evaluate hang. */
    waitFor(expression: string, opts?: {
        timeout?: number;
        poll?: number;
    }): Promise<void>;
    /**
     * Poll until a CSS selector matches — the selector-shaped convenience over
     * waitFor(), for the common "wait for this element to appear" case. With
     * {visible:true} it also requires a non-zero layout box and a visible
     * computed style (not display:none / visibility:hidden), so an element that
     * exists in the DOM but is still hidden doesn't resolve early. Throws a
     * selector-named error on timeout.
     */
    waitForSelector(selector: string, opts?: {
        timeout?: number;
        visible?: boolean;
        poll?: number;
    }): Promise<void>;
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
    waitForResponse(match: string | RegExp, opts?: {
        timeout?: number;
    }): Promise<{
        url: string;
        status: number;
        ok: boolean;
    }>;
    /** Keep a small window of recent responses so waitForResponse() can be called
     *  AFTER the click that triggered the request without losing the race. Bounded
     *  so a chatty SPA can't grow it without limit, and cleared on navigation. */
    private trackResponses;
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
    enableDownloads(dir: string): Promise<void>;
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
    waitForDownload(opts?: {
        timeout?: number;
    }): Promise<{
        filename: string;
        path: string;
        url: string;
    }>;
    /** Wire the Browser download events once, at init. */
    private trackDownloads;
    /**
     * Attach local files to a file `<input>` — even a hidden one — without an OS
     * file picker. Uses CDP DOM.setFileInputFiles (the same primitive Playwright
     * uses under the hood), which sets `input.files` and fires `change` directly.
     * `selector` defaults to the first file input; pass a more specific one if the
     * page has several. Paths must be absolute.
     */
    uploadFile(paths: string[], selector?: string): Promise<void>;
    /**
     * Attach files through a control that opens a file picker (e.g. an "Upload
     * files" menu item) WITHOUT an OS dialog. Intercepts the chooser via CDP,
     * clicks the trigger, then feeds the paths to the input it opened for. This is
     * the path for SPAs (like Gemini) that create the `<input>` lazily on click.
     * Paths must be absolute.
     */
    uploadViaPicker(triggerRef: number, paths: string[], opts?: {
        timeout?: number;
    }): Promise<void>;
    /** Read the page's visible text (for scraping a model response, etc.). */
    innerText(): Promise<string>;
    /** Press a single named key on the focused element (Enter, Tab, Escape, arrows,
     *  Delete, Home/End, PageUp/PageDown...). */
    press(key: string): Promise<void>;
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
    enableFedCm(opts?: {
        autoSelectFirst?: boolean;
    }): Promise<void>;
    /** Resolve with the next FedCM dialog (or one already queued since enable). */
    waitForFedCmDialog(opts?: {
        timeout?: number;
    }): Promise<FedCmDialog>;
    /** Pick an account in the current FedCM dialog (index into dialog.accounts). */
    selectFedCmAccount(accountIndex?: number, dialogId?: string | undefined): Promise<void>;
    /** Dismiss the current FedCM dialog (decline the sign-in). */
    dismissFedCm(dialogId?: string | undefined): Promise<void>;
    /** Stop intercepting FedCM. Call after a sign-in so a later navigation that
     *  probes FedCM isn't left hanging on us. */
    disableFedCm(): Promise<void>;
    /**
     * One call to complete an active federated sign-in: enables FedCM, clicks the
     * "Sign in with Google" button (a snapshot ref), waits for the account
     * chooser, selects an account, and returns it. For passive/one-tap flows that
     * fire on page load, enableFedCm() BEFORE navigating, then
     * waitForFedCmDialog() — the default autoSelectFirst signs you straight in.
     */
    signInWithFedCm(opts?: {
        triggerRef?: number;
        accountIndex?: number;
        timeout?: number;
    }): Promise<FedCmAccount>;
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
    restrictOrigins(origins: string[]): Promise<void>;
    /** Lift the origin allowlist. */
    unrestrictOrigins(): Promise<void>;
    blockPrivateNetwork(): Promise<void>;
    /** Lift the private-network block (re-allows localhost/LAN requests). Leaves any
     *  resource blocking in place. */
    unblockPrivateNetwork(): Promise<void>;
    /**
     * Block resource loads — a big speed and footprint win for scraping. Block by
     * type (`["image","font","media","stylesheet"]`) and/or by URL substring
     * (`{ urls: ["analytics","doubleclick"] }`); matching requests are failed via
     * CDP's Fetch domain. Calls accumulate. Coexists with the private-network guard
     * (both share one interception handler). Lift it all with unblockResources().
     * Types accept friendly names (image, font, media, stylesheet, script, xhr,
     * fetch, document, websocket, ...).
     */
    blockResources(types?: string[], opts?: {
        urls?: string[];
    }): Promise<void>;
    /** Lift resource blocking (leaves the private-network guard untouched). */
    unblockResources(): Promise<void>;
    /** The union of Fetch patterns for whatever guards are currently active. Only
     *  matching requests get paused, so anything unblocked keeps its exact timing. */
    private fetchPatterns;
    /** Decide the fate of one paused request against every active guard, in one
     *  place. Commands target this.sessionId explicitly: requestPaused fires on the
     *  MAIN session and may arrive after a useFrame() repointed activeSessionId, and
     *  a continue/fail sent to the wrong session can't find the requestId (hang). */
    private handleFetchPaused;
    /** (Re)configure the shared Fetch interception for the currently-active guards:
     *  register the single requestPaused + frameNavigated listeners once, enable
     *  Fetch with the union of patterns, and fully tear down when nothing is active. */
    private applyFetchInterception;
    /** Close this page and detach its target from the browser. Idempotent. */
    close(): Promise<void>;
}
