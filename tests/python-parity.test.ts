/**
 * The Python front end must emit the SAME stealth bytes as the TypeScript one.
 *
 * This is the test that makes `python/` safe to ship. Two hand-maintained copies of
 * a stealth patch drift, and a drifted patch does not fail loudly — one front end
 * simply becomes detectable while all of its own tests stay green. So the shared
 * payloads are GENERATED from the TS (tools-gen-python-assets.ts) and this test
 * fails the build if either (a) the committed assets no longer match what the TS
 * emits, or (b) Python's assembled script differs from the TS's by a single byte.
 */
import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildFingerprintStealth, FINGERPRINT_STEALTH_BODY, PRESETS } from "../src/fingerprint.js";
import { buildStealth } from "../src/stealth.js";
import { CHROME_FLAGS_LEAD, CHROME_FLAGS_TAIL } from "../src/launcher.js";
import { keyInfo } from "../src/page.js";

const ROOT = join(import.meta.dir, "..");
const ASSETS = join(ROOT, "python", "veilbrowser", "_assets");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const py = (code: string) =>
  execFileSync("python3", ["-c", code], {
    cwd: join(ROOT, "python"),
    encoding: "utf8",
    // Force UTF-8 so a C-locale CI box cannot make this pass or fail for reasons
    // that have nothing to do with the code under test.
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });

test("injected scripts are pure ASCII (bun's transpiler corrupts String.raw otherwise)", () => {
  // MEASURED, not defensive: bun escapes non-ASCII to \uXXXX when it transpiles.
  // In a normal template that is value-preserving, but String.raw's value IS its
  // raw text, so `String.raw`a—b`` is 3 chars under node and 8 under bun — the
  // literal characters \ u 2 0 1 4 end up in the script served to the page.
  // Today's occurrences were all inside // comments, so nothing broke; one em dash
  // inside a string VALUE would have silently changed what the patch does, and
  // differently per runtime. Keeping these templates ASCII removes the whole class.
  const scripts: Array<[string, string]> = [
    ["fingerprint body", FINGERPRINT_STEALTH_BODY],
    ["base stealth", buildStealth()],
    ["base stealth + webgl mask", buildStealth({ maskWebgl: true })],
    ...Object.entries(PRESETS).map(([k, fp]) => [`fingerprint(${k})`, buildFingerprintStealth(fp)] as [string, string]),
  ];
  for (const [name, src] of scripts) {
    const bad = [...src].filter((c) => c.codePointAt(0)! > 127);
    expect(bad, `${name} contains non-ASCII: ${JSON.stringify(bad.join(""))}`).toEqual([]);
  }
});

test("committed python assets match what the generator emits now", () => {
  const tmp = mkdtempSync(join(tmpdir(), "veil-assets-"));
  execFileSync("bun", ["run", join(ROOT, "tools-gen-python-assets.ts")], {
    cwd: ROOT,
    env: { ...process.env, VEIL_PY_ASSETS_OUT: tmp },
    encoding: "utf8",
  });
  const fresh = readdirSync(tmp).sort();
  expect(fresh.length).toBeGreaterThan(0);
  expect(readdirSync(ASSETS).sort()).toEqual(fresh);
  for (const f of fresh) {
    // A mismatch means someone edited the TS without re-running the generator (or
    // edited a generated asset by hand). Re-run: bun run tools-gen-python-assets.ts
    expect(readFileSync(join(ASSETS, f), "utf8"), `stale asset: ${f}`).toEqual(
      readFileSync(join(tmp, f), "utf8"),
    );
  }
});

