/**
 * Unit tests for CDP message framing and protocol handling.
 *
 * Validates the JSON-RPC message structure, sessionId handling, and
 * command/response correlation without needing a live Chrome process.
 *
 * Run with: bun test tests/cdp-messages.test.ts
 */
import { describe, it, expect } from "bun:test";

/**
 * Simulate the CDP message validation and dispatch logic.
 * Tests the structure of CDP protocol messages.
 */

interface CDPMessage {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  sessionId?: string;
  result?: any;
  error?: { message: string; code: number };
}

function validateCommand(msg: CDPMessage): { id: number; method: string; valid: boolean; error?: string } {
  if (typeof msg.id !== "number") return { id: 0, method: "", valid: false, error: "missing id" };
  if (typeof msg.method !== "string") return { id: msg.id, method: "", valid: false, error: "missing method" };
  return { id: msg.id, method: msg.method, valid: true };
}

function validateResponse(msg: CDPMessage): { id: number; valid: boolean; isError: boolean } {
  if (typeof msg.id !== "number") return { id: 0, valid: false, isError: false };
  const isError = !!msg.error;
  return { id: msg.id, valid: true, isError };
}

describe("CDP message framing", () => {
  it("command has required id and method", () => {
    const cmd: CDPMessage = { id: 1, method: "Page.navigate", params: { url: "about:blank" } };
    const v = validateCommand(cmd);
    expect(v.valid).toBe(true);
    expect(v.id).toBe(1);
    expect(v.method).toBe("Page.navigate");
  });

  it("command without id is invalid", () => {
    const cmd: CDPMessage = { method: "Page.navigate", params: { url: "about:blank" } };
    const v = validateCommand(cmd);
    expect(v.valid).toBe(false);
    expect(v.error).toBe("missing id");
  });

  it("command without method is invalid", () => {
    const cmd: CDPMessage = { id: 1, params: { url: "about:blank" } };
    const v = validateCommand(cmd);
    expect(v.valid).toBe(false);
  });
});

describe("CDP responses", () => {
  it("response with result is success", () => {
    const resp: CDPMessage = { id: 1, result: { value: 42 } };
    const v = validateResponse(resp);
    expect(v.valid).toBe(true);
    expect(v.isError).toBe(false);
  });

  it("response with error is error", () => {
    const resp: CDPMessage = { id: 1, error: { message: "Failed", code: -32000 } };
    const v = validateResponse(resp);
    expect(v.valid).toBe(true);
    expect(v.isError).toBe(true);
  });
});

describe("CDP events and sessions", () => {
  it("event has method but no id", () => {
    const event: CDPMessage = { method: "Page.loadEventFired", params: { timestamp: 123.45 } };
    const isCommand = validateCommand(event);
    // Events are not commands (no id), so this should fail validation as a command.
    expect(isCommand.valid).toBe(false);
  });

  it("sessionId is optional for browser-level commands", () => {
    const cmd1: CDPMessage = { id: 1, method: "Browser.getVersion" };
    const cmd2: CDPMessage = { id: 2, method: "Page.navigate", sessionId: "sess-123", params: { url: "x" } };

    const v1 = validateCommand(cmd1);
    const v2 = validateCommand(cmd2);

    expect(v1.valid).toBe(true);
    expect(v2.valid).toBe(true);
    expect(cmd2.sessionId).toBe("sess-123");
  });
});

describe("CDP flat-mode event routing", () => {
  it("event routing with sessionId", () => {
    // In flat session mode, we key handlers by `${sessionId}:${method}`.
    const event: CDPMessage = {
      method: "Page.frameStartedLoading",
      sessionId: "sess-abc",
      params: { frameId: "frame-1" },
    };

    const key = `${event.sessionId}:${event.method}`;
    expect(key).toBe("sess-abc:Page.frameStartedLoading");
  });

  it("event routing fallback to wildcard", () => {
    // Handlers can subscribe with sessionId="*" to catch events from any session.
    const event: CDPMessage = {
      method: "Target.targetCreated",
      sessionId: "sess-xyz",
      params: {},
    };

    const broadcastKey = `*:${event.method}`;
    const sessionKey = `${event.sessionId}:${event.method}`;

    expect(broadcastKey).toBe("*:Target.targetCreated");
    expect(sessionKey).toBe("sess-xyz:Target.targetCreated");
  });
});
