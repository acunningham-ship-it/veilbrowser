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
 */
import { createInterface } from "node:readline";
import { Browser } from "./browser.js";
let browser = null;
let page = null;
async function ensurePage() {
    if (!browser)
        browser = await Browser.launch({ headless: process.env.VEIL_HEADLESS === "1" });
    if (!page)
        page = await browser.newPage();
    return page;
}
const TOOLS = [
    { name: "veil_goto", description: "Navigate the browser to a URL (launches Chrome on first call).",
        inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
    { name: "veil_snapshot", description: "Return the page as a numbered list of interactive elements from the accessibility tree. Use the [ref] numbers with veil_click / veil_fill. No CSS selectors needed.",
        inputSchema: { type: "object", properties: {} } },
    { name: "veil_click", description: "Click an element by its snapshot ref (human-like mouse path).",
        inputSchema: { type: "object", properties: { ref: { type: "number" } }, required: ["ref"] } },
    { name: "veil_fill", description: "Click a field by ref and type text into it (human cadence).",
        inputSchema: { type: "object", properties: { ref: { type: "number" }, text: { type: "string" } }, required: ["ref", "text"] } },
    { name: "veil_type", description: "Type text into the currently focused element.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "veil_screenshot", description: "Capture a PNG screenshot of the page (returned as an image for vision).",
        inputSchema: { type: "object", properties: {} } },
    { name: "veil_eval", description: "Evaluate a JS expression in the page and return the value.",
        inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } },
    { name: "veil_fedcm_enable", description: "Arm FedCM interception BEFORE navigating to a site that shows a Google/federated 'one-tap' sign-in on load. Order: veil_fedcm_enable -> veil_goto the sign-in page -> veil_fedcm_signin. (Skip this for an active 'Sign in with Google' button; veil_fedcm_signin arms itself when you pass a triggerRef.)",
        inputSchema: { type: "object", properties: {} } },
    { name: "veil_fedcm_signin", description: "Complete a federated ('Sign in with Google', FedCM) login that Chrome renders as a native chooser no click can reach: waits for the intercepted account chooser, selects an account, and returns it. Pass triggerRef to first click an active sign-in button; omit it for one-tap/passive flows (call veil_fedcm_enable before navigating). accountIndex defaults to 0.",
        inputSchema: { type: "object", properties: { triggerRef: { type: "number" }, accountIndex: { type: "number" } } } },
    { name: "veil_close", description: "Close the browser.", inputSchema: { type: "object", properties: {} } },
];
async function callTool(name, args) {
    if (name === "veil_close") {
        if (browser)
            await browser.close();
        browser = null;
        page = null;
        return { content: [{ type: "text", text: "closed" }] };
    }
    const p = await ensurePage();
    switch (name) {
        case "veil_goto":
            await p.goto(args.url);
            return text(`navigated to ${await p.url()}`);
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
        case "veil_screenshot": {
            const png = await p.screenshot();
            return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
        }
        case "veil_eval":
            return text(JSON.stringify(await p.evaluate(args.expression)));
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
        default:
            throw new Error(`unknown tool: ${name}`);
    }
}
const text = (t) => ({ content: [{ type: "text", text: t }] });
// --- JSON-RPC stdio loop ---
const send = (msg) => {
    process.stdout.write(JSON.stringify(msg) + "\n");
};
async function handle(msg) {
    const { id, method, params } = msg;
    try {
        if (method === "initialize") {
            send({ jsonrpc: "2.0", id, result: {
                    protocolVersion: "2024-11-05",
                    capabilities: { tools: {} },
                    serverInfo: { name: "veil", version: "0.2.0" },
                } });
            return;
        }
        if (method === "notifications/initialized")
            return; // notification, no reply
        if (method === "tools/list")
            return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
        if (method === "tools/call") {
            const result = await callTool(params.name, params.arguments ?? {});
            return send({ jsonrpc: "2.0", id, result });
        }
        if (id !== undefined)
            send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    }
    catch (e) {
        if (id !== undefined)
            send({ jsonrpc: "2.0", id, error: { code: -32603, message: e?.message ?? String(e) } });
    }
}
// Serialize handling: browser state is shared, and a fast request (close) must
// never overtake a slow one (goto). Chain every message through one promise.
let chain = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
    const t = line.trim();
    if (!t)
        return;
    let msg;
    try {
        msg = JSON.parse(t);
    }
    catch {
        return;
    }
    chain = chain.then(() => handle(msg)).catch(() => { });
});
const shutdown = async () => {
    await chain.catch(() => { });
    if (browser)
        await browser.close().catch(() => { });
    process.exit(0);
};
rl.on("close", shutdown); // stdin EOF (e.g. piped input)
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
