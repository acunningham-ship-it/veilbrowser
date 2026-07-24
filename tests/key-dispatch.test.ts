/**
 * Unit tests for the actual key-event DISPATCH from type()/press() — the wire
 * layer below keyInfo. Drives a real Page against a MOCK CDP that just records
 * every command, so it runs in CI (no Chrome, no network).
 *
 * Guards two things veil's stealth story depends on:
 *   1. Shift coherence — typing an uppercase letter or a shifted symbol ("!",
 *      "@") carries the Shift modifier (CDP bit 8) on every one of its key
 *      events, so KeyboardEvent.shiftKey / getModifierState('Shift') agree with
 *      the character produced. A capital reported with shiftKey:false is a
 *      self-contradiction (unreachable without Shift) — a behavioural bot-tell,
 *      and it breaks handlers that gate on the shift state. Unshifted characters
 *      must NOT carry the modifier.
 *   2. press() covers the full navigation key set (Arrow{Up,Down,Left,Right},
 *      Delete, Home, End, PageUp, PageDown), each with the correct physical
 *      `code` and legacy windowsVirtualKeyCode.
 *
 * Run with: bun test tests/key-dispatch.test.ts
 */
import { describe, it, expect } from "bun:test";
import { Page } from "../src/page.js";

const SHIFT = 8; // CDP Input modifier bitfield: Alt 1, Ctrl 2, Meta 4, Shift 8.

/** A Page wired to a mock CDP that records commands and resolves them all with
 *  `{}` — enough for the fire-and-forget Input.dispatchKeyEvent path, which never
 *  reads a response. */
function mockPage() {
  const calls: Array<{ method: string; params: any }> = [];
  const cdp: any = {
    send(method: string, params: any = {}) {
      calls.push({ method, params });
      return Promise.resolve({});
    },
    on() {
      return () => {};
    },
    once() {
      return new Promise(() => {});
    },
    clearHandlers() {},
    close() {},
  };
  const page = new Page(cdp, "sess-test");
  const keyEvents = () => calls.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => c.params);
  return { page, keyEvents };
}

describe("type() — key events carry key/code/virtual-key on the wire", () => {
  it("lowercase 'a' → rawKeyDown, char, keyUp with KeyA/72 and NO shift", async () => {
    const { page, keyEvents } = mockPage();
    await page.type("a");
    const ev = keyEvents();
    expect(ev.map((e) => e.type)).toEqual(["rawKeyDown", "char", "keyUp"]);
    for (const e of ev) {
      expect(e.code).toBe("KeyA");
      expect(e.windowsVirtualKeyCode).toBe(65);
      expect(e.nativeVirtualKeyCode).toBe(65);
      expect(e.modifiers).toBeUndefined(); // no shift → modifier field omitted
    }
    // text is committed on rawKeyDown + char, not on keyUp.
    expect(ev[0].text).toBe("a");
    expect(ev[1].text).toBe("a");
    expect(ev[2].text).toBeUndefined();
  });
});

describe("type() — shift coherence (the bot-tell this fixes)", () => {
  it("uppercase 'A' holds Shift on every key event", async () => {
    const { page, keyEvents } = mockPage();
    await page.type("A");
    const ev = keyEvents();
    expect(ev.length).toBe(3);
    for (const e of ev) {
      expect(e.modifiers).toBe(SHIFT);
      expect(e.key).toBe("A");
      expect(e.code).toBe("KeyA");
      expect(e.windowsVirtualKeyCode).toBe(65); // VK_A — the physical KeyA, same for 'a'/'A'
    }
  });

  it("shifted symbol '@' holds Shift and rides the Digit2 key", async () => {
    const { page, keyEvents } = mockPage();
    await page.type("@");
    const ev = keyEvents();
    for (const e of ev) {
      expect(e.modifiers).toBe(SHIFT);
      expect(e.code).toBe("Digit2");
    }
  });

  it("'!' holds Shift", async () => {
    const { page, keyEvents } = mockPage();
    await page.type("!");
    for (const e of keyEvents()) expect(e.modifiers).toBe(SHIFT);
  });

  it("digit '1' and lowercase mate never hold Shift", async () => {
    const { page, keyEvents } = mockPage();
    await page.type("1");
    for (const e of keyEvents()) expect(e.modifiers).toBeUndefined();
  });

  it("a mixed string shifts exactly the glyphs that need it", async () => {
    const { page, keyEvents } = mockPage();
    await page.type("Ab1!");
    // 4 chars × 3 events each = 12; the shift flag tracks the source char.
    const shifted = keyEvents().map((e) => e.modifiers === SHIFT);
    expect(shifted).toEqual([
      true, true, true, // A
      false, false, false, // b
      false, false, false, // 1
      true, true, true, // !
    ]);
  });
});

describe("press() — named keys resolve to the right code + virtual-key", () => {
  const cases: Array<[string, string, number]> = [
    ["ArrowLeft", "ArrowLeft", 37],
    ["ArrowRight", "ArrowRight", 39],
    ["ArrowUp", "ArrowUp", 38],
    ["ArrowDown", "ArrowDown", 40],
    ["Delete", "Delete", 46],
    ["Home", "Home", 36],
    ["End", "End", 35],
    ["PageUp", "PageUp", 33],
    ["PageDown", "PageDown", 34],
    ["Escape", "Escape", 27],
    ["Tab", "Tab", 9],
  ];
  for (const [name, code, vk] of cases) {
    it(`${name} → ${code}/${vk}, no char event (produces no text)`, async () => {
      const { page, keyEvents } = mockPage();
      await page.press(name);
      const ev = keyEvents();
      expect(ev.map((e) => e.type)).toEqual(["rawKeyDown", "keyUp"]);
      for (const e of ev) {
        expect(e.code).toBe(code);
        expect(e.windowsVirtualKeyCode).toBe(vk);
      }
    });
  }

  it("Enter commits a carriage return (rawKeyDown + char + keyUp)", async () => {
    const { page, keyEvents } = mockPage();
    await page.press("Enter");
    const ev = keyEvents();
    expect(ev.map((e) => e.type)).toEqual(["rawKeyDown", "char", "keyUp"]);
    expect(ev[1].text).toBe("\r");
  });

  it("an unsupported key throws and names the known set", async () => {
    const { page } = mockPage();
    let msg = "";
    try {
      await page.press("F13");
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg).toMatch(/unsupported key F13/);
    expect(msg).toMatch(/ArrowLeft/); // the known-keys hint is included
  });
});
