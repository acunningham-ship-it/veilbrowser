/**
 * Launches a REAL, unmodified Chrome. To a website, this process IS Chrome —
 * identical TLS, identical JS engine, identical canvas/WebGL/font fingerprint —
 * because it literally is the same binary a human runs.
 *
 * The whole stealth game at launch time is: don't add the switches that
 * Puppeteer/Playwright add. Those tools flip on `--enable-automation` and a
 * batch of `--disable-*` flags that change behaviour in fingerprintable ways.
 * We launch with the flags a normal Chrome uses, minus the noise.
 */
import { type ChildProcess } from "node:child_process";
import type { Fingerprint } from "./fingerprint.js";
export declare function findChrome(): string;
export interface LaunchOptions {
    headless?: boolean;
    userDataDir?: string;
    chromePath?: string;
    windowSize?: {
        width: number;
        height: number;
    };
    /**
     * Virtual-display (Xvfb) resolution — the `screen.*` a page sees. Defaults to a
     * realistic desktop 1920x1080 so the Chrome window sits INSIDE the screen. A
     * virtual display sized to the window (screen === window, window taller than
     * screen) is a classic headless tell; a real monitor is bigger than the window.
     * Only applies to veil's own auto-Xvfb, not an external DISPLAY.
     */
    screenSize?: {
        width: number;
        height: number;
    };
    proxy?: string;
    /**
     * Block visited sites from reaching loopback / private-network hosts (default
     * true). Detectors port-scan 127.0.0.1 from JS to fingerprint the machine's
     * other software; it also leaks your LAN to every page. The agent's own
     * top-level navigation to a private host still works. Set false to allow a
     * page to reach localhost (e.g. driving your own local app via subresources).
     */
    blockPrivateNetwork?: boolean;
    /**
     * Confine the agent to these origins: any DOCUMENT navigation (top-level or
     * sub-frame) to a host outside the list fails with AccessDenied. Empty/omitted =
     * unrestricted. An entry matches its own host and subdomains — `"github.com"`
     * covers `api.github.com` but not `notgithub.com`.
     *
     * This is the mechanism behind the `Browser.connect()` warning: attaching to a
     * signed-in Chrome hands the agent every session in that profile, and an allowlist
     * is how a run says "github.com and nothing else" instead of being trusted to stay
     * on task. Gates NAVIGATION only — subresources still load from any origin, because
     * a guard that breaks CDNs gets switched off. See Page.restrictOrigins().
     */
    allowOrigins?: string[];
    /**
     * WebGL backend:
     *  - "hardware": use the real GPU via ANGLE/EGL → genuine, consistent vendor.
     *    Works headless AND headful (no Xvfb needed). Best stealth — nothing spoofed.
     *  - "software": SwiftShader + a spoofed Intel vendor. For GPU-less hosts only.
     *  - "off": no GL flags.
     *  - "auto" (default): "hardware" if a DRI render node is accessible, else "software".
     */
    gpu?: "hardware" | "software" | "off" | "auto";
    /**
     * Run headful on a virtual X display via Xvfb — "headful on a server". Headful
     * Chrome scores far better against deep fingerprinters than headless (no
     * headless render quirks, real screen size). Default "auto": on when headful is
     * requested (headless:false) and there's no real DISPLAY. Requires Xvfb on PATH.
     */
    xvfb?: boolean;
    extraArgs?: string[];
    /**
     * A coherent {@link Fingerprint} to apply to every page at creation (before its
     * first navigation). Consumed by Browser/Page, not by the Chrome launch itself
     * — launchChrome ignores it. See Page.applyFingerprint().
     */
    fingerprint?: Fingerprint;
}
/**
 * The Chrome flags that are not computed per-launch, split around the three that
 * are (`--user-data-dir`, `--window-size`, `--window-position`).
 *
 * Exported and generated into the Python front end's assets rather than restated
 * there, because these flags ARE part of the stealth surface: drop
 * `--disable-blink-features=AutomationControlled` and `navigator.webdriver` flips
 * to true, which every commercial fingerprinter checks first. A hand-copied second
 * list would be one careless edit away from a silently-detectable browser.
 */
export declare const CHROME_FLAGS_LEAD: string[];
export declare const CHROME_FLAGS_TAIL: string[];
export interface LaunchResult {
    webSocketDebuggerUrl: string;
    process: ChildProcess;
    userDataDir: string;
    /** True only for SwiftShader (software) — the page layer should then mask the vendor. */
    maskWebgl: boolean;
    kill: () => void;
}
export declare function launchChrome(opts?: LaunchOptions): Promise<LaunchResult>;
