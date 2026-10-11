/**
 * Regression: startXvfb() must pick a free display and resolve only once that
 * display is ACCEPTING CONNECTIONS - not when a lock file exists.
 *
 * Old behaviour: scan /tmp/.X<n>-lock for a number with no lock file, spawn Xvfb,
 * then wait for that lock FILE. Two bugs: a SIGKILLed Xvfb leaves its lock behind,
 * so every headful launch leaked a display number (the :99-:159 window filled up
 * and every launch collided on :160); and a STALE lock satisfied "the lock exists"
 * instantly, so Chrome started before the new Xvfb was up and died with
 * "Missing X server or $DISPLAY" (~2% of back-to-back headful launches).
 *
 * These tests use a fake `Xvfb` on PATH that creates its lock file immediately but
 * only starts listening 400ms later - the exact shape that fooled the old check -
 * so they are deterministic (no timing luck) and need no real X server. Display
 * numbers start at 7000 to stay clear of real ones.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startXvfb } from "../src/launcher.js";

const FAKE = `#!/usr/bin/env node
const fs = require("fs"), net = require("net");
const n = Number(process.argv[2].slice(1));
const mode = process.env.FAKE_XVFB_MODE || "slow";
if (mode === "die" || (mode === "collide-first" && n === Number(process.env.FAKE_XVFB_FIRST))) process.exit(1);
const lock = "/tmp/.X" + n + "-lock", sock = "/tmp/.X11-unix/X" + n;
fs.mkdirSync("/tmp/.X11-unix", { recursive: true });
fs.writeFileSync(lock, String(process.pid).padStart(10) + "\\n"); // lock appears at once...
process.on("SIGTERM", () => { for (const f of [lock, sock]) try { fs.unlinkSync(f); } catch {} process.exit(0); });
if (mode === "hang") { setInterval(() => {}, 1e6); return; }        // ...never listens
setTimeout(() => {                                                  // ...listens only after 400ms
  try { fs.unlinkSync(sock); } catch {}
  fs.writeFileSync(process.env.FAKE_XVFB_READY, "ready");
  net.createServer().listen(sock);
}, 400);
`;

const oldPath = process.env.PATH;
const cleanup: Array<() => void> = [];
afterEach(() => {
  process.env.PATH = oldPath;
  delete process.env.FAKE_XVFB_MODE;
  delete process.env.FAKE_XVFB_FIRST;
  while (cleanup.length) cleanup.pop()!();
  for (let n = 7000; n < 7012; n++) for (const f of [`/tmp/.X${n}-lock`, `/tmp/.X11-unix/X${n}`]) rmSync(f, { force: true });
});

function installFake(mode: "slow" | "die" | "hang" | "collide-first") {
  const dir = mkdtempSync(join(tmpdir(), "fakexvfb-"));
  const bin = join(dir, "Xvfb");
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  const ready = join(dir, "ready");
  process.env.PATH = `${dir}:${oldPath}`;
  process.env.FAKE_XVFB_MODE = mode;
  process.env.FAKE_XVFB_FIRST = "7000";
  process.env.FAKE_XVFB_READY = ready;
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { ready };
}

const accepts = (n: string) =>
  new Promise<boolean>((res) => {
    const s = new Socket(); // listeners before connect(): Bun can report ENOENT before it returns
    s.once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
    try {
      s.connect(`/tmp/.X11-unix/X${n}`);
    } catch {
      res(false);
    }
  });

describe("startXvfb readiness and allocation", () => {
  it("does not resolve while the server has a lock file but is not listening yet", async () => {
    const { ready } = installFake("slow");
    const x = await startXvfb(1280, 800, { first: 7000 });
    expect(x).not.toBeNull();
    cleanup.push(() => x!.proc.kill("SIGTERM"));
    // The old lockfile check resolved ~50ms in, long before the fake listens at ~400ms.
    expect(existsSync(ready)).toBe(true);
    expect(await accepts(x!.display.slice(1))).toBe(true);
    expect(x!.display).toBe(":7000");
  });

  it("a STALE lock (dead owner) neither blocks the number nor counts as ready", async () => {
    const { ready } = installFake("slow");
    writeFileSync("/tmp/.X7000-lock", "    999999\n"); // owner pid does not exist
    const x = await startXvfb(1280, 800, { first: 7000 });
    expect(x).not.toBeNull();
    cleanup.push(() => x!.proc.kill("SIGTERM"));
    expect(x!.display).toBe(":7000"); // reused, not skipped as "busy"
    expect(existsSync(ready)).toBe(true); // and we still waited for the real server
    expect(await accepts("7000")).toBe(true);
  });

  it("a LIVE lock makes the number busy: the next one is used", async () => {
    installFake("slow");
    writeFileSync("/tmp/.X7000-lock", String(process.pid).padStart(10) + "\n"); // this test process is alive
    const x = await startXvfb(1280, 800, { first: 7000 });
    expect(x).not.toBeNull();
    cleanup.push(() => x!.proc.kill("SIGTERM"));
    expect(x!.display).toBe(":7001");
  });

  it("if Xvfb dies at once on a number (a concurrent launch took it), it tries the next", async () => {
    installFake("collide-first");
    const x = await startXvfb(1280, 800, { first: 7000 });
    expect(x).not.toBeNull();
    cleanup.push(() => x!.proc.kill("SIGTERM"));
    expect(x!.display).toBe(":7001");
  });

  it("gives up with null (bounded) when Xvfb always dies", async () => {
    installFake("die");
    const t0 = Date.now();
    expect(await startXvfb(1280, 800, { first: 7000 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("returns null and kills the server when it never starts listening", async () => {
    installFake("hang");
    const t0 = Date.now();
    expect(await startXvfb(1280, 800, { first: 7000, timeoutMs: 300 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(3000);
    const pid = Number(readFileSync("/tmp/.X7000-lock", "utf8").trim());
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(pid, 0)).toThrow(); // the half-started server is gone
  });

  it("returns null when Xvfb is not installed at all", async () => {
    process.env.PATH = "/nonexistent-dir";
    expect(await startXvfb(1280, 800, { first: 7000 })).toBeNull();
  });
});

// Real Xvfb: every display handed back must accept a connection IMMEDIATELY, even
// though the previous server was SIGKILLed and left a stale lock behind (exactly
// how launchChrome tears them down) - so numbers get reused instead of leaking.
describe.skipIf(!Bun.which("Xvfb"))("startXvfb against a real Xvfb", () => {
  it("20 back-to-back start/SIGKILL cycles: all connectable, numbers reused, no leak", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const x = await startXvfb(1024, 768, { first: 7100 });
      expect(x).not.toBeNull();
      seen.add(x!.display);
      expect(await accepts(x!.display.slice(1))).toBe(true);
      x!.proc.kill("SIGKILL");
      await new Promise((r) => x!.proc.once("exit", r));
    }
    // Old scan treated each stale lock as busy and climbed a new number every launch (20 here).
    expect(seen.size).toBeLessThanOrEqual(3);
    for (const d of seen) for (const f of [`/tmp/.X${d.slice(1)}-lock`, `/tmp/.X11-unix/X${d.slice(1)}`]) rmSync(f, { force: true });
  });
});
