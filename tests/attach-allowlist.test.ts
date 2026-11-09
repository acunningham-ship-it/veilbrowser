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
      "--no-first-run", "--no-default-browser-check",
      // public.test resolves to loopback for Chrome, but veil's isPrivateHost sees a public name
      "--host-resolver-rules=MAP public.test 127.0.0.1", "about:blank",
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

  it("an attached tab gets load events: goto returns on load, not at the timeout", async () => {
    const [page] = await browser!.pages();
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${allowedSrv.port}/fast`, { timeout: 10_000 });
    expect(Date.now() - t0).toBeLessThan(3000);
  }, TIMEOUT);

  it("blockPrivateNetwork covers an attached tab: a public page cannot reach a private host", async () => {
    await browser?.close();
    browser = await Browser.connect(`http://127.0.0.1:${cdpPort}`); // blockPrivateNetwork defaults on
    const [page] = await browser.pages();
    // a page on public.test (a public name to veil) whose <img> probes a loopback host
    const probe = `http://127.0.0.1:${blockedSrv.port}/probe.png`;
    const pub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => new Response(`<img src="${probe}?${new URL(r.url).search.slice(1)}">`, { headers: { "content-type": "text/html" } }) });
    try {
      const before = hitsBlocked;
      await page.goto(`http://public.test:${pub.port}/?1`, { timeout: 5000 });
      await Bun.sleep(800);
      expect(hitsBlocked).toBe(before);
      // what the fleet relies on (30-day transcripts: every private-host call is a top-level goto):
      // with the guard ON, the agent's own navigation to a loopback page still loads that page's
      // loopback resources. Only a PUBLIC page reaching a private host is blocked.
      await page.goto(`http://127.0.0.1:${pub.port}/?3`, { timeout: 5000 });
      for (let i = 0; i < 20 && hitsBlocked === before; i++) await Bun.sleep(100);
      expect(hitsBlocked).toBe(before + 1);
      // control: the same page in a tab with the guard off DOES reach the host
      await browser.close();
      browser = await Browser.connect(`http://127.0.0.1:${cdpPort}`, { blockPrivateNetwork: false });
      const [open] = await browser.pages();
      await open.goto(`http://public.test:${pub.port}/?2`, { timeout: 5000 });
      await Bun.sleep(800);
      expect(hitsBlocked).toBeGreaterThan(before + 1);
    } finally { pub.stop(true); }
  }, TIMEOUT);
});
