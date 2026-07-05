/**
 * Launches a REAL, unmodified Chrome. To a website, this process IS Chrome —
 * identical TLS, identical JS engine, identical canvas/WebGL/font fingerprint —
 * because it literally is the same binary a human runs.
 *
 * The whole stealth game at launch time is: don't add the switches that
 * Puppeteer/Playwright add. Those tools flip on `--enable-automation` and a
 * batch of `--disable-*` flags that change behaviour in fingerprintable ways.
 * We launch with the flags a normal Chrome uses, minus the noise.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CANDIDATES = [
  process.env.VEIL_CHROME,
  "/opt/google/chrome/chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
].filter(Boolean) as string[];

export function findChrome(): string {
  for (const c of CANDIDATES) if (existsSync(c)) return c;
  throw new Error("No Chrome/Chromium found. Set VEIL_CHROME=/path/to/chrome");
}

export interface LaunchOptions {
  headless?: boolean;       // default false (headful is far less detectable)
  userDataDir?: string;     // persist cookies/history -> looks like a used profile
  chromePath?: string;
  windowSize?: { width: number; height: number };
  /**
   * Virtual-display (Xvfb) resolution — the `screen.*` a page sees. Defaults to a
   * realistic desktop 1920x1080 so the Chrome window sits INSIDE the screen. A
   * virtual display sized to the window (screen === window, window taller than
   * screen) is a classic headless tell; a real monitor is bigger than the window.
   * Only applies to veil's own auto-Xvfb, not an external DISPLAY.
   */
  screenSize?: { width: number; height: number };
  proxy?: string;           // e.g. "http://user:pass@host:port"
  /**
   * WebGL backend:
   *  - "hardware": use the real GPU via ANGLE/EGL → genuine, consistent vendor.
   *    Works headless AND headful (no Xvfb needed). Best stealth — nothing spoofed.
   *  - "software": SwiftShader + a spoofed Intel vendor. For GPU-less hosts only.
   *  - "off": no GL flags.
   *  - "auto" (default): "hardware" if a DRI render node is accessible, else "software".
   */
  gpu?: "hardware" | "software" | "off" | "auto";
  /**
   * Run headful on a virtual X display via Xvfb — "headful on a server". Headful
   * Chrome scores far better against deep fingerprinters than headless (no
   * headless render quirks, real screen size). Default "auto": on when headful is
   * requested (headless:false) and there's no real DISPLAY. Requires Xvfb on PATH.
   */
  xvfb?: boolean;
  extraArgs?: string[];
}

const RENDER_NODE = "/dev/dri/renderD128";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Orphan-Chrome reaper --------------------------------------------------
// Chrome runs as a TREE (main + renderers + gpu + zygote). SIGKILL to just the
// main pid leaves the rest to reparent to init and run forever; and if the
// owner dies without calling kill() (Ctrl-C, an uncaught throw), nothing reaps
// them at all. Fix: every Chrome is spawned `detached` so it leads its own
// process group, we kill the whole GROUP, and a process-level reaper sweeps any
// survivors on exit/signal. (Puppeteer/Playwright do the same.)
interface LiveBrowser {
  child: ChildProcess;
  xvfb: ChildProcess | null;
  userDataDir: string;
  ephemeral: boolean;
}
const LIVE = new Set<LiveBrowser>();
let reaperInstalled = false;

function killGroup(proc: ChildProcess | null): void {
  const pid = proc?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL"); // negative pid = the whole process group
  } catch {
    try {
      proc!.kill("SIGKILL"); // group already gone → fall back to the single pid
    } catch {}
  }
}

function reapAll(): void {
  for (const b of LIVE) {
    killGroup(b.child);
    killGroup(b.xvfb);
  }
}

const SIGNAL_EXIT: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

function installReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;
  // 'exit' fires on a normal return AND during an uncaught-exception exit — sync
  // context, exactly right for a group-kill.
  process.on("exit", reapAll);
  // Signals don't run 'exit' handlers on their own, so catch them, reap, and then
  // leave with the conventional 128+signum code.
  for (const sig of Object.keys(SIGNAL_EXIT)) {
    process.on(sig as NodeJS.Signals, () => {
      reapAll();
      process.exit(SIGNAL_EXIT[sig]);
    });
  }
}

