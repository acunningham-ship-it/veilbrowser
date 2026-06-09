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
export declare class Page {
    private cdp;
    readonly sessionId: string;
    private rng;
    private mouse;
    private refs;
    constructor(cdp: CDP, sessionId: string);
    /** Enable the domains we use and arm stealth injection on every document. */
    init(opts?: {
        maskWebgl?: boolean;
    }): Promise<void>;
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
}
