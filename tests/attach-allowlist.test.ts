/**
 * Browser.connect({ allowOrigins }) must gate the tabs pages() returns.
 *
 * Found by a security review: pages() built Page objects without ever running
 * restrictOrigins, so in attach mode (the MCP's mode) the allowlist silently did
 * nothing on the exact tab being driven, while newPage() with the same list blocked.
 *
 * Uses a throwaway headless Chrome (random port, --user-data-dir under /tmp). Never
 * attaches to a real profile. Two loopback hostnames on two counting servers.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/index.js";
import { findChrome } from "../src/launcher.js";

const TIMEOUT = 30_000;

describe.skipIf(!!process.env.CI)("allowOrigins on an attached browser", () => {
  let chrome: ChildProcess;
  let dir = "";
  let cdpPort = 0;
  let hitsAllowed = 0;
  let hitsBlocked = 0;
  let allowedSrv: ReturnType<typeof Bun.serve>;
  let blockedSrv: ReturnType<typeof Bun.serve>;
  let browser: Browser | undefined;

  beforeAll(async () => {
    allowedSrv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { hitsAllowed++; return new Response("<h1>ok</h1>", { headers: { "content-type": "text/html" } }); } });
    blockedSrv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { hitsBlocked++; return new Response("<h1>no</h1>", { headers: { "content-type": "text/html" } }); } });
    // pick a random free port for CDP
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    cdpPort = probe.port;
    probe.stop(true);
    dir = mkdtempSync(join(tmpdir(), "veil-attach-allow-"));
    chrome = spawn(findChrome(), [
      "--headless=new", "--no-sandbox", `--remote-debugging-port=${cdpPort}`,
      "--remote-debugging-address=127.0.0.1", `--user-data-dir=${dir}`,
      "--no-first-run", "--no-default-browser-check", "about:blank",
    ], { stdio: "ignore" });
    const deadline = Date.now() + 15_000;
    for (;;) {
      try { if ((await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error("throwaway chrome did not come up");
      await Bun.sleep(150);
    }
  }, TIMEOUT);

  afterAll(async () => {
    await browser?.close();
    if (chrome?.pid) { try { chrome.kill("SIGTERM"); } catch {} }
    await Bun.sleep(500);
    if (dir) rmSync(dir, { recursive: true, force: true });
    allowedSrv?.stop(true);
    blockedSrv?.stop(true);
  });

  it("blocks pages()[0] from navigating off the allowlist, and still allows listed hosts", async () => {
    browser = await Browser.connect(`http://127.0.0.1:${cdpPort}`, {
      blockPrivateNetwork: false,
      allowOrigins: ["127.0.0.1"],
    });
    const pages = await browser.pages();
    expect(pages.length).toBeGreaterThan(0);
    const page = pages[0];

    // positive control: the guard must be able to let the listed host through
    // short timeout: attached tabs never get Page.enable, so loadEventFired may not arrive
    await page.goto(`http://127.0.0.1:${allowedSrv.port}/`, { timeout: 5000 });
    expect(hitsAllowed).toBeGreaterThanOrEqual(1);

    // same server process family, other hostname: must be refused BEFORE any request
    let threw = false;
    try { await page.goto(`http://localhost:${blockedSrv.port}/`, { timeout: 5000 }); } catch { threw = true; }
    expect(threw).toBe(true);
    expect(hitsBlocked).toBe(0);
  }, TIMEOUT);
});
