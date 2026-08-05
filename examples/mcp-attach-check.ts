/**
 * End-to-end check for MCP attach mode (VEIL_CDP_URL).
 *
 * Proves the two things attach mode has to get right:
 *   1. the server drives the tab that is ALREADY OPEN, instead of launching a
 *      second Chrome (which would fail on the profile lock) or opening a blank tab;
 *   2. a browser that goes away is noticed, so the server reconnects instead of
 *      answering every later call with "CDP connection closed" until it is restarted.
 *
 * Needs a real Chrome you already started:
 *   DISPLAY=:98 /usr/bin/google-chrome-stable \
 *     --user-data-dir=/home/armani/.config/veil-hamtek \
 *     --remote-debugging-port=9333 --window-size=1920,1080 about:blank &
 *
 *   bun run examples/mcp-attach-check.ts 127.0.0.1:9333
 *
 * Read-only: it never navigates the tab, so it is safe to point at a live session.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const endpoint = process.argv[2] || "127.0.0.1:9333";

// What the browser reports directly — the oracle the MCP's answer has to match.
const list: any[] = await (await fetch(`http://${endpoint}/json/list`)).json();
const openPages = list.filter((t) => t.type === "page" && !/^(devtools|chrome-extension|chrome):\/\//i.test(t.url));
if (!openPages.length) {
  console.log(`FAIL: no ordinary page open at ${endpoint} — open a tab first, there is nothing to attach to`);
  process.exit(1);
}
console.log(`browser has ${openPages.length} page(s); first is ${openPages[0].url.slice(0, 70)}`);

const proc = spawn("bun", ["run", "src/mcp.ts"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, VEIL_CDP_URL: endpoint },
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map<number, (v: any) => void>();
createInterface({ input: proc.stdout! }).on("line", (line) => {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  const done = pending.get(msg.id);
  if (done) { pending.delete(msg.id); done(msg); }
});

let id = 0;
const rpc = (method: string, params: any = {}) =>
  new Promise<any>((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, resolve);
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    setTimeout(() => pending.has(myId) && (pending.delete(myId), reject(new Error(`${method} timed out`))), 30000);
  });

/** veil_eval returns the value JSON-encoded, so a string comes back with its quotes. */
const text = (r: any) => {
  const raw = (r.result?.content || []).map((c: any) => c.text).join("").trim();
  try { const v = JSON.parse(raw); return typeof v === "string" ? v : raw; } catch { return raw; }
};

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "attach-check", version: "0" } });

// 1. Does it drive the tab that was already there?
const url = text(await rpc("tools/call", { name: "veil_eval", arguments: { expression: "location.href" } }));
check("attached to the existing tab", url === openPages[0].url, `MCP sees ${url.slice(0, 70)}`);

// 2. It must not have opened a tab to do that.
const after: any[] = await (await fetch(`http://${endpoint}/json/list`)).json();
const nowPages = after.filter((t) => t.type === "page" && !/^(devtools|chrome-extension|chrome):\/\//i.test(t.url));
check("opened no extra tab", nowPages.length === openPages.length, `${openPages.length} before, ${nowPages.length} after`);

// 3. Second call reuses the same connection and still works.
const title = text(await rpc("tools/call", { name: "veil_eval", arguments: { expression: "document.title" } })).trim();
check("second call works on the same session", title.length > 0, `title ${JSON.stringify(title.slice(0, 40))}`);

proc.kill();

// 4. Recovery: a browser that dies must not poison the server forever. Run against a
//    throwaway headless Chrome on its own port and profile — never the live session,
//    since this phase deliberately kills the browser.
if (process.argv.includes("--recovery")) {
  const PORT = 9444;
  const profile = `${process.env.TMPDIR || "/tmp"}/veil-attach-check-profile`;
  const startChrome = () =>
    spawn("/usr/bin/google-chrome-stable", [
      `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
      "--headless=new", "--no-first-run", "--no-default-browser-check", "about:blank",
    ], { stdio: "ignore", detached: true });
  const waitUp = async () => {
    for (let i = 0; i < 40; i++) {
      try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); return true; } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  };

  let chrome = startChrome();
  if (!(await waitUp())) { console.log("FAIL  recovery: throwaway Chrome never came up"); failures++; }
  else {
    const p2 = spawn("bun", ["run", "src/mcp.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, VEIL_CDP_URL: `127.0.0.1:${PORT}` },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const pend2 = new Map<number, (v: any) => void>();
    createInterface({ input: p2.stdout! }).on("line", (line) => {
      let m: any; try { m = JSON.parse(line); } catch { return; }
      const d = pend2.get(m.id); if (d) { pend2.delete(m.id); d(m); }
    });
    let id2 = 0;
    const rpc2 = (method: string, params: any = {}) =>
      new Promise<any>((resolve, reject) => {
        const my = ++id2;
        pend2.set(my, resolve);
        p2.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
        setTimeout(() => pend2.has(my) && (pend2.delete(my), reject(new Error(`${method} timed out`))), 30000);
      });

    await rpc2("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "attach-check", version: "0" } });
    const before = await rpc2("tools/call", { name: "veil_eval", arguments: { expression: "1+1" } });
    check("recovery: works before the kill", text(before) === "2", `got ${JSON.stringify(text(before))}`);

    process.kill(-chrome.pid!, "SIGKILL");
    await new Promise((r) => setTimeout(r, 2000));
    chrome = startChrome();
    if (!(await waitUp())) { console.log("FAIL  recovery: replacement Chrome never came up"); failures++; }
    else {
      const after2 = await rpc2("tools/call", { name: "veil_eval", arguments: { expression: "1+1" } });
      const got = text(after2);
      check("recovery: reconnects after the browser dies", got === "2",
        got === "2" ? "same server, new browser" : `got ${JSON.stringify(got.slice(0, 80))}`);
    }
    p2.kill();
    try { process.kill(-chrome.pid!, "SIGKILL"); } catch {}
  }
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
