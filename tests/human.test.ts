/**
 * Unit tests for human.ts — PRNG, mouse paths, keystroke timing.
 *
 * Tests the pure logic: determinism, output bounds, distribution.
 * Run with: bun test tests/human.test.ts
 */
import { describe, it, expect } from "bun:test";
import { Rng, mousePath, moveDelay, keyDelay } from "../src/human.js";

describe("Rng (seedable PRNG)", () => {
  it("next() returns [0, 1)", () => {
    const rng = new Rng(42);
    for (let i = 0; i < 100; i++) {
      const n = rng.next();
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });

  it("same seed is deterministic", () => {
    const rng1 = new Rng(12345);
    const rng2 = new Rng(12345);
    for (let i = 0; i < 50; i++) {
      expect(rng1.next()).toBe(rng2.next());
    }
  });

  it("range(min, max) respects bounds", () => {
    const rng = new Rng(999);
    for (let i = 0; i < 100; i++) {
      const n = rng.range(10, 20);
      expect(n).toBeGreaterThanOrEqual(10);
      expect(n).toBeLessThanOrEqual(20);
    }
  });

  it("int(min, max) returns integers in range", () => {
    const rng = new Rng(777);
    for (let i = 0; i < 100; i++) {
      const n = rng.int(5, 15);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThanOrEqual(15);
    }
  });
});

describe("mousePath (human-like Bézier paths)", () => {
  it("generates points from start to end", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 100 };
    const rng = new Rng(111);
    const path = mousePath(from, to, rng);

    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path[path.length - 1]).toEqual(to);
  });

  it("all points within reasonable bounds", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 100 };
    const rng = new Rng(111);
    const path = mousePath(from, to, rng);

    for (const p of path) {
      expect(p.x).toBeGreaterThanOrEqual(-100);
      expect(p.x).toBeLessThanOrEqual(200);
      expect(p.y).toBeGreaterThanOrEqual(-100);
      expect(p.y).toBeLessThanOrEqual(200);
    }
  });

  it("step count scales with distance", () => {
    const rng = new Rng(222);
    const short = mousePath({ x: 0, y: 0 }, { x: 10, y: 10 }, rng);
    const long = mousePath({ x: 0, y: 0 }, { x: 500, y: 500 }, rng);

    // Longer paths should have more steps (distance-proportional).
    expect(long.length).toBeGreaterThan(short.length);
  });
});

describe("keystroke & move timing", () => {
  it("keyDelay has correct ranges by char type", () => {
    const rng = new Rng(333);

    // Regular char: [45, 130]
    const regular = keyDelay(rng, "a");
    expect(regular).toBeGreaterThanOrEqual(45);
    expect(regular).toBeLessThanOrEqual(130);

    // Space: [60, 140]
    const space = keyDelay(rng, " ");
    expect(space).toBeGreaterThanOrEqual(60);
    expect(space).toBeLessThanOrEqual(140);

    // Punctuation: [120, 260]
    const punct = keyDelay(rng, ".");
    expect(punct).toBeGreaterThanOrEqual(120);
    expect(punct).toBeLessThanOrEqual(260);
  });

  it("moveDelay returns [4, 12]", () => {
    const rng = new Rng(444);
    for (let i = 0; i < 50; i++) {
      const delay = moveDelay(rng);
      expect(delay).toBeGreaterThanOrEqual(4);
      expect(delay).toBeLessThanOrEqual(12);
    }
  });
});