/** Start an Xvfb virtual display; resolves once it's ready, or null if unavailable. */
async function startXvfb(width: number, height: number): Promise<{ display: string; proc: ChildProcess } | null> {
  let n = 99;
  for (; n < 160; n++) if (!existsSync(`/tmp/.X${n}-lock`)) break;
  const display = `:${n}`;
  let proc: ChildProcess;
  try {
    proc = spawn("Xvfb", [display, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp"], {
      stdio: "ignore",
    });
  } catch {
    return null;
  }
  let exited = false;
  proc.on("exit", () => (exited = true));
  const start = Date.now();
  while (!existsSync(`/tmp/.X${n}-lock`) && !exited && Date.now() - start < 5000) await wait(50);
  if (exited) return null;
  return { display, proc };
}

/** Resolve "auto" → real GPU if we can reach the render node, else SwiftShader. */
function resolveGpu(mode: LaunchOptions["gpu"]): "hardware" | "software" | "off" {
  if (mode && mode !== "auto") return mode;
  try {
    // accessSync would import fs; existsSync is already imported and the ACL
    // grants read here. Presence of the node is a good-enough hardware signal.
    return existsSync(RENDER_NODE) ? "hardware" : "software";
  } catch {
    return "software";
  }
}

export interface LaunchResult {
  webSocketDebuggerUrl: string;
  process: ChildProcess;
  userDataDir: string;
  /** True only for SwiftShader (software) — the page layer should then mask the vendor. */
  maskWebgl: boolean;
  kill: () => void;
}

