#!/usr/bin/env node
/**
 * Veil MCP server (stdio, JSON-RPC 2.0, newline-delimited).
 *
 * Exposes the Veil browser as tools any MCP-speaking agent can drive — persoje,
 * Claude Code, etc. Hand-rolled (no @modelcontextprotocol/sdk) to keep Veil's
 * zero-dependency story intact. One browser + one active page per server process;
 * extend to a page registry when you need parallel tabs.
 *
 *   bun run src/mcp.ts            # headful (stealthiest)
 *   VEIL_HEADLESS=1 bun run src/mcp.ts
 *   VEIL_USER_DATA_DIR=/path/to/profile bun run src/mcp.ts  # persistent profile
 */
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "./browser.js";
import { PRESETS, Fingerprint } from "./fingerprint.js";
import type { Page } from "./page.js";

let browser: Browser | null = null;
let page: Page | null = null;

async function ensurePage(): Promise<Page> {
  if (!browser) browser = await Browser.launch({
    headless: process.env.VEIL_HEADLESS === "1",
    userDataDir: process.env.VEIL_USER_DATA_DIR,
  });
  if (!page) page = await browser.newPage();
  return page;
}

const TOOLS = [
  { name: "veil_goto", description: "Navigate the browser to a URL (launches Chrome on first call). waitUntil 'load' (default) or 'networkidle' (wait until no network for ~500ms — better for SPAs that fetch after load).",
    inputSchema: { type: "object", properties: { url: { type: "string" }, waitUntil: { type: "string", enum: ["load", "networkidle"] } }, required: ["url"] } },
  { name: "veil_reload", description: "Reload the current page. waitUntil 'load' (default) or 'networkidle'.",
    inputSchema: { type: "object", properties: { waitUntil: { type: "string", enum: ["load", "networkidle"] } } } },
  { name: "veil_back", description: "Go back one entry in session history (errors if there's nothing earlier). waitUntil 'load' (default) or 'networkidle'.",
    inputSchema: { type: "object", properties: { waitUntil: { type: "string", enum: ["load", "networkidle"] } } } },
  { name: "veil_forward", description: "Go forward one entry in session history (errors if there's nothing later). waitUntil 'load' (default) or 'networkidle'.",
    inputSchema: { type: "object", properties: { waitUntil: { type: "string", enum: ["load", "networkidle"] } } } },
  { name: "veil_snapshot", description: "Return the page as a numbered list of interactive elements from the accessibility tree. Use the [ref] numbers with veil_click / veil_fill. No CSS selectors needed.",
    inputSchema: { type: "object", properties: {} } },
  { name: "veil_click", description: "Click an element by its snapshot ref (human-like mouse path).",
    inputSchema: { type: "object", properties: { ref: { type: "number" } }, required: ["ref"] } },
  { name: "veil_fill", description: "Click a field by ref and type text into it (human cadence).",
    inputSchema: { type: "object", properties: { ref: { type: "number" }, text: { type: "string" } }, required: ["ref", "text"] } },
  { name: "veil_type", description: "Type text into the currently focused element.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "veil_select", description: "Set a <select> dropdown (by snapshot ref) to a value and fire input+change — the reliable way to drive a native <select>, which click+type can't. Value matches an option's value, then its visible label/text.",
    inputSchema: { type: "object", properties: { ref: { type: "number" }, value: { type: "string" } }, required: ["ref", "value"] } },
  { name: "veil_press", description: "Press a single named key on the focused element. Use 'Enter' to submit a search box or form (fill a field, then veil_press Enter). Supported: Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp.",
    inputSchema: { type: "object", properties: { key: { type: "string", enum: ["Enter", "Tab", "Escape", "Backspace", "ArrowDown", "ArrowUp"] } }, required: ["key"] } },
  { name: "veil_scroll", description: "Scroll the page by a pixel delta via a real mouse-wheel event (positive dy scrolls down, positive dx scrolls right). Reveals lazy-loaded / off-screen content; re-run veil_snapshot after.",
    inputSchema: { type: "object", properties: { dx: { type: "number", description: "horizontal pixels (default 0)" }, dy: { type: "number", description: "vertical pixels (positive = down)" } }, required: ["dy"] } },
  { name: "veil_set_viewport", description: "Set the viewport size (and optional deviceScaleFactor / mobile emulation) — the page sees this as window.innerWidth/Height, screen size, and devicePixelRatio. Emulate a phone or force a fixed desktop size for reproducible screenshots.",
    inputSchema: { type: "object", properties: { width: { type: "number" }, height: { type: "number" }, deviceScaleFactor: { type: "number", description: "device pixel ratio (default 1)" }, mobile: { type: "boolean", description: "mobile emulation (default false)" } }, required: ["width", "height"] } },
  { name: "veil_set_user_agent", description: "Override the User-Agent at runtime, keeping the Sec-CH-UA client-hint brands aligned with it (a bare UA with mismatched hints is a fingerprint tell).",
    inputSchema: { type: "object", properties: { userAgent: { type: "string" } }, required: ["userAgent"] } },
  { name: "veil_set_fingerprint", description: "Apply a COHERENT fingerprint/profile — UA + client hints + navigator.platform, screen, timezone/locale/geolocation, WebGL vendor/renderer, and seeded canvas/audio noise, all internally consistent. Pass a preset name, random:true (+ optional seed for a deterministic identity), or a full fingerprint object. Call this BEFORE veil_goto for full effect: the injected values take hold on the next navigation; the UA/client-hint/timezone/screen overrides apply immediately. This is coherent identity control, not a magic bullet.",
    inputSchema: { type: "object", properties: {
      preset: { type: "string", enum: Object.keys(PRESETS), description: "a ready-made profile" },
      random: { type: "boolean", description: "build a self-consistent random desktop profile" },
      seed: { type: "number", description: "seed for random (deterministic); implies random" },
      fingerprint: { type: "object", description: "a full Fingerprint object (advanced; must be internally consistent)" },
    } } },
  { name: "veil_block_resources", description: "Block resource loads to speed up scraping and shrink your footprint — by type (image, font, media, stylesheet, script, xhr, fetch, document, websocket, ...) and/or by URL substring. Calls accumulate; coexists with the private-network guard. Lift with veil_unblock_resources.",
    inputSchema: { type: "object", properties: { types: { type: "array", items: { type: "string" }, description: 'resource types to block, e.g. ["image","font","media"]' }, urls: { type: "array", items: { type: "string" }, description: 'URL substrings to block, e.g. ["analytics","doubleclick"]' } } } },
  { name: "veil_unblock_resources", description: "Lift all resource blocking set by veil_block_resources (leaves the private-network guard untouched).",
    inputSchema: { type: "object", properties: {} } },
  { name: "veil_wait_for", description: "Poll a JS expression in the page until it is truthy, instead of a fixed sleep — e.g. \"document.querySelector('.results')\". Returns when the condition holds; errors on timeout.",
    inputSchema: { type: "object", properties: { expression: { type: "string" }, timeout: { type: "number", description: "ms before giving up (default 10000)" }, poll: { type: "number", description: "ms between checks (default 100)" } }, required: ["expression"] } },
  { name: "veil_wait_for_selector", description: "Poll until a CSS selector matches, then return (the selector-shaped convenience over veil_wait_for). Pass visible:true to also require the element to be laid out and not display:none/visibility:hidden. Errors on timeout.",
    inputSchema: { type: "object", properties: { selector: { type: "string" }, timeout: { type: "number", description: "ms before giving up (default 10000)" }, visible: { type: "boolean", description: "also require the element to be visibly rendered (default false)" } }, required: ["selector"] } },
  { name: "veil_click_at", description: "Trusted click at absolute viewport coordinates (x, y). Use when there is no snapshot ref to target — a canvas, map, or custom widget.",
    inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } },
  { name: "veil_get_cookies", description: "Return the browser's current cookies as JSON (name, value, domain, path, expires, httpOnly, secure, sameSite, ...). Symmetric with cookie injection. Optionally pass `urls` to scope the read to specific origins.",
    inputSchema: { type: "object", properties: { urls: { type: "array", items: { type: "string" }, description: "origins to scope the read to (default: the page's current frames)" } } } },
  { name: "veil_upload", description: "Attach local files to a file <input> (even a hidden one) without an OS file picker. Paths must be absolute. selector defaults to the first input[type=file]; pass a specific one if the page has several.",
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, description: "absolute file paths" }, selector: { type: "string", description: "CSS selector for the file input (default input[type=\"file\"])" } }, required: ["paths"] } },
  { name: "veil_upload_via_picker", description: "Attach files through a control that opens a file picker (SPAs like Gemini that create the <input> lazily on click). Pass the snapshot ref of the trigger element and absolute file paths.",
    inputSchema: { type: "object", properties: { triggerRef: { type: "number" }, paths: { type: "array", items: { type: "string" }, description: "absolute file paths" }, timeout: { type: "number", description: "ms to wait for the file chooser (default 15000)" } }, required: ["triggerRef", "paths"] } },
  { name: "veil_text", description: "Read one element's rendered text (innerText) by snapshot ref — a price, status, or result cell — without dumping the whole page.",
    inputSchema: { type: "object", properties: { ref: { type: "number" } }, required: ["ref"] } },
  { name: "veil_attribute", description: "Read one attribute of an element by snapshot ref (e.g. href, value, aria-label, a data-* attribute). Returns the raw string, or null if absent.",
    inputSchema: { type: "object", properties: { ref: { type: "number" }, name: { type: "string" } }, required: ["ref", "name"] } },
  { name: "veil_screenshot", description: "Capture a PNG screenshot (returned as an image for vision). Default is the current viewport. Pass a snapshot `ref` to shoot just that element's bounding box, `clip` for an explicit {x,y,width,height} page rectangle, or `fullPage:true` for the whole scrollable page.",
    inputSchema: { type: "object", properties: { ref: { type: "number", description: "snapshot ref — shoot just this element" }, fullPage: { type: "boolean", description: "capture the whole scrollable page" }, clip: { type: "object", description: "explicit page-coordinate rectangle", properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } }, required: ["x", "y", "width", "height"] } } } },
  { name: "veil_eval", description: "Evaluate a JS expression in the page and return the value.",
    inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } },
  { name: "veil_pdf", description: "Render the current page to a PDF and save it to disk — Chrome prints PDF in HEADLESS mode only (VEIL_HEADLESS=1). Pass `path` for the output file, or omit to write a temp file; returns the saved path. Options: landscape, printBackground (default true), scale, pageRanges.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "output .pdf path (default: a temp file)" }, landscape: { type: "boolean" }, printBackground: { type: "boolean" }, scale: { type: "number" }, pageRanges: { type: "string", description: 'e.g. "1-3, 5"' } } } },
  { name: "veil_fedcm_enable", description: "Arm FedCM interception BEFORE navigating to a site that shows a Google/federated 'one-tap' sign-in on load. Order: veil_fedcm_enable -> veil_goto the sign-in page -> veil_fedcm_signin. (Skip this for an active 'Sign in with Google' button; veil_fedcm_signin arms itself when you pass a triggerRef.)",
    inputSchema: { type: "object", properties: {} } },
  { name: "veil_fedcm_signin", description: "Complete a federated ('Sign in with Google', FedCM) login that Chrome renders as a native chooser no click can reach: waits for the intercepted account chooser, selects an account, and returns it. Pass triggerRef to first click an active sign-in button; omit it for one-tap/passive flows (call veil_fedcm_enable before navigating). accountIndex defaults to 0.",
    inputSchema: { type: "object", properties: { triggerRef: { type: "number" }, accountIndex: { type: "number" } } } },
  { name: "veil_close", description: "Close the browser.", inputSchema: { type: "object", properties: {} } },
  { name: "veil_drag", description: "Drag from one point to another — real mousedown -> mousemove(button held) -> mouseup, not the HTML5 drag events. Use this for 'drag a card onto a canvas' UIs (site/page builders, Kanban boards, sortable lists) whose drop targets don't respond to a plain click. Pass `ref` for the source if it has a snapshot ref, otherwise `fromX`/`fromY`; the destination is almost always a plain div with no ref, so give `toX`/`toY` read off a veil_screenshot.",
    inputSchema: { type: "object", properties: { ref: { type: "number" }, fromX: { type: "number" }, fromY: { type: "number" }, toX: { type: "number" }, toY: { type: "number" } }, required: ["toX", "toY"] } },
  { name: "veil_frames", description: "List cross-origin child iframes discovered on the current page (e.g. a drag-and-drop site builder whose whole canvas is one iframe on a different subdomain). Same-origin iframes don't need this — they already show up in a normal veil_snapshot. Call after veil_goto if a page you expect to interact with returns '(no interactive elements)'.",
    inputSchema: { type: "object", properties: {} } },
  { name: "veil_use_frame", description: "Point every following veil_snapshot/veil_click/veil_fill/veil_type/veil_eval call at one child iframe (index from veil_frames), instead of the main page. Omit index (or pass null) to switch back to the main page. Existing refs are invalidated on switch — call veil_snapshot again after switching.",
    inputSchema: { type: "object", properties: { index: { type: ["number", "null"] } } } },
];

