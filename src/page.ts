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
export function isPrivateHost(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  host = host.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (!m) return false;
  const a = +m[1]!, b = +m[2]!;
  return (
    a === 127 ||                       // 127.0.0.0/8 loopback
    a === 10 ||                        // 10.0.0.0/8
    a === 0 ||                         // 0.0.0.0/8
    (a === 192 && b === 168) ||        // 192.168.0.0/16
    (a === 172 && b >= 16 && b <= 31) ||// 172.16.0.0/12
    (a === 169 && b === 254)           // 169.254.0.0/16 link-local
  );
}

// Only these (private) requests are intercepted, so normal browsing keeps its
// exact timing — no global request pause. Globs over-capture slightly (e.g.
// 172.1*); isPrivateHost() is the real gate in the handler. http/https only:
// CDP's Fetch domain does not intercept WebSocket handshakes, so raw ws:// to a
// private host falls back to Chrome's own Private Network Access (a timeout, not
// a uniform block). Real port-scanners (and the :3001/:5900 probes) use HTTP.
const PRIVATE_URL_PATTERNS = ["localhost", "127.", "0.0.0.0", "10.", "192.168.", "172.1", "172.2", "172.3", "169.254.", "[::1]"]
  .flatMap((h) => ["http", "https"].map((s) => ({ urlPattern: `${s}://${h}*` })));

export class Page {
  private rng = new Rng();
  private mouse: Point = { x: 100, y: 100 };
  private refs = new Map<number, { backendNodeId: number; center: Point }>();
  private closed = false;
  // FedCM interception state (see enableFedCm).
  private fedcmOff?: () => void;
  private fedcmQueue: FedCmDialog[] = [];
  private fedcmWaiters: Array<(d: FedCmDialog) => void> = [];
  private lastFedcmDialogId?: string;
  // Private-network block state (see blockPrivateNetwork).
  private blockPrivateOff?: () => void;
  private mainFrameId?: string;
  private topPrivate = false; // is the page's own top-level origin private?

  constructor(
    private cdp: CDP,
    public readonly sessionId: string,
    private targetId?: string,
  ) {}

