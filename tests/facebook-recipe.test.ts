import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../recipes/facebook.ts", import.meta.url).pathname, "utf8");

describe("facebook recipe encodes the findings, not just the happy path", () => {
  test("the blocker was the native chooser; fix is CDP setFileInputFiles", () => {
    expect(src).toMatch(/native GTK file chooser|native chooser|OS dialog/);
    expect(src).toMatch(/setFileInputFiles|uploadFile/);
  });
  test("opens the composer in TEXT mode, not via Photo/video", () => {
    expect(src).toMatch(/TEXT mode/i);
    expect(src).toMatch(/not[\s*]{0,12}"?photo\/video/i);
  });
  test("closes the hashtag autocomplete with exactly one Escape", () => {
    expect(src).toMatch(/hashtag autocomplete|hashtag AUTOCOMPLETE/i);
    expect(src).toMatch(/press exactly once|press\("Escape"\)/);
  });
  test("knows a 9:16 video is routed to the Reel flow (Next -> Post)", () => {
    expect(src).toMatch(/REEL flow|Reel flow/);
    expect(src).toMatch(/Next -> Next -> Post|clicked Next/);
  });
  test("dismisses the WhatsApp-button promo interstitial", () => {
    expect(src).toMatch(/WhatsApp/);
    expect(src).toMatch(/Not now/);
  });
  test("verifies on the Reels tab, never the Posts feed", () => {
    expect(src).toMatch(/reels_tab/);
    expect(src).toMatch(/NOT the Posts feed|not in the Posts feed/i);
  });
  test("refuses to post when the caption did not land", () => {
    expect(src).toMatch(/refusing to post captionless/);
  });
});
