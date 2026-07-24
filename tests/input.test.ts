/**
 * Unit tests for keyInfo — the char→keystroke mapping behind type()/fill().
 *
 * Pure logic (no browser), so it runs in CI. The bug it guards against: the old
 * type() dispatched text-only key events with no key/code/virtual-key code, so
 * the page saw KeyboardEvent.keyCode===0 and code==="" — broken keydown UIs and
 * a hard bot-tell on login forms. Every printable ASCII char must now resolve to
 * a non-empty code and a non-zero windowsVirtualKeyCode.
 *
 * Run with: bun test tests/input.test.ts
 */
import { describe, it, expect } from "bun:test";
import { keyInfo } from "../src/page.js";

describe("keyInfo — letters", () => {
  it("lowercase 'a' → KeyA / vk 65, no shift", () => {
    expect(keyInfo("a")).toEqual({ key: "a", code: "KeyA", vk: 65, text: "a", shift: false });
  });
  it("uppercase 'A' → KeyA / vk 65, key preserves case, shift held", () => {
    expect(keyInfo("A")).toEqual({ key: "A", code: "KeyA", vk: 65, text: "A", shift: true });
  });
  it("'z' → KeyZ / vk 90", () => {
    expect(keyInfo("z")).toEqual({ key: "z", code: "KeyZ", vk: 90, text: "z", shift: false });
  });
});

describe("keyInfo — digits", () => {
  it("'0' → Digit0 / vk 48", () => {
    expect(keyInfo("0")).toEqual({ key: "0", code: "Digit0", vk: 48, text: "0", shift: false });
  });
  it("'9' → Digit9 / vk 57", () => {
    expect(keyInfo("9")).toEqual({ key: "9", code: "Digit9", vk: 57, text: "9", shift: false });
  });
});

describe("keyInfo — symbols share their physical key", () => {
  it("space → Space / vk 32", () => {
    expect(keyInfo(" ")).toEqual({ key: " ", code: "Space", vk: 32, text: " ", shift: false });
  });
  it("'@' rides the Digit2 key (Shift+2)", () => {
    expect(keyInfo("@")).toEqual({ key: "@", code: "Digit2", vk: 50, text: "@", shift: true });
  });
  it("'.' → Period / vk 190", () => {
    expect(keyInfo(".")).toEqual({ key: ".", code: "Period", vk: 190, text: ".", shift: false });
  });
  it("'-' and '_' share the Minus key", () => {
    expect(keyInfo("-").code).toBe("Minus");
    expect(keyInfo("_").code).toBe("Minus");
    expect(keyInfo("_").vk).toBe(189);
  });
});

describe("keyInfo — shift coherence (a shifted glyph must report shift held)", () => {
  it("uppercase letters need shift; lowercase do not", () => {
    for (const c of "ABCXYZ") expect(keyInfo(c).shift).toBe(true);
    for (const c of "abcxyz") expect(keyInfo(c).shift).toBe(false);
  });
  it("shifted symbols need shift; their unshifted key-mates do not", () => {
    for (const c of '!@#$%^&*()_+{}|:"<>?~') expect(keyInfo(c).shift).toBe(true);
    for (const c of "1234567890-=[]\\;',./`") expect(keyInfo(c).shift).toBe(false);
  });
  it("digits and space never need shift", () => {
    for (const c of "0123456789 ") expect(keyInfo(c).shift).toBe(false);
  });
});

describe("keyInfo — Enter and fallback", () => {
  it("'\\n' → Enter with a carriage-return commit", () => {
    expect(keyInfo("\n")).toEqual({ key: "Enter", code: "Enter", vk: 13, text: "\r", shift: false });
  });
  it("unknown chars (emoji/CJK) degrade to a text-only commit", () => {
    const e = keyInfo("é");
    expect(e.code).toBe("");
    expect(e.vk).toBe(0);
    expect(e.text).toBe("é");
    expect(e.shift).toBe(false);
  });
});

describe("keyInfo — no printable ASCII char is a keyCode===0 bot-tell", () => {
  it("every printable ASCII char has a non-empty code and non-zero vk", () => {
    for (let c = 0x20; c <= 0x7e; c++) {
      const ch = String.fromCharCode(c);
      const info = keyInfo(ch);
      expect(info.code).not.toBe("");
      expect(info.vk).toBeGreaterThan(0);
      expect(info.text).toBe(ch);
    }
  });
});
