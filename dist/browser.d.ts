/**
 * Browser: the top-level handle. Launches Chrome, opens the CDP socket, and
 * hands out Page objects attached via flat sessions.
 */
import { type LaunchOptions } from "./launcher.js";
import { Page } from "./page.js";
import type { Fingerprint } from "./fingerprint.js";
export declare class Browser {
    private cdp;
    private launch;
    private blockPrivate;
    private allowOrigins;
    private fingerprint?;
    /** True when we ATTACHED to an existing browser rather than launching it.
     *  Gates close(): we must never kill a process we did not start. */
    private attached;
    private constructor();
    static launch(opts?: LaunchOptions): Promise<Browser>;
    /**
     * Attach to an ALREADY-RUNNING Chrome instead of launching one.
     *
     * Why this matters more than it sounds: Chrome locks a `user-data-dir`, so the
     * one profile that carries your real logged-in sessions cannot be opened by a
     * second instance. Before this, driving that profile meant either killing the
     * browser holding it (losing whatever a human was doing) or copying 200MB of
     * profile and losing the live session. Attaching reuses the sessions as they are.
     *
     * That is the difference between "works on sites that allow anonymous access" and
     * "works on the sites that matter", because Google, Reddit, Meta and TikTok score
     * the SESSION rather than the IP — an established profile passes where a fresh one
     * gets a wall.
     *
     * Accepts either form, since one is what Chrome prints and the other is what a
     * human has:
     *   - a ws:// DevTools URL   (from chrome's stderr, or /json/version)
     *   - an http(s):// origin   (e.g. "http://127.0.0.1:9222" — resolved for you)
     *   - a bare "host:port"     (e.g. "127.0.0.1:9222")
     *
     * NOTE: close() on a connected Browser detaches only. It does NOT kill a browser
     * it did not start — tearing down someone else's session as a side effect of
     * cleanup would be the worst possible default.
     */
    static connect(endpoint: string, opts?: {
        blockPrivateNetwork?: boolean;
        allowOrigins?: string[];
        fingerprint?: Fingerprint;
    }): Promise<Browser>;
    /**
     * The tabs that already exist, as initialised Pages.
     *
     * The companion to connect(): after attaching you almost never want a blank tab,
     * you want the page the human already has open and signed in. Skips devtools://
     * and chrome-extension:// targets, which are never what a caller means.
     */
    pages(): Promise<Page[]>;
    /** Open a fresh tab and return an initialised Page. */
    newPage(): Promise<Page>;
    close(): Promise<void>;
}