async function callTool(name: string, args: any): Promise<any> {
  if (name === "veil_close") {
    if (browser) await browser.close();
    browser = null;
    page = null;
    return { content: [{ type: "text", text: "closed" }] };
  }
  const p = await ensurePage();
  switch (name) {
    case "veil_goto": {
      const res = await p.goto(args.url, { waitUntil: args.waitUntil });
      return text(`navigated to ${await p.url()}${res.status != null ? ` (HTTP ${res.status})` : ""}`);
    }
    case "veil_reload":
      await p.reload({ waitUntil: args.waitUntil });
      return text(`reloaded ${await p.url()}`);
    case "veil_back":
      await p.back({ waitUntil: args.waitUntil });
      return text(`back to ${await p.url()}`);
    case "veil_forward":
      await p.forward({ waitUntil: args.waitUntil });
      return text(`forward to ${await p.url()}`);
    case "veil_snapshot": {
      const s = await p.snapshot();
      return text(`# ${s.title}\n${s.url}\n\n${s.text || "(no interactive elements)"}`);
    }
    case "veil_click":
      await p.click(args.ref);
      return text(`clicked [${args.ref}]`);
    case "veil_fill":
      await p.fill(args.ref, args.text);
      return text(`filled [${args.ref}]`);
    case "veil_type":
      await p.type(args.text);
      return text(`typed ${args.text.length} chars`);
    case "veil_press":
      await p.press(args.key);
      return text(`pressed ${args.key}`);
    case "veil_select":
      return text(`set <select> [${args.ref}] to ${JSON.stringify(await p.select(args.ref, args.value))}`);
    case "veil_scroll":
      await p.scroll(args.dx ?? 0, args.dy ?? 0);
      return text(`scrolled (${args.dx ?? 0}, ${args.dy ?? 0})`);
    case "veil_set_viewport":
      await p.setViewport({ width: args.width, height: args.height, deviceScaleFactor: args.deviceScaleFactor, mobile: args.mobile });
      return text(`viewport set to ${args.width}x${args.height}${args.mobile ? " (mobile)" : ""}`);
    case "veil_set_user_agent":
      await p.setUserAgent(args.userAgent);
      return text(`user-agent set`);
    case "veil_set_fingerprint": {
      let fp;
      if (args.fingerprint) fp = args.fingerprint;
      else if (args.preset) {
        fp = PRESETS[args.preset];
        if (!fp) throw new Error(`unknown preset "${args.preset}" (known: ${Object.keys(PRESETS).join(", ")})`);
      } else if (args.random || args.seed != null) fp = Fingerprint.random(args.seed);
      else throw new Error("veil_set_fingerprint: provide a preset name, random:true (+optional seed), or a full fingerprint object");
      await p.applyFingerprint(fp);
      return text(`fingerprint applied: ${fp.platform} — ${fp.userAgent}`);
    }
    case "veil_block_resources":
      await p.blockResources(args.types ?? [], { urls: args.urls });
      return text(`blocking ${(args.types ?? []).length} type(s), ${(args.urls ?? []).length} url pattern(s)`);
    case "veil_unblock_resources":
      await p.unblockResources();
      return text("resource blocking lifted");
    case "veil_wait_for":
      await p.waitFor(args.expression, { timeout: args.timeout, poll: args.poll });
      return text(`condition met: ${args.expression}`);
    case "veil_wait_for_selector":
      await p.waitForSelector(args.selector, { timeout: args.timeout, visible: args.visible });
      return text(`selector matched: ${args.selector}`);
    case "veil_click_at":
      await p.clickAt(args.x, args.y);
      return text(`clicked at (${args.x}, ${args.y})`);
    case "veil_get_cookies":
      return text(JSON.stringify(await p.getCookies(args.urls), null, 2));
    case "veil_upload":
      await p.uploadFile(args.paths, args.selector);
      return text(`uploaded ${args.paths.length} file(s)`);
    case "veil_upload_via_picker":
      await p.uploadViaPicker(args.triggerRef, args.paths, { timeout: args.timeout });
      return text(`uploaded ${args.paths.length} file(s) via picker`);
    case "veil_text":
      return text(await p.text(args.ref));
    case "veil_attribute": {
      const v = await p.attribute(args.ref, args.name);
      return text(v === null ? "null" : v);
    }
    case "veil_screenshot": {
      const png = await p.screenshot({ ref: args.ref, fullPage: args.fullPage, clip: args.clip });
      return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
    }
    case "veil_eval":
      return text(JSON.stringify(await p.evaluate(args.expression)));
    case "veil_pdf": {
      const { path: outPath, ...pdfOpts } = args;
      const buf = await p.pdf(pdfOpts);
      const dest = outPath ?? join(tmpdir(), `veil-${Date.now()}.pdf`);
      writeFileSync(dest, buf);
      return text(`saved PDF (${buf.length} bytes) to ${dest}`);
    }
    case "veil_fedcm_enable":
      await p.enableFedCm({ autoSelectFirst: false });
      return text("FedCM armed. Navigate to the sign-in page (one-tap fires on load), then call veil_fedcm_signin.");
    case "veil_fedcm_signin": {
      if (args.triggerRef != null) {
        await p.enableFedCm({ autoSelectFirst: false });
        await p.click(args.triggerRef);
      }
      const dialog = await p.waitForFedCmDialog({ timeout: args.timeout ?? 30000 });
      const idx = args.accountIndex ?? 0;
      const account = dialog.accounts[idx];
      if (!account) {
        await p.dismissFedCm();
        throw new Error(`FedCM dialog had ${dialog.accounts.length} account(s); none at index ${idx}`);
      }
      await p.selectFedCmAccount(idx, dialog.dialogId);
      await p.disableFedCm();
      return text(`signed in via FedCM as ${account.email ?? account.name ?? account.accountId}`);
    }
    case "veil_drag":
      if (args.ref != null) await p.dragRefTo(args.ref, args.toX, args.toY);
      else await p.dragAt(args.fromX, args.fromY, args.toX, args.toY);
      return text(`dragged to (${args.toX}, ${args.toY})`);
    case "veil_frames": {
      const frames = await p.frames();
      if (!frames.length) return text("(no cross-origin child iframes discovered yet — they're detected as they attach, right after veil_goto)");
      return text(frames.map((f) => `[${f.index}] ${f.url}`).join("\n"));
    }
    case "veil_use_frame":
      p.useFrame(args.index ?? null);
      return text(args.index == null ? "switched to main page" : `switched to frame [${args.index}]`);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

const text = (t: string) => ({ content: [{ type: "text", text: t }] });
// A tool-execution failure. Per MCP spec this is a *successful* JSON-RPC
// response carrying isError:true, so the model reads the message and self-
// corrects — not a JSON-RPC error, which many clients treat as an opaque hard-fail.
const errorResult = (msg: string) => ({ content: [{ type: "text", text: msg }], isError: true });

// --- JSON-RPC stdio loop ---
const send = (msg: any): void => {
  process.stdout.write(JSON.stringify(msg) + "\n");
};

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "veil", version: "0.3.0" },
      } });
      return;
    }
    if (method === "notifications/initialized") return; // notification, no reply
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      const name = params?.name;
      // Unknown tool is a genuine PROTOCOL error (bad method) -> JSON-RPC error.
      if (!TOOLS.some((t) => t.name === name)) {
        if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool: ${name}` } });
        return;
      }
      // A tool that THROWS during execution (nav timeout, "No element with ref
      // 5", upload path missing, ...) is not a protocol failure — return it as a
      // successful result with isError:true so the agent can read it and retry.
      try {
        const result = await callTool(name, params.arguments ?? {});
        return send({ jsonrpc: "2.0", id, result });
      } catch (e: any) {
        return send({ jsonrpc: "2.0", id, result: errorResult(e?.message ?? String(e)) });
      }
    }
    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e: any) {
    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32603, message: e?.message ?? String(e) } });
  }
}

// Serialize handling: browser state is shared, and a fast request (close) must
// never overtake a slow one (goto). Chain every message through one promise.
let chain: Promise<void> = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: any;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }
  chain = chain.then(() => handle(msg)).catch(() => {});
});

const shutdown = async () => {
  await chain.catch(() => {});
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
};
rl.on("close", shutdown);   // stdin EOF (e.g. piped input)
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
