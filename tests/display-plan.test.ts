/**
 * Regression: a headful launch must stay headful on macOS/Windows.
 *
 * The Xvfb decision used to key only on "DISPLAY is unset", which is always
 * true off Linux (no X11 there), so every `headless: false` launch on a Mac or
 * Windows box tried to start Xvfb, failed, and silently fell back to headless.
 * displayPlan() is the pure decision behind that, so each platform's branch is
 * checked here without needing a Mac or a Windows machine (CI is Linux-only).
 */
import { describe, it, expect } from "bun:test";
import { displayPlan } from "../src/launcher.js";

const display = (on: boolean) => {
  const calls = { n: 0 };
  return { calls, probe: () => (calls.n++, on) };
};

describe("displayPlan", () => {
  it("linux, headful, no DISPLAY -> start our own Xvfb", () => {
    const d = display(true);
    expect(displayPlan({ platform: "linux", macHasDisplay: d.probe })).toBe("xvfb");
    expect(d.calls.n).toBe(0);
  });

  it("linux, headful, a real DISPLAY exists -> launch as-is", () => {
    const d = display(true);
    expect(displayPlan({ platform: "linux", displayEnv: ":0", macHasDisplay: d.probe })).toBe("as-is");
  });

  it("linux, headless -> as-is (no Xvfb needed)", () => {
    const d = display(true);
    expect(displayPlan({ platform: "linux", headless: true, macHasDisplay: d.probe })).toBe("as-is");
  });

  it("darwin, headful, monitor attached -> as-is (stays headful, no Xvfb)", () => {
    const d = display(true);
    expect(displayPlan({ platform: "darwin", macHasDisplay: d.probe })).toBe("as-is");
    expect(d.calls.n).toBe(1);
  });

  it("darwin, headful, NO monitor attached -> degrade to headless", () => {
    const d = display(false);
    expect(displayPlan({ platform: "darwin", macHasDisplay: d.probe })).toBe("headless");
  });

  it("darwin, already headless -> as-is, and never pays for the system_profiler probe", () => {
    const d = display(false);
    expect(displayPlan({ platform: "darwin", headless: true, macHasDisplay: d.probe })).toBe("as-is");
    expect(d.calls.n).toBe(0);
  });

  it("win32, headful -> as-is (the bug: this used to try Xvfb and silently go headless)", () => {
    const d = display(false);
    expect(displayPlan({ platform: "win32", macHasDisplay: d.probe })).toBe("as-is");
    expect(d.calls.n).toBe(0);
  });

  it("an explicit xvfb option wins over the platform default, both ways", () => {
    const d = display(true);
    expect(displayPlan({ platform: "win32", xvfb: true, macHasDisplay: d.probe })).toBe("xvfb");
    expect(displayPlan({ platform: "linux", xvfb: false, macHasDisplay: d.probe })).toBe("as-is");
  });
});
