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
}
export interface LaunchResult {
    webSocketDebuggerUrl: string;
    process: ChildProcess;
    userDataDir: string;
    /** True only for SwiftShader (software) — the page layer should then mask the vendor. */
    maskWebgl: boolean;
    kill: () => void;
}
export declare function launchChrome(opts?: LaunchOptions): Promise<LaunchResult>;
