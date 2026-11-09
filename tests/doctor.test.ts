/**
 * Launch-path tests: bin/veil-mcp.sh and tools/veil-doctor.ts.
 * Everything runs under `env -i PATH=/usr/bin:/bin` (what a harness with a bare PATH gives us),
 * with a dead CDP URL (127.0.0.1:1). No Chrome is launched, :9333 is never touched.
 */
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const WRAPPER = join(ROOT, "bin", "veil-mcp.sh");
const DOCTOR = join(ROOT, "tools", "veil-doctor.ts");
const INIT = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
}) + "\n";

function bareEnv(extra: string[]) {
  return ["-i", "PATH=/usr/bin:/bin", "VEIL_CDP_URL=127.0.0.1:1", ...extra];
}
function launch(cmd: string[], extra: string[] = []) {
  const r = spawnSync("env", [...bareEnv(extra), ...cmd], { input: INIT, timeout: 20000, encoding: "utf8" });
  const first = (r.stdout || "").split("\n").find((l) => l.trim().startsWith("{"));
  return { r, reply: first ? JSON.parse(first) : null };
}

describe("launch path under a bare PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "veil-doctor-"));
  const log = join(dir, "veil-mcp.log");

  it("negative control: the old `bash -c 'cd … && bun run src/mcp.ts'` launch fails", () => {
    const { reply } = launch(["bash", "-c", `cd ${ROOT} && bun run src/mcp.ts`]);
    expect(reply).toBeNull();
  });

  it("bin/veil-mcp.sh answers initialize and appends a startup log line", () => {
    expect(existsSync(WRAPPER)).toBe(true);
    const { reply } = launch(["bash", WRAPPER], [`VEIL_MCP_LOG=${log}`]);
    expect(reply?.result?.serverInfo?.name).toBeTruthy();
    const text = readFileSync(log, "utf8");
    const line = text.trim().split("\n").find((l) => l.includes("startup"))!;
    expect(line).toMatch(/pid=\d+/);
    expect(line).toMatch(/bun=\S*bun/);
    expect(line).toMatch(/cdp=no/);
    expect(line).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("wrapper logs cdp=yes when VEIL_CDP_URL (scheme + path form) has a listener", () => {
    const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const ylog = join(dir, "veil-mcp-yes.log");
      launch(["bash", WRAPPER], [`VEIL_MCP_LOG=${ylog}`, `VEIL_CDP_URL=http://127.0.0.1:${srv.port}/json/version`]);
      const line = readFileSync(ylog, "utf8").split("\n").find((l) => l.includes("startup"))!;
      expect(line).toMatch(/cdp=yes/);
      expect(line).toContain(`cdp_url=http://127.0.0.1:${srv.port}/json/version`);
    } finally { srv.stop(true); }
  });

  function doctor(args: string[], extra: string[] = []) {
    const r = spawnSync("env", [...bareEnv(extra), process.execPath, DOCTOR, ...args], { timeout: 30000, encoding: "utf8" });
    const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
    return { r, lines, j: lines.length ? JSON.parse(lines[0]) : null };
  }

  it("doctor prints exactly one JSON line with ok:true and toolCount>=40", () => {
    const { r, lines, j } = doctor([], [`VEIL_MCP_LOG=${log}`]);
    expect(lines.length).toBe(1);
    expect(j.ok).toBe(true);
    expect(j.toolCount).toBeGreaterThanOrEqual(40);
    expect(j.cdpReachable).toBe(false);
    expect(typeof j.profileLockHeld).toBe("boolean");
    expect(typeof j.ms).toBe("number");
    expect(j.bun).toMatch(/bun$/);
    expect(j.version).toBeTruthy();
    expect(r.status).toBe(0);
  });

  it("doctor with no wrapper and a PATH lacking bun reports ok:false and exits nonzero", () => {
    const { r, lines, j } = doctor(["--no-wrapper"]);
    expect(lines.length).toBe(1);
    expect(j.ok).toBe(false);
    expect(j.bun).toBeNull();
    expect(r.status).not.toBe(0);
  });
});
