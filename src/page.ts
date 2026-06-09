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

const INTERESTING = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
  "menuitem", "menuitemcheckbox", "tab", "switch", "slider", "option",
  "listbox", "spinbutton", "textarea",
]);

export class Page {
  private rng = new Rng();
  private mouse: Point = { x: 100, y: 100 };
  private refs = new Map<number, { backendNodeId: number; center: Point }>();

  constructor(private cdp: CDP, public readonly sessionId: string) {}

  /** Enable the domains we use and arm stealth injection on every document. */
  async init(opts: { maskWebgl?: boolean } = {}) {
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
  private async normalizeUserAgent() {
    const realUA = await this.evaluate<string>("navigator.userAgent");
    const cleanUA = realUA.replace("HeadlessChrome", "Chrome");
    if (cleanUA === realUA) return;
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

  private send<T = any>(method: string, params: Record<string, any> = {}) {
    return this.cdp.send<T>(method, params, this.sessionId);
  }

  /** Navigate and wait for the load event. */
  async goto(url: string, opts: { timeout?: number } = {}) {
    const loaded = this.cdp.once("Page.loadEventFired", {
      sessionId: this.sessionId,
      timeout: opts.timeout ?? 30000,
    });
    await this.send("Page.navigate", { url });
    await loaded;
    await sleep(this.rng.range(150, 400)); // settle, like a human reading
  }

  /** Evaluate JS in the page WITHOUT Runtime.enable (avoids the CDP tell). */
  async evaluate<T = any>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
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

  /** Move the cursor along a human curve to a target point. */
  private async moveTo(target: Point) {
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

  /** Type text into the focused element with human cadence. */
  async type(text: string) {
    for (const ch of text) {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", text: ch });
      await sleep(keyDelay(this.rng, ch));
    }
  }

  /** Click a field then type into it. */
  async fill(ref: number, text: string) {
    await this.click(ref);
    await sleep(this.rng.range(60, 160));
    await this.type(text);
  }

  /** Capture a PNG screenshot (Buffer) — feed to a vision model. */
  async screenshot(opts: { fullPage?: boolean } = {}): Promise<Buffer> {
    const params: any = { format: "png" };
    if (opts.fullPage) params.captureBeyondViewport = true;
    const { data } = await this.send("Page.captureScreenshot", params);
    return Buffer.from(data, "base64");
  }

  /** Poll an expression until truthy (replaces flaky fixed sleeps). */
  async waitFor(expression: string, opts: { timeout?: number; poll?: number } = {}) {
    const timeout = opts.timeout ?? 10000;
    const poll = opts.poll ?? 100;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await this.evaluate<boolean>(`!!(${expression})`)) return;
      await sleep(poll);
    }
    throw new Error(`waitFor timed out: ${expression}`);
  }
}