test("the stealth layer imports WITHOUT the websockets dependency", () => {
  // This is a regression guard for a real CI failure, not a hypothetical: websockets
  // was imported at module scope, so `from veilbrowser.fingerprint import ...` pulled
  // it in, and the four parity tests below failed the 1.3.0 release with
  // ModuleNotFoundError on a box that simply had no pip install — a failure with
  // nothing to do with what they test. Blocking the import explicitly means this holds
  // whether or not the machine running the test happens to have websockets.
  const out = py(
    "import sys\n" +
      "class Block:\n" +
      "    def find_spec(self, name, path=None, target=None):\n" +
      "        if name == 'websockets' or name.startswith('websockets.'):\n" +
      "            raise ImportError('blocked by test')\n" +
      "        return None\n" +
      "sys.meta_path.insert(0, Block())\n" +
      "from veilbrowser.fingerprint import Fingerprint, build_fingerprint_stealth, chrome_flags\n" +
      "from veilbrowser.page import key_info\n" +
      "assert build_fingerprint_stealth(Fingerprint.preset('windows-chrome'))\n" +
      "assert chrome_flags() and key_info('a')\n" +
      "print('ok')",
  );
  expect(out.trim()).toBe("ok");
});

test("python emits byte-identical fingerprint stealth for every preset", () => {
  const out = py(
    "import hashlib, json\n" +
      "from veilbrowser.fingerprint import Fingerprint, build_fingerprint_stealth\n" +
      "print(json.dumps({k: hashlib.sha256(build_fingerprint_stealth(Fingerprint.preset(k)).encode()).hexdigest() for k in Fingerprint.presets()}))",
  );
  const pyHashes = JSON.parse(out) as Record<string, string>;
  expect(Object.keys(pyHashes).sort()).toEqual(Object.keys(PRESETS).sort());
  for (const [name, fp] of Object.entries(PRESETS)) {
    expect(pyHashes[name], `preset ${name} diverged`).toBe(sha(buildFingerprintStealth(fp)));
  }
});

test("python emits byte-identical base stealth, both variants", () => {
  const out = py(
    "import hashlib, json\n" +
      "from veilbrowser.fingerprint import build_stealth\n" +
      "print(json.dumps({str(m): hashlib.sha256(build_stealth(mask_webgl=m).encode()).hexdigest() for m in (False, True)}))",
  );
  const h = JSON.parse(out) as Record<string, string>;
  expect(h["False"]).toBe(sha(buildStealth()));
  expect(h["True"]).toBe(sha(buildStealth({ maskWebgl: true })));
});

test("python uses the same launch flags", () => {
  const out = py(
    "import json\nfrom veilbrowser.fingerprint import chrome_flags\nprint(json.dumps(chrome_flags()))",
  );
  const [lead, tail] = JSON.parse(out) as [string[], string[]];
  expect(lead).toEqual(CHROME_FLAGS_LEAD);
  expect(tail).toEqual(CHROME_FLAGS_TAIL);
  // The one flag whose absence is silently detectable rather than merely different.
  expect(tail).toContain("--disable-blink-features=AutomationControlled");
});

test("python resolves the same keystroke descriptors", () => {
  const out = py(
    "import json\nfrom veilbrowser.page import key_info\n" +
      "chars = [chr(c) for c in range(0x20, 0x7f)] + ['\\n']\n" +
      "print(json.dumps({c: key_info(c) for c in chars}))",
  );
  const pyKeys = JSON.parse(out) as Record<string, any>;
  for (const c of [...Array(0x7f - 0x20).keys()].map((i) => String.fromCharCode(i + 0x20)).concat("\n")) {
    const k = keyInfo(c);
    expect(pyKeys[c], `keystroke for ${JSON.stringify(c)} diverged`).toEqual({
      key: k.key,
      code: k.code,
      vk: k.vk,
      text: k.text,
      shift: k.shift,
    });
  }
  // Guard the reason this table is shared at all: a text-only key event arrives
  // with keyCode === 0, which breaks keydown-driven login forms and is a bot-tell.
  expect(pyKeys["!"]).toEqual({ key: "!", code: "Digit1", vk: 49, text: "!", shift: true });
  expect(pyKeys["a"].vk).toBe(65);
});
