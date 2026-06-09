/**
 * Adversarial detection test. Drives Veil against the public bot-detection
 * pages and reports what they actually conclude.
 *   bun run examples/detect.ts                 (headless — note: no GPU here)
 *   VEIL_HEADFUL=1 bun run examples/detect.ts  (needs a display / Xvfb)
 *
 * Writes screenshots to examples/out/.
 */
import { Browser } from "../src/index.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "out");
mkdirSync(OUT, { recursive: true });
const headless = process.env.VEIL_HEADFUL !== "1";

const browser = await Browser.launch({ headless, windowSize: { width: 1280, height: 1600 } });
try {
  const page = await browser.newPage();

  // --- sannysoft: a results table, fails get a red background ---
  console.log(`\n=== bot.sannysoft.com  (headless=${headless}) ===`);
  await page.goto("https://bot.sannysoft.com/", { timeout: 45000 });
  await page.waitFor("document.querySelectorAll('td').length > 4", { timeout: 15000 });

  const rows = await page.evaluate<{ name: string; value: string; fail: boolean }[]>(`
    (() => {
      const out = [];
      for (const tr of document.querySelectorAll('tr')) {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 2) continue;
        const name = tds[0].innerText.trim();
        const cell = tds[tds.length - 1];
        const value = cell.innerText.trim().replace(/\\s+/g, ' ').slice(0, 60);
        const bg = getComputedStyle(cell).backgroundColor;
        const m = bg.match(/rgba?\\((\\d+), (\\d+), (\\d+)/);
        // red-ish background = failed check
        const fail = !!m && +m[1] > 150 && +m[2] < 120 && +m[3] < 120;
        if (name) out.push({ name, value, fail });
      }
      return out;
    })()
  `);

  const fails = rows.filter((r) => r.fail);
  for (const r of rows) {
    if (!r.name || r.name.length > 40) continue;
    console.log(`  ${r.fail ? "\x1b[31mFAIL\x1b[0m" : "\x1b[32m ok \x1b[0m"}  ${r.name.padEnd(32)} ${r.value}`);
  }
  console.log(`\n  sannysoft: ${rows.length} checks, \x1b[1m${fails.length} flagged as bot-like\x1b[0m`);
  writeFileSync(join(OUT, "sannysoft.png"), await page.screenshot({ fullPage: true }));

  // --- CreepJS: computes a trust score + counts "lies" ---
  console.log(`\n=== creepjs (trust score) ===`);
  const cj = await browser.newPage();
  await cj.goto("https://abrahamjuliot.github.io/creepjs/", { timeout: 45000 });
  // CreepJS scores asynchronously (workers). Poll up to 45s for a % to appear,
  // but never hard-fail — just report whatever it has.
  for (let i = 0; i < 45; i++) {
    const ready = await cj.evaluate<boolean>(`/\\d+%/.test(document.body.innerText) && /trust/i.test(document.body.innerText)`);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await new Promise((r) => setTimeout(r, 2000));
  const txt = await cj.evaluate<string>("document.body.innerText");
  const grab = (re: RegExp) => (txt.match(re)?.[0] ?? "n/a").replace(/\s+/g, " ").trim();
  console.log(`  ${grab(/trust score:?[^\n]*/i)}`);
  console.log(`  ${grab(/bot:?[^\n]*/i)}`);
  console.log(`  ${grab(/lies\s*\(?\d+\)?[^\n]*/i)}`);
  console.log(`  ${grab(/\d+%\s*\w*/)}`);
  writeFileSync(join(OUT, "creepjs.png"), await cj.screenshot({ fullPage: true }));

  console.log(`\n  screenshots -> ${OUT}/`);
} finally {
  await browser.close();
}
