/**
 * Generate the Python front end's stealth assets FROM the TypeScript source.
 *
 * Why generate instead of hand-porting: the stealth layer is the product. Two
 * hand-written copies of it would drift, and a drifted stealth patch does not fail
 * loudly — one front end just becomes detectable while all its tests stay green.
 * So the TS is the single source of truth, this script is the only way the Python
 * assets are allowed to change, and `tests/python-parity.test.ts` re-runs it and
 * fails if the committed assets differ from what the current TS emits.
 *
 *   bun run tools-gen-python-assets.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildStealth } from "./src/stealth.js";
import {
  FINGERPRINT_STEALTH_BODY,
  PRESETS,
  SCREEN_SETS,
  US_TIMEZONES,
  TZ_COORDS,
} from "./src/fingerprint.js";
import { CHROME_FLAGS_LEAD, CHROME_FLAGS_TAIL } from "./src/launcher.js";
import { keyInfo } from "./src/page.js";

// Overridable so the parity test can generate to a temp dir and diff against the
// committed assets, instead of mutating the working tree to check it is clean.
const OUT = process.env.VEIL_PY_ASSETS_OUT ?? join(import.meta.dir, "python", "veilbrowser", "_assets");
mkdirSync(OUT, { recursive: true });

const banner = (what: string) =>
  `/* GENERATED FROM ${what} by tools-gen-python-assets.ts — DO NOT EDIT.\n` +
  `   Edit the TypeScript source and re-run the generator; tests/python-parity.test.ts\n` +
  `   fails if this file and the TS disagree. */\n`;

// The fingerprint body, still holding its one __VEIL_FP__ placeholder. Python does
// the identical single-token substitution, so both languages emit the same bytes.
writeFileSync(
  join(OUT, "fingerprint_stealth.js"),
  banner("src/fingerprint.ts FINGERPRINT_STEALTH_BODY") + FINGERPRINT_STEALTH_BODY,
);

// The base self-gating patch, in both the variants page.ts actually asks for.
// buildStealth is only ever called as { maskWebgl }, so the vendor/renderer defaults
// are the only ones that can reach a page — two static files cover the whole surface.
writeFileSync(join(OUT, "base_stealth.js"), banner("src/stealth.ts buildStealth()") + buildStealth());
writeFileSync(
  join(OUT, "base_stealth_masked.js"),
  banner("src/stealth.ts buildStealth({maskWebgl:true})") + buildStealth({ maskWebgl: true }),
);

// Presets as data. Python reads these rather than restating the identities, so a
// preset fix lands in both front ends at once.
writeFileSync(
  join(OUT, "presets.json"),
  JSON.stringify(
    {
      _generated_from: "src/fingerprint.ts",
      presets: PRESETS,
      screenSets: SCREEN_SETS,
      usTimezones: US_TIMEZONES,
      tzCoords: TZ_COORDS,
    },
    null,
    2,
  ) + "\n",
);

// Launch flags. Part of the stealth surface, so shared rather than restated.
writeFileSync(
  join(OUT, "chrome_flags.json"),
  JSON.stringify(
    { _generated_from: "src/launcher.ts", lead: CHROME_FLAGS_LEAD, tail: CHROME_FLAGS_TAIL },
    null,
    2,
  ) + "\n",
);

// Keystroke descriptors, produced by calling the real keyInfo() over every
// printable ASCII char. Generated rather than retyped because a wrong `vk`/`code`
// is not a cosmetic bug: a text-only key event arrives with keyCode === 0 and
// code === "", which breaks keydown-driven login forms and is a hard bot-tell.
const keymap: Record<string, ReturnType<typeof keyInfo>> = {};
for (let c = 0x20; c <= 0x7e; c++) {
  const ch = String.fromCharCode(c);
  keymap[ch] = keyInfo(ch);
}
keymap["\n"] = keyInfo("\n");
writeFileSync(
  join(OUT, "keymap.json"),
  JSON.stringify({ _generated_from: "src/page.ts keyInfo()", keys: keymap }, null, 2) + "\n",
);

console.log(`wrote 6 assets to ${OUT}`);
for (const k of Object.keys(PRESETS)) console.log(`  preset: ${k}`);
