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
export declare class Page {
    private cdp;
    readonly sessionId: string;
    private targetId?;
    private rng;
    private mouse;
    private refs;
    private closed;
    private fedcmOff?;
    private fedcmQueue;
    private fedcmWaiters;
    private lastFedcmDialogId?;
    constructor(cdp: CDP, sessionId: string, targetId?: string | undefined);
    /** Enable the domains we use and arm stealth injection on every document. */
    init(opts?: {
        maskWebgl?: boolean;
    }): Promise<void>;
    /**
     * Inject cookies before navigating — e.g. a logged-in session transferred
     * from another browser. Each cookie is a CDP CookieParam ({name, value,
     * domain, path, secure, httpOnly, expires?, sameSite?}). Lets the browser
     * ride an existing session instead of re-doing a bot-walled login.
     */
    setCookies(cookies: Array<Record<string, any>>): Promise<void>;
    /**
     * Scrub the "HeadlessChrome" token from the UA and the matching client-hint
     * brands. headless=new leaks it in both navigator.userAgent AND the Sec-CH-UA
     * request headers; setUserAgentOverride with metadata fixes both at once. A
     * no-op for headful Chrome, whose UA is already clean.
     */
    private normalizeUserAgent;
    private send;
    /** Navigate and wait for the load event. */
    goto(url: string, opts?: {
        timeout?: number;
    }): Promise<void>;
    /** Evaluate JS in the page WITHOUT Runtime.enable (avoids the CDP tell). */
    evaluate<T = any>(expression: string): Promise<T>;
    url(): Promise<string>;
    /** Build the numbered element index from the accessibility tree. */
    snapshot(): Promise<Snapshot>;
    private boxCenter;
    /** Move the cursor along a human curve to a target point. */
    private moveTo;
    /** Click an element by its snapshot ref. */
    click(ref: number): Promise<void>;
    /** Bring this page's target to the foreground — CDP Input only routes to the active target. */
    bringToFront(): Promise<void>;
    /** Trusted click at absolute viewport coords (when you can't resolve a snapshot ref). */
    clickAt(x: number, y: number): Promise<void>;
    /** Type text into the focused element with human cadence. */
    type(text: string): Promise<void>;
    /** Click a field then type into it. */
    fill(ref: number, text: string): Promise<void>;
    /** Capture a PNG screenshot (Buffer) — feed to a vision model. */
    screenshot(opts?: {
        fullPage?: boolean;
    }): Promise<Buffer>;
    /** Poll an expression until truthy (replaces flaky fixed sleeps). */
    waitFor(expression: string, opts?: {
        timeout?: number;
        poll?: number;
    }): Promise<void>;
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
    /** Press a single named key on the focused element (Enter, Tab, Escape, arrows...). */
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
    /** Close this page and detach its target from the browser. Idempotent. */
    close(): Promise<void>;
}
