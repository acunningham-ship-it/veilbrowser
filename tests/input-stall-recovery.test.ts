/**
 * Unit test for Page.sendInput()'s stall-recovery path (judge #7765 fast-follow
 * — the live 120s occlusion stall itself isn't safely reproducible on demand,
 * but the recovery LOGIC is fully testable with a fake CDP transport that
 * throws exactly the timeout error the real one does on the first Input.*
 * call). Proves: (1) a stalled Input command triggers Page.bringToFront
 * exactly once, (2) the original command is retried and succeeds, (3) a
 * non-Input command (or an Input command that DOESN'T stall) never touches
 * bringToFront at all.
 *
 * No browser needed — pure unit test.
 */
import { describe, it, expect } from "bun:test";
import { Page } from "../src/page.js";
import type { CDP } from "../src/cdp.js";

interface Call { method: string; params: any; sessionId?: string; timeoutMs?: number }

/** A fake CDP transport: records every send() and lets a test script exactly
 *  which calls (by method name, in order) should reject with a "timed out"
 *  error before succeeding — the same shape Page.sendInput's catch matches
 *  on (String(e.message).includes("timed out")). */
function fakeCdp(failFirstNCallsToMethod: Record<string, number>) {
  const calls: Call[] = [];
  const remaining = { ...failFirstNCallsToMethod };
  const cdp = {
    send(method: string, params: any, sessionId?: string, timeoutMs?: number): Promise<any> {
      calls.push({ method, params, sessionId, timeoutMs });
      if ((remaining[method] ?? 0) > 0) {
        remaining[method]--;
        return Promise.reject(new Error(`${method}: timed out after ${timeoutMs}ms (no CDP response)`));
      }
      return Promise.resolve({});
    },
  } as unknown as CDP;
  return { cdp, calls };
}

function newPage(cdp: CDP): any {
  // Page's constructor is public; sessionId/targetId beyond the fake matter
  // nothing here since every command routes through the fake transport.
  return new (Page as any)(cdp, "session-1");
}

describe("Page input-stall recovery (sendInput)", () => {
  it("a stalled Input.* command triggers ONE Page.bringToFront then retries and succeeds", async () => {
    const { cdp, calls } = fakeCdp({ "Input.dispatchMouseEvent": 1 }); // first attempt stalls
    const page = newPage(cdp);

    // private send() — reachable at runtime despite the TS `private` (compile-time
    // only). Exercises the exact path click()/clickAt()/press()/scroll()/etc. all
    // funnel Input.* commands through.
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 });

    const methods = calls.map((c) => c.method);
    expect(methods).toEqual(["Input.dispatchMouseEvent", "Page.bringToFront", "Input.dispatchMouseEvent"]);
    // the short leash on the FIRST attempt, no timeout override (default) on the retry
    expect(calls[0].timeoutMs).toBeGreaterThan(0);
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(5000);
    expect(calls[2].timeoutMs).toBeUndefined();
  });

  it("bringToFront targets the top-level session, not whatever session the stalled command used", async () => {
    const { cdp, calls } = fakeCdp({ "Input.dispatchMouseEvent": 1 });
    const page = newPage(cdp);
    page.activeSessionId = "child-iframe-session"; // simulate useFrame() having switched targets

    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 });

    const bringToFront = calls.find((c) => c.method === "Page.bringToFront")!;
    expect(bringToFront.sessionId).toBe("session-1"); // the page's own top-level session
    const inputCalls = calls.filter((c) => c.method === "Input.dispatchMouseEvent");
    expect(inputCalls.every((c) => c.sessionId === "child-iframe-session")).toBe(true); // retry stays on the ORIGINAL target
  });

  it("a non-stalling Input.* command never touches Page.bringToFront", async () => {
    const { cdp, calls } = fakeCdp({}); // nothing fails
    const page = newPage(cdp);
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 });
    expect(calls.map((c) => c.method)).toEqual(["Input.dispatchMouseEvent"]);
  });

  it("a non-Input command is never routed through the stall-recovery path at all", async () => {
    const { cdp, calls } = fakeCdp({ "DOM.getBoxModel": 1 }); // would fail if misrouted through sendInput's short leash+recovery
    const page = newPage(cdp);
    await expect(page.send("DOM.getBoxModel", { backendNodeId: 1 })).rejects.toThrow(/timed out/);
    // one call, no bringToFront, no silent retry — non-Input errors propagate as-is
    expect(calls.map((c) => c.method)).toEqual(["DOM.getBoxModel"]);
  });

  it("a real (non-timeout) error on an Input command is NOT treated as a stall — no bringToFront, no retry, propagates immediately", async () => {
    const calls: Call[] = [];
    const cdp = {
      send(method: string, params: any, sessionId?: string, timeoutMs?: number): Promise<any> {
        calls.push({ method, params, sessionId, timeoutMs });
        return Promise.reject(new Error("Invalid parameters (-32602)"));
      },
    } as unknown as CDP;
    const page = newPage(cdp);
    await expect(page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 })).rejects.toThrow(/Invalid parameters/);
    expect(calls.map((c) => c.method)).toEqual(["Input.dispatchMouseEvent"]); // no bringToFront, no retry
  });
});
