/**
 * Unit tests for the MCP arg validation/aliasing pulled out of mcp.ts (see
 * mcp-validate.ts's own header for why: mcp.ts wires up stdin/SIGINT as soon
 * as it's imported, so its logic couldn't be unit-tested directly). Fixes
 * joe's pain-list #4 — pure logic, no browser needed.
 */
import { describe, it, expect } from "bun:test";
import { applyAliases, validateArgs, PARAM_ALIASES, type ToolSpec } from "../src/mcp-validate.js";

describe("applyAliases", () => {
  it("rewrites a known wrong param name to the real one", () => {
    // joe's exact repro: veil_upload(files:[...]) instead of paths:[...]
    expect(applyAliases("veil_upload", { files: ["/a.png"] })).toEqual({ paths: ["/a.png"] });
  });

  it("leaves the args alone when the correct name is already used", () => {
    expect(applyAliases("veil_upload", { paths: ["/a.png"] })).toEqual({ paths: ["/a.png"] });
  });

  it("does not overwrite a correct param with a stale alias if both are present", () => {
    // the real `paths` wins; a stray leftover `files` key is harmless (nothing
    // downstream reads it) so it's left alone rather than deleted.
    expect(applyAliases("veil_upload", { paths: ["/real.png"], files: ["/ignored.png"] }).paths)
      .toEqual(["/real.png"]);
  });

  it("is a no-op for a tool with no configured aliases", () => {
    expect(applyAliases("veil_click", { ref: 3 })).toEqual({ ref: 3 });
  });

  it("handles every tool listed in PARAM_ALIASES", () => {
    for (const [tool, aliases] of Object.entries(PARAM_ALIASES)) {
      for (const [wrong, right] of Object.entries(aliases)) {
        const result = applyAliases(tool, { [wrong]: "x" });
        expect(result[right]).toBe("x");
        expect(result[wrong]).toBeUndefined();
      }
    }
  });
});

describe("validateArgs", () => {
  const tools: ToolSpec[] = [
    { name: "veil_wait_for", inputSchema: { properties: { expression: {}, timeout: {}, poll: {} }, required: ["expression"] } },
    { name: "veil_click", inputSchema: { properties: { ref: {} }, required: ["ref"] } },
    { name: "veil_scroll", inputSchema: { properties: { dx: {}, dy: {} }, required: [] } },
  ];

  it("throws naming the ACTUAL required param — joe's exact repro (veil_wait_for(text:...) instead of expression)", () => {
    expect(() => validateArgs(tools, "veil_wait_for", { text: "No issues found", timeout: 120000 }))
      .toThrow(/missing required param "expression"/);
  });

  it("the error lists what the caller actually passed and what the tool accepts", () => {
    try {
      validateArgs(tools, "veil_wait_for", { text: "x" });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("got: text");
      expect(e.message).toContain("expression, timeout, poll");
    }
  });

  it("passes when the required param IS present", () => {
    expect(() => validateArgs(tools, "veil_wait_for", { expression: "true" })).not.toThrow();
  });

  it("passes for a tool with no required params, called with nothing", () => {
    expect(() => validateArgs(tools, "veil_scroll", {})).not.toThrow();
    expect(() => validateArgs(tools, "veil_scroll", undefined)).not.toThrow();
  });

  it("silently no-ops for an unknown tool name (the real dispatch handles that error)", () => {
    expect(() => validateArgs(tools, "veil_does_not_exist", {})).not.toThrow();
  });

  it("reports multiple missing params at once, not just the first", () => {
    const t: ToolSpec[] = [{ name: "x", inputSchema: { properties: { a: {}, b: {} }, required: ["a", "b"] } }];
    expect(() => validateArgs(t, "x", {})).toThrow(/"a", "b"/);
  });
});
