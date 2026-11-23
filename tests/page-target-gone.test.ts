/**
 * Page.targetGone flips only when THIS page's own session detaches.
 *
 * init() auto-attaches cross-origin iframes, so child sessions detach all the time (an
 * iframe unmounts or navigates). If one of those marked the page gone, the MCP server
 * would drop the tab it is driving and open a new one mid-task.
 */
import { describe, it, expect } from "bun:test";
import { Page } from "../src/page.js";
import type { CDP } from "../src/cdp.js";

function fakeCdp() {
  const handlers = new Map<string, Set<(p: any) => void>>();
  const cdp = {
    send: () => Promise.resolve({}),
    on(method: string, h: (p: any) => void) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method)!.add(h);
      return () => handlers.get(method)!.delete(h);
    },
  } as unknown as CDP;
  const emit = (method: string, p: any) => { for (const h of [...(handlers.get(method) ?? [])]) h(p); };
  const listeners = (method: string) => handlers.get(method)?.size ?? 0;
  return { cdp, emit, listeners };
}

describe("Page.targetGone", () => {
  it("ignores another session's detach (a child iframe, another tab) and flips on its own", () => {
    const { cdp, emit } = fakeCdp();
    const page = new Page(cdp, "main-session", "main-target");
    expect(page.targetGone).toBe(false);

    emit("Target.detachedFromTarget", { sessionId: "iframe-session", targetId: "iframe-target" });
    emit("Target.detachedFromTarget", { targetId: "other-target" }); // no sessionId at all
    expect(page.targetGone).toBe(false);

    emit("Target.detachedFromTarget", { sessionId: "main-session", targetId: "main-target" });
    expect(page.targetGone).toBe(true);
  });

  it("one page's detach does not mark a sibling page gone, and drops only its own listener", () => {
    const { cdp, emit, listeners } = fakeCdp();
    const a = new Page(cdp, "session-a", "target-a");
    const b = new Page(cdp, "session-b", "target-b");
    emit("Target.detachedFromTarget", { sessionId: "session-a", targetId: "target-a" });
    expect(a.targetGone).toBe(true);
    expect(b.targetGone).toBe(false);
    expect(listeners("Target.detachedFromTarget")).toBe(1); // a's unsubscribed, b's still armed
  });
});
