/**
 * MCP bin smoke test. Spawns the BUILT artifact exactly as an installed user
 * would (`node dist/mcp.js`, the `veil-mcp` bin), sends a `tools/list` request
 * on stdin, and asserts a well-formed tools list comes back. `tools/list` never
 * launches Chrome, so this is fast and safe in CI — it verifies the shebang
 * survived the build and the server is actually runnable from a plain install.
 *
 * Run with: bun test tests/mcp-bin.test.ts
 */
import { describe, it, expect } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIST_MCP = join(import.meta.dir, "..", "dist", "mcp.js");

/** Send one JSON-RPC line to `node dist/mcp.js` and resolve its first reply. */
function askMcp(request: object, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [DIST_MCP], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("mcp bin did not reply within timeout"));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += d.toString();
      const nl = out.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(out.slice(0, nl)));
        } catch (e) {
          reject(e as Error);
        } finally {
          child.stdin.end();
          child.kill("SIGKILL");
        }
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.stdin.write(JSON.stringify(request) + "\n");
  });
}

describe("veil-mcp bin", () => {
  it("dist/mcp.js exists and starts with the node shebang", () => {
    expect(existsSync(DIST_MCP)).toBe(true);
    expect(readFileSync(DIST_MCP, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("responds to tools/list with the veil tool set", async () => {
    const res = await askMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(1);
    expect(Array.isArray(res.result?.tools)).toBe(true);
    expect(res.result.tools.length).toBeGreaterThan(20);
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toContain("veil_goto");
    expect(names).toContain("veil_snapshot");
  }, 20000);
});
