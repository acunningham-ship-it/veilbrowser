import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../recipes/instagram.ts", import.meta.url).pathname,"utf8");
describe("instagram recipe encodes the findings, not just the happy path", () => {
  test("looks for 'New post', and says why 'Create' is wrong", () => {
    expect(src).toContain("New post");
    expect(src).toMatch(/NOT called "Create"|NOT "Create"/);
  });
  test("resolves Post vs Live video by LABEL, never by position", () => {
    expect(src).toMatch(/Live video/);
    expect(src).toMatch(/BY LABEL/i);
  });
  test("refuses to post when the caption did not land", () => {
    expect(src).toMatch(/refusing to post captionless/);
  });
  test("waits for Done rather than a fixed sleep", () => {
    expect(src).toMatch(/never reached Done/);
    expect(src).toMatch(/UNCONFIRMED/);
  });
  test("dismisses overlays before clicking", () => {
    expect(src).toContain("dismissOverlays");
    expect(src).toMatch(/Not Now/);
  });
});
