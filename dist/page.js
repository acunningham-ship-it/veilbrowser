import { buildStealth } from "./stealth.js";
import { Rng, mousePath, moveDelay, keyDelay, sleep } from "./human.js";
const INTERESTING = new Set([
    "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
    "menuitem", "menuitemcheckbox", "tab", "switch", "slider", "option",
    "listbox", "spinbutton", "textarea",
]);
export class Page {
    cdp;
    sessionId;
    rng = new Rng();
    mouse = { x: 100, y: 100 };
    refs = new Map();
    constructor(cdp, sessionId) {
        this.cdp = cdp;
        this.sessionId = sessionId;
    }
    /** Enable the domains we use and arm stealth injection on every document. */
    async init(opts = {}) {
        await this.send("Page.enable");
        await this.send("DOM.enable");
        await this.send("Accessibility.enable");
        await this.normalizeUserAgent();
        // Inject stealth before any page script runs, on every navigation/frame.
        // Only mask WebGL on SwiftShader hosts; with a real GPU the authentic vendor
        // is consistent and masking it would be a detectable lie.
        const source = buildStealth({ maskWebgl: opts.maskWebgl ?? false });
        await this.send("Page.addScriptToEvaluateOnNewDocument", { source });
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
        const major = (cleanUA.match(/Chrome\/(\d+)/)?.[1]) ?? "148";
        await this.send("Emulation.setUserAgentOverride", {
            userAgent: cleanUA,
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
    send(method, params = {}) {
        return this.cdp.send(method, params, this.sessionId);
    }
    /** Navigate and wait for the load event. */
    async goto(url, opts = {}) {
        const loaded = this.cdp.once("Page.loadEventFired", {
            sessionId: this.sessionId,
            timeout: opts.timeout ?? 30000,
        });
        await this.send("Page.navigate", { url });
        await loaded;
        await sleep(this.rng.range(150, 400)); // settle, like a human reading
    }
    /** Evaluate JS in the page WITHOUT Runtime.enable (avoids the CDP tell). */
    async evaluate(expression) {
        const r = await this.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });
        if (r.exceptionDetails)
            throw new Error(`evaluate: ${r.exceptionDetails.text}`);
        return r.result?.value;
    }
    async url() {
        return this.evaluate("location.href");
    }
    /** Build the numbered element index from the accessibility tree. */
    async snapshot() {
        const { nodes } = await this.send("Accessibility.getFullAXTree");
        this.refs.clear();
        const elements = [];
        let ref = 0;
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
            const center = await this.boxCenter(backendNodeId);
            if (!center)
                continue; // not visible / no layout box
            ref++;
            const value = n.value?.value;
            this.refs.set(ref, { backendNodeId, center });
            elements.push({ ref, role, name, value, center });
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
    /** Move the cursor along a human curve to a target point. */
    async moveTo(target) {
        const path = mousePath(this.mouse, target, this.rng);
        for (const p of path) {
            await this.send("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: p.x,
                y: p.y,
                buttons: 0,
            });
            await sleep(moveDelay(this.rng));
        }
        this.mouse = target;
    }
    /** Click an element by its snapshot ref. */
    async click(ref) {
        const target = this.refs.get(ref);
        if (!target)
            throw new Error(`No element with ref ${ref}. Call snapshot() first.`);
        await this.moveTo(target.center);
        await sleep(this.rng.range(30, 90));
        const common = { x: target.center.x, y: target.center.y, button: "left", clickCount: 1 };
        await this.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...common });
        await sleep(this.rng.range(40, 110)); // press dwell
        await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...common });
    }
    /** Type text into the focused element with human cadence. */
    async type(text) {
        for (const ch of text) {
            await this.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
            await this.send("Input.dispatchKeyEvent", { type: "keyUp", text: ch });
            await sleep(keyDelay(this.rng, ch));
        }
    }
    /** Click a field then type into it. */
    async fill(ref, text) {
        await this.click(ref);
        await sleep(this.rng.range(60, 160));
        await this.type(text);
    }
    /** Capture a PNG screenshot (Buffer) — feed to a vision model. */
    async screenshot(opts = {}) {
        const params = { format: "png" };
        if (opts.fullPage)
            params.captureBeyondViewport = true;
        const { data } = await this.send("Page.captureScreenshot", params);
        return Buffer.from(data, "base64");
    }
    /** Poll an expression until truthy (replaces flaky fixed sleeps). */
    async waitFor(expression, opts = {}) {
        const timeout = opts.timeout ?? 10000;
        const poll = opts.poll ?? 100;
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (await this.evaluate(`!!(${expression})`))
                return;
            await sleep(poll);
        }
        throw new Error(`waitFor timed out: ${expression}`);
    }
}