export async function launchChrome(opts: LaunchOptions = {}): Promise<LaunchResult> {
  const chromePath = opts.chromePath ?? findChrome();
  const ephemeral = !opts.userDataDir;
  const userDataDir = opts.userDataDir ?? join(tmpdir(), `veil-${process.pid}-${Date.now()}`);
  mkdirSync(userDataDir, { recursive: true });
  // Reused profiles leave a stale DevToolsActivePort from the previous Chrome;
  // waitForPort would read the OLD port and connect to a dead endpoint. Clear it
  // so we wait for THIS launch's fresh port.
  rmSync(join(userDataDir, "DevToolsActivePort"), { force: true });
  // SingletonLock records who owns this profile — Chrome writes it as a symlink
  // "<host>-<pid>". Only clear a STALE lock (its pid is dead). If a LIVE Chrome
  // still owns the profile, REFUSE: two Chromes on one userDataDir silently
  // corrupt it (this was the real cause of an "Initializing…" hang). Blindly
  // removing the lock, as before, let that corruption happen.
  const lockPath = join(userDataDir, "SingletonLock");
  let ownerPid = -1; // -1 = no lock present
  try { ownerPid = parseInt(readlinkSync(lockPath).split("-").pop() || "", 10); } catch {}
  if (ownerPid > 0) {
    let alive = false;
    try { process.kill(ownerPid, 0); alive = true; } catch (e: any) { alive = e?.code === "EPERM"; }
    if (alive) {
      throw new Error(
        `Profile "${userDataDir}" is already in use by Chrome (pid ${ownerPid}). ` +
          `Close it, or launch with a different userDataDir.`,
      );
    }
  }
  rmSync(lockPath, { force: true }); // absent or stale → safe to clear
  rmSync(join(userDataDir, "SingletonCookie"), { force: true });
  rmSync(join(userDataDir, "SingletonSocket"), { force: true });
  // The screen (virtual display) is a realistic desktop; the window sits INSIDE it
  // and is never larger than it, positioned like a real user's window so that
  // screen.* > window.outer.*, availHeight leaves room for a taskbar, and
  // screenX/screenY are non-zero — none of the "display sized to the window" tells.
  const screen = opts.screenSize ?? { width: 1920, height: 1080 };
  const win = opts.windowSize ?? { width: 1280, height: 800 };
  const width = Math.min(win.width, screen.width);
  const height = Math.min(win.height, screen.height);
  const posX = Math.max(0, (screen.width - width) >> 1);
  const posY = Math.max(0, (screen.height - height) >> 1);

  // Port 0 => Chrome picks a free port and writes it to DevToolsActivePort.
  const args = [
    `--remote-debugging-port=0`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    `--window-position=${posX},${posY}`,
    // Stealth: navigator.webdriver is gated behind this blink feature. Disabling
    // the "AutomationControlled" feature makes navigator.webdriver === false,
    // matching a normal browser. (Playwright historically left it true.)
    `--disable-blink-features=AutomationControlled`,
    // Quiet, non-suspicious startup — these match a fresh real profile, they are
    // NOT the automation-only switches that change fingerprintable behaviour.
    `--no-first-run`,
    `--no-default-browser-check`,
    `--disable-features=Translate,OptimizationHints`,
    `--password-store=basic`,
    `--homepage=about:blank`,
    `about:blank`,
  ];
  if (opts.headless) {
    // headless=new is the modern engine; still more detectable than headful,
    // so it's opt-in. Default product mode is headful on a real display/Xvfb.
    args.unshift("--headless=new");
  }
  // WebGL backend. Hardware (real GPU via ANGLE/EGL) is preferred — it gives an
  // authentic, self-consistent fingerprint and works headless without Xvfb. We
  // only fall back to SwiftShader (and then mask its vendor) when there's no GPU.
  const gpu = resolveGpu(opts.gpu);
  let maskWebgl = false;
  if (gpu === "hardware") {
    args.push("--use-gl=angle", "--use-angle=gl-egl");
  } else if (gpu === "software") {
    args.push("--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader");
    maskWebgl = true; // SwiftShader's vendor is a server tell — hide it.
  }
  if (opts.proxy) args.push(`--proxy-server=${opts.proxy}`);
  if (opts.extraArgs) args.push(...opts.extraArgs);

  // Headful on a server: bring up our own Xvfb display if there isn't a real one.
  const childEnv = { ...process.env };
  let xvfbProc: ChildProcess | null = null;
  const wantXvfb = opts.xvfb ?? (!opts.headless && !process.env.DISPLAY);
  if (wantXvfb) {
    const xvfb = await startXvfb(screen.width, screen.height);
    if (xvfb) {
      xvfbProc = xvfb.proc;
      childEnv.DISPLAY = xvfb.display;
    } else if (!process.env.DISPLAY) {
      // No virtual display available — degrade gracefully to headless rather than
      // failing the whole launch. Still uses the real GPU; just a higher headless
      // heuristic score. Better a working browser than none.
      args.unshift("--headless=new");
    }
  }

  // detached => Chrome leads its own process group, so killGroup() can take down
  // the whole renderer/gpu/zygote tree in one shot instead of orphaning it.
  const child = spawn(chromePath, args, { stdio: ["ignore", "ignore", "pipe"], env: childEnv, detached: true });

  const live: LiveBrowser = { child, xvfb: xvfbProc, userDataDir, ephemeral };
  LIVE.add(live);
  installReaper();
  // If Chrome dies on its own (crash, external kill), drop it from the reaper set,
  // tear down its Xvfb, and clean an ephemeral profile — no leak, no stale dir.
  child.on("exit", () => {
    LIVE.delete(live);
    killGroup(xvfbProc);
    if (ephemeral) { try { rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
  });

  const portFile = join(userDataDir, "DevToolsActivePort");
  const wsPath = await waitForPort(portFile, child);
  const port = wsPath.port;

  // Fetch the browser-level WebSocket endpoint from Chrome's HTTP side.
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  const info = (await res.json()) as { webSocketDebuggerUrl: string };

  const kill = () => {
    LIVE.delete(live);
    killGroup(child); // whole process group, not just the main pid
    killGroup(xvfbProc);
    if (ephemeral) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {}
    }
  };

  return { webSocketDebuggerUrl: info.webSocketDebuggerUrl, process: child, userDataDir, maskWebgl, kill };
}

function waitForPort(portFile: string, child: ChildProcess): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) =>
      reject(new Error(`Chrome exited early (code ${code}).\n${stderr.slice(-600)}`)),
    );
    const start = Date.now();
    const tick = () => {
      if (existsSync(portFile)) {
        try {
          const port = parseInt(readFileSync(portFile, "utf8").split("\n")[0]!.trim(), 10);
          if (port > 0) return resolve({ port });
        } catch {}
      }
      if (Date.now() - start > 15000) return reject(new Error("Chrome never opened a debug port"));
      setTimeout(tick, 50);
    };
    tick();
  });
}