  /** Enable the domains we use and arm stealth injection on every document. */
  async init(opts: { maskWebgl?: boolean; blockPrivateNetwork?: boolean } = {}) {
    await this.send("Page.enable");
    await this.send("DOM.enable");
    await this.send("Accessibility.enable");
    await this.normalizeUserAgent();
    // Inject stealth before any page script runs, on every navigation/frame.
    // Only mask WebGL on SwiftShader hosts; with a real GPU the authentic vendor
    // is consistent and masking it would be a detectable lie.
    const source = buildStealth({ maskWebgl: opts.maskWebgl ?? false });
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source });
    if (opts.blockPrivateNetwork) await this.blockPrivateNetwork();
  }

  /**
   * Inject cookies before navigating — e.g. a logged-in session transferred
   * from another browser. Each cookie is a CDP CookieParam ({name, value,
   * domain, path, secure, httpOnly, expires?, sameSite?}). Lets the browser
   * ride an existing session instead of re-doing a bot-walled login.
   */
  async setCookies(cookies: Array<Record<string, any>>) {
    await this.send("Network.enable");
    await this.send("Network.setCookies", { cookies });
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

  /** Bring this page's target to the foreground — CDP Input only routes to the active target. */
  async bringToFront() {
    await this.send("Page.bringToFront");
  }

  /** Trusted click at absolute viewport coords (when you can't resolve a snapshot ref). */
  async clickAt(x: number, y: number) {
    await this.moveTo({ x, y });
    await sleep(this.rng.range(30, 90));
    const common = { x, y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...common });
    await sleep(this.rng.range(40, 110));
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

  /**
   * Attach local files to a file `<input>` — even a hidden one — without an OS
   * file picker. Uses CDP DOM.setFileInputFiles (the same primitive Playwright
   * uses under the hood), which sets `input.files` and fires `change` directly.
   * `selector` defaults to the first file input; pass a more specific one if the
   * page has several. Paths must be absolute.
   */
  async uploadFile(paths: string[], selector = 'input[type="file"]') {
    const { root } = await this.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await this.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    });
    if (!nodeId) throw new Error(`uploadFile: no element matching ${selector}`);
    await this.send("DOM.setFileInputFiles", { files: paths, nodeId });
  }

  /**
   * Attach files through a control that opens a file picker (e.g. an "Upload
   * files" menu item) WITHOUT an OS dialog. Intercepts the chooser via CDP,
   * clicks the trigger, then feeds the paths to the input it opened for. This is
   * the path for SPAs (like Gemini) that create the `<input>` lazily on click.
   * Paths must be absolute.
   */
  async uploadViaPicker(triggerRef: number, paths: string[], opts: { timeout?: number } = {}) {
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
    } finally {
      await this.send("Page.setInterceptFileChooserDialog", { enabled: false });
    }
  }

  /** Read the page's visible text (for scraping a model response, etc.). */
  async innerText(): Promise<string> {
    return this.evaluate<string>("document.body ? document.body.innerText : ''");
  }

  /** Press a single named key on the focused element (Enter, Tab, Escape, arrows...). */
  async press(key: string) {
    const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
      Enter: { code: "Enter", vk: 13, text: "\r" },
      Tab: { code: "Tab", vk: 9 },
      Escape: { code: "Escape", vk: 27 },
      Backspace: { code: "Backspace", vk: 8 },
      ArrowDown: { code: "ArrowDown", vk: 40 },
      ArrowUp: { code: "ArrowUp", vk: 38 },
    };
    const k = KEYS[key];
    if (!k) throw new Error(`press: unsupported key ${key}`);
    const base = { key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, ...(k.text ? { text: k.text } : {}) });
    if (k.text) await this.send("Input.dispatchKeyEvent", { type: "char", ...base, text: k.text });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
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
  async enableFedCm(opts: { autoSelectFirst?: boolean } = {}) {
    const autoSelect = opts.autoSelectFirst ?? true;
    await this.send("FedCm.enable", { disableRejectionDelay: true });
    // A prior dismissal drops the IdP into a cooldown where the dialog silently
    // won't reappear; clear it so the next trigger actually shows.
    try { await this.send("FedCm.resetCooldown"); } catch {}
    if (this.fedcmOff) return;
    this.fedcmOff = this.cdp.on(
      "FedCm.dialogShown",
      (p: any) => {
        const dialog: FedCmDialog = {
          dialogId: p.dialogId,
          type: p.dialogType,
          title: p.title,
          subtitle: p.subtitle,
          accounts: (p.accounts ?? []).map((a: any) => ({
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
          this.selectFedCmAccount(0, dialog.dialogId).catch(() => {});
        }
        const waiter = this.fedcmWaiters.shift();
        if (waiter) waiter(dialog);
        else this.fedcmQueue.push(dialog);
      },
      this.sessionId,
    );
  }

  /** Resolve with the next FedCM dialog (or one already queued since enable). */
  async waitForFedCmDialog(opts: { timeout?: number } = {}): Promise<FedCmDialog> {
    const queued = this.fedcmQueue.shift();
    if (queued) return queued;
    return new Promise<FedCmDialog>((resolve, reject) => {
      const waiter = (d: FedCmDialog) => {
        clearTimeout(timer);
        resolve(d);
      };
      const timer = setTimeout(() => {
        const i = this.fedcmWaiters.indexOf(waiter);
        if (i >= 0) this.fedcmWaiters.splice(i, 1);
        reject(new Error("waitForFedCmDialog: timed out (is FedCM enabled, and are you signed in to the IdP?)"));
      }, opts.timeout ?? 30000);
      this.fedcmWaiters.push(waiter);
    });
  }

  /** Pick an account in the current FedCM dialog (index into dialog.accounts). */
  async selectFedCmAccount(accountIndex = 0, dialogId = this.lastFedcmDialogId) {
    if (!dialogId) throw new Error("selectFedCmAccount: no FedCM dialog has appeared yet");
    await this.send("FedCm.selectAccount", { dialogId, accountIndex });
  }

  /** Dismiss the current FedCM dialog (decline the sign-in). */
  async dismissFedCm(dialogId = this.lastFedcmDialogId) {
    if (!dialogId) return;
    await this.send("FedCm.dismissDialog", { dialogId, triggerCooldown: false });
  }

  /** Stop intercepting FedCM. Call after a sign-in so a later navigation that
   *  probes FedCM isn't left hanging on us. */
  async disableFedCm() {
    this.fedcmOff?.();
    this.fedcmOff = undefined;
    this.fedcmQueue = [];
    this.fedcmWaiters = [];
    try { await this.send("FedCm.disable"); } catch {}
  }

  /**
   * One call to complete an active federated sign-in: enables FedCM, clicks the
   * "Sign in with Google" button (a snapshot ref), waits for the account
   * chooser, selects an account, and returns it. For passive/one-tap flows that
   * fire on page load, enableFedCm() BEFORE navigating, then
   * waitForFedCmDialog() — the default autoSelectFirst signs you straight in.
   */
  async signInWithFedCm(opts: { triggerRef?: number; accountIndex?: number; timeout?: number } = {}): Promise<FedCmAccount> {
    await this.enableFedCm({ autoSelectFirst: false });
    if (opts.triggerRef != null) await this.click(opts.triggerRef);
    const dialog = await this.waitForFedCmDialog({ timeout: opts.timeout });
    const idx = opts.accountIndex ?? 0;
    const account = dialog.accounts[idx];
    if (!account) throw new Error(`signInWithFedCm: no account at index ${idx} (dialog had ${dialog.accounts.length})`);
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
  async blockPrivateNetwork() {
    if (this.blockPrivateOff) return;
    // Learn the main frame so we can tell an agent nav from a page's own probe.
    try {
      const { frameTree } = await this.send("Page.getFrameTree");
      this.mainFrameId = frameTree?.frame?.id;
      this.topPrivate = isPrivateHost(frameTree?.frame?.url ?? "");
    } catch {}
    const offNav = this.cdp.on(
      "Page.frameNavigated",
      (p: any) => {
        const f = p.frame;
        if (f && !f.parentId) { this.mainFrameId = f.id; this.topPrivate = isPrivateHost(f.url ?? ""); }
      },
      this.sessionId,
    );
    await this.send("Fetch.enable", { patterns: PRIVATE_URL_PATTERNS });
    const offFetch = this.cdp.on(
      "Fetch.requestPaused",
      (p: any) => {
        const url: string = p.request?.url ?? "";
        // Allow: agent-driven top-level nav, and a private page's own resources.
        // Block: any other private-host request from a public page (the scan).
        const isMainNav = p.resourceType === "Document" && p.frameId === this.mainFrameId;
        if (isPrivateHost(url) && !isMainNav && !this.topPrivate) {
          this.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "AccessDenied" }).catch(() => {});
        } else {
          this.send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
        }
      },
      this.sessionId,
    );
    this.blockPrivateOff = () => { offNav(); offFetch(); };
  }

  /** Lift the private-network block (re-allows localhost/LAN requests). */
  async unblockPrivateNetwork() {
    this.blockPrivateOff?.();
    this.blockPrivateOff = undefined;
    try { await this.send("Fetch.disable"); } catch {}
  }

  /** Close this page and detach its target from the browser. Idempotent. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.refs.clear();
    if (this.targetId) {
      try {
        // Target.closeTarget closes the page/target and frees its resources.
        // Send to browser context (no sessionId) since we're closing the target itself.
        await this.cdp.send("Target.closeTarget", { targetId: this.targetId });
      } catch {
        // Target already closed or doesn't exist; this is OK.
      }
    }
    // Clean up any lingering event handlers for this session
    this.cdp.clearHandlers(this.sessionId);
  }
}
