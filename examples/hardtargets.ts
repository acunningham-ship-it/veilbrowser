/**
 * Hard-target honesty test. The easy detectors (sannysoft/CreepJS) and content
 * sites (Reddit/IG) say little about COMMERCIAL bot walls. These two do:
 *   - nowsecure.nl       : sits behind Cloudflare's JS challenge. "passed" = bypassed CF.
 *   - bot.incolumitas.com: fingerprint + behavioural score (0..1, higher = more human).
 *   bun run examples/hardtargets.ts
 */
import { Browser } from "../src/index.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "out");
mkdirSync(OUT, { recursive: true });
const browser = await Browser.launch({ headless: process.env.VEIL_HEADLESS === "1" });

const challenges = [
  { name: "cloudflare", url: "https://www.scrapingcourse.com/cloudflare-challenge", pass: /you bypassed|product|add to cart/i, wall: /just a moment|checking|verify you are human|attention required/i },
  { name: "antibot", url: "https://www.scrapingcourse.com/antibot-challenge", pass: /you bypassed|product|add to cart/i, wall: /just a moment|checking|blocked|denied/i },
];

try {
  for (const c of challenges) {
    console.log(`\n=== ${c.name}: ${c.url} ===`);
    const page = await browser.newPage();
    try {
      await page.goto(c.url, { timeout: 50000 });
      let body = "";
      for (let i = 0; i < 25; i++) {
        body = await page.evaluate<string>("(document.body?.innerText||'')");
        if (c.pass.test(body)) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const title = await page.evaluate<string>("document.title");
      const clean = body.replace(/\s+/g, " ").slice(0, 220);
      const passed = c.pass.test(body);
      const walled = c.wall.test(body) || c.wall.test(title);
      console.log(`  ${passed ? "\x1b[32mBYPASSED\x1b[0m" : walled ? "\x1b[31mBLOCKED/CHALLENGE\x1b[0m" : "\x1b[33mUNCLEAR\x1b[0m"}`);
      console.log(`  title: ${title}`);
      console.log(`  body : ${clean}`);
      writeFileSync(join(OUT, `${c.name}.png`), await page.screenshot());
    } catch (e: any) {
      console.log(`  ERROR: ${e?.message}`);
    }
  }
  console.log(`\nscreenshots -> ${OUT}/`);
} finally {
  await browser.close();
}
