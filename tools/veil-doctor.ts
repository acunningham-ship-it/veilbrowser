/**
 * veil doctor: spawn the MCP server over stdio with a minimal env, run initialize + tools/list,
 * print ONE JSON line {ok, bun, version, toolCount, cdpReachable, profileLockHeld, ms}, exit 1 on failure.
 *   bun run doctor              # via bin/veil-mcp.sh (the fleet launch path)
 *   bun run doctor --no-wrapper # via the legacy `bash -c 'cd … && bun run src/mcp.ts'`
 * Never launches Chrome: only reaches VEIL_CDP_URL with a TCP probe; tools/list needs no browser.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const noWrapper = process.argv.includes("--no-wrapper");
const t0 = Date.now();
const PATH = "/usr/bin:/bin";
const cdpUrl = process.env.VEIL_CDP_URL || "";
const profile = process.env.VEIL_USER_DATA_DIR || "";

const env: Record<string, string> = { PATH };
for (const k of ["VEIL_CDP_URL", "VEIL_USER_DATA_DIR", "VEIL_MCP_LOG", "HOME"]) if (process.env[k]) env[k] = process.env[k]!;

function probe(url: string): Promise<boolean> {
  if (!url) return Promise.resolve(false);
  const [host, port] = url.replace(/^\w+:\/\//, "").split("/")[0].split(":");
  return new Promise((res) => {
    const s = createConnection({ host, port: Number(port) });
    const done = (v: boolean) => { s.destroy(); res(v); };
    s.setTimeout(1000, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

function lockHeld(): boolean {
  if (!profile) return false;
  try { lstatSync(join(profile, "SingletonLock")); return true; } catch { return false; }
}

// What bun would the child find? Wrapper adds ~/.bun/bin; legacy launch gets PATH only.
const home = env.HOME || homedir();
function which(cmd: string, path: string): string | null {
  for (const d of path.split(":")) {
    try { accessSync(join(d, cmd), constants.X_OK); return join(d, cmd); } catch {}
  }
  return null;
}
const bun = which("bun", noWrapper ? PATH : `${home}/.bun/bin:${PATH}`);

async function run(): Promise<{ version: string | null; toolCount: number }> {
  const cmd = noWrapper ? ["bash", "-c", `cd ${ROOT} && bun run src/mcp.ts`] : ["bash", join(ROOT, "bin", "veil-mcp.sh")];
  const child = spawn(cmd[0], cmd.slice(1), { env, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, (m: any) => void>();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); pending.get(m.id)?.(m); } catch {}
    }
  });
  const exited = new Promise<never>((_, rej) => child.on("exit", (c) => rej(new Error(`mcp exited ${c} before replying`))));
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000));
  const rpc = (id: number, method: string, params: object = {}) => {
    const p = new Promise<any>((r) => pending.set(id, r));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return Promise.race([p, exited, timeout]);
  };
  try {
    const init = await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "veil-doctor", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = await rpc(2, "tools/list");
    return { version: init.result?.serverInfo?.version ?? null, toolCount: list.result?.tools?.length ?? 0 };
  } finally { child.kill("SIGTERM"); }
}

let ok = false, version: string | null = null, toolCount = 0, error: string | undefined;
try { ({ version, toolCount } = await run()); ok = !!version && toolCount > 0; }
catch (e) { error = String((e as Error).message || e); }
const out: Record<string, unknown> = { ok, bun: bun ?? null, version, toolCount, cdpReachable: await probe(cdpUrl), profileLockHeld: lockHeld(), ms: Date.now() - t0 };
if (error) out.error = error;
console.log(JSON.stringify(out));
process.exit(ok ? 0 : 1);
