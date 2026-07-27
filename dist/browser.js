/**
 * Browser: the top-level handle. Launches Chrome, opens the CDP socket, and
 * hands out Page objects attached via flat sessions.
 */
import { launchChrome } from "./launcher.js";
import { CDP } from "./cdp.js";
import { Page } from "./page.js";
export class Browser {
    cdp;
    launch;
    blockPrivate;
    allowOrigins;
    fingerprint;
    attached;
    constructor(cdp, launch, blockPrivate, allowOrigins, fingerprint, 
    /** True when we ATTACHED to an existing browser rather than launching it.
     *  Gates close(): we must never kill a process we did not start. */
    attached = false) {
        this.cdp = cdp;
        this.launch = launch;
        this.blockPrivate = blockPrivate;
        this.allowOrigins = allowOrigins;
        this.fingerprint = fingerprint;
        this.attached = attached;
    }
    static async launch(opts = {}) {
        const launch = await launchChrome(opts);
        const cdp = await CDP.connect(launch.webSocketDebuggerUrl);
        // Default ON: a stealth browser shouldn't let visited sites port-scan your
        // localhost/LAN. Opt out with { blockPrivateNetwork: false }.
        // A `fingerprint`, if given, is applied to every page at creation so a
        // coherent identity is in place before the first navigation.
        return new Browser(cdp, launch, opts.blockPrivateNetwork ?? true, opts.allowOrigins, opts.fingerprint);
    }
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
    static async connect(endpoint, opts = {}) {
        let wsUrl = endpoint;
        if (!/^wss?:\/\//i.test(endpoint)) {
            const origin = /^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`;
            const res = await fetch(`${origin.replace(/\/+$/, "")}/json/version`);
            if (!res.ok) {
                throw new Error(`Browser.connect: ${origin}/json/version returned ${res.status}. ` +
                    `Is Chrome running with --remote-debugging-port, and is the port right?`);
            }
            const info = await res.json();
            wsUrl = info.webSocketDebuggerUrl;
            if (!wsUrl)
                throw new Error(`Browser.connect: ${origin} gave no webSocketDebuggerUrl.`);
        }
        const cdp = await CDP.connect(wsUrl);
        // A stub LaunchResult: we did not start this process, so kill() must be a no-op
        // rather than something that reaches for a pid we do not own.
        const attached = {
            webSocketDebuggerUrl: wsUrl,
            maskWebgl: false,
            kill: () => { },
        };
        return new Browser(cdp, attached, opts.blockPrivateNetwork ?? true, opts.allowOrigins, opts.fingerprint, true);
    }
    /**
     * The tabs that already exist, as initialised Pages.
     *
     * The companion to connect(): after attaching you almost never want a blank tab,
     * you want the page the human already has open and signed in. Skips devtools://
     * and chrome-extension:// targets, which are never what a caller means.
     */
    async pages() {
        const { targetInfos } = await this.cdp.send("Target.getTargets");
        const wanted = (targetInfos || []).filter((t) => t.type === "page" && !/^(devtools|chrome-extension|chrome):\/\//i.test(t.url || ""));
        const out = [];
        for (const t of wanted) {
            const { sessionId } = await this.cdp.send("Target.attachToTarget", {
                targetId: t.targetId,
                flatten: true,
            });
            const page = new Page(this.cdp, sessionId, t.targetId);
            // Deliberately NOT calling init() with a fingerprint on an attached page: the
            // page is already loaded and a human may be looking at it. Re-applying an
            // identity mid-session would change navigator properties under a live document
            // — inconsistent with what the site already fingerprinted, which is worse than
            // not applying it at all.
            out.push(page);
        }
        return out;
    }
    /** Open a fresh tab and return an initialised Page. */
    async newPage() {
        const { targetId } = await this.cdp.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await this.cdp.send("Target.attachToTarget", {
            targetId,
            flatten: true,
        });
        const page = new Page(this.cdp, sessionId, targetId);
        await page.init({
            maskWebgl: this.launch.maskWebgl,
            blockPrivateNetwork: this.blockPrivate,
            allowOrigins: this.allowOrigins,
            fingerprint: this.fingerprint,
        });
        return page;
    }
    async close() {
        // On an ATTACHED browser, detach only. Closing it would destroy a session we do
        // not own — and the whole reason to attach is that the session is valuable.
        if (this.attached) {
            this.cdp.close();
            return;
        }
        try {
            await this.cdp.send("Browser.close");
        }
        catch { }
        this.cdp.close();
        this.launch.kill();
    }
}
