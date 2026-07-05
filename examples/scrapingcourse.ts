/**
 * Veil vs. the scrapingcourse.com challenge suite — a reproducible anti-bot scorecard.
 *   bun run examples/scrapingcourse.ts            # headful (stealthiest; auto-Xvfb on a server)
 *   VEIL_HEADLESS=1 bun run examples/scrapingcourse.ts
 *
 * For each page it navigates, waits for any JS challenge to auto-solve (polls until
 * the challenge text clears and Cloudflare's challenge iframe is gone), screenshots
 * to examples/out/scrapingcourse/, and prints PASS / BLOCKED / interactive-widget.
 * Real Chrome executes the challenge JS, so the non-interactive walls solve themselves.
 * Interactive captchas (Turnstile/reCAPTCHA) are NOT auto-solved — and we say so.
 */
import { Browser } from "../src/index.js";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = new URL("./out/scrapingcourse/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const URLS = [
  "https://www.scrapingcourse.com/antibot-challenge",
  "https://www.scrapingcourse.com/cloudflare-challenge",
  "https://www.scrapingcourse.com/login/cf-antibot",
  "https://www.scrapingcourse.com/login/cf-turnstile",
  "https://www.scrapingcourse.com/login/csrf",
  "https://www.scrapingcourse.com/login",
  "https://www.scrapingcourse.com/ecommerce",
  "https://www.scrapingcourse.com/javascript-rendering",
  "https://www.scrapingcourse.com/button-click",
  "https://www.scrapingcourse.com/infinite-scrolling",
  "https://www.scrapingcourse.com/pagination",
  "https://www.scrapingcourse.com/table-parsing",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const slug = (u: string) => u.replace("https://www.scrapingcourse.com/", "").replace(/\//g, "_") || "home";
// text present while a challenge is still running (or a hard block)
const CHALLENGE = /performing security verification|just a moment|checking your browser|verify(ing)? you are( a)? human|enable javascript and cookies|attention required|you have been blocked|access denied|error 10\d\d/i;
const ok = (c: boolean) => (c ? "\x1b[32mPASS\x1b[0m   " : "\x1b[31mBLOCKED\x1b[0m");

const browser = await Browser.launch({ headless: process.env.VEIL_HEADLESS === "1" });
let passes = 0;
try {
  for (const url of URLS) {
    const page = await browser.newPage();
    const path = url.replace("https://www.scrapingcourse.com", "");
    let body = "", widget = "", err = "", solvedAt = -1;
    try {
      await page.goto(url, { timeout: 45000 });
      for (let i = 0; i < 25; i++) {
        await sleep(1000);
        body = await page.innerText().catch(() => "");
        const cfIframe = await page.evaluate<boolean>(`!!document.querySelector('iframe[src*="challenges.cloudflare.com"]')`).catch(() => false);
        if (body && !CHALLENGE.test(body) && !cfIframe) { solvedAt = i + 1; break; }
      }
      widget = await page.evaluate<string>(
        `(function(){return document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile, [name="cf-turnstile-response"]')?'interactive-widget':''})()`
      ).catch(() => "");
      writeFileSync(`${OUT}${slug(url)}.png`, await page.screenshot());
    } catch (e: any) {
      err = String(e?.message || e).slice(0, 100);
    }
    const cleared = !err && !!body && !CHALLENGE.test(body) && !widget;
    if (cleared) passes++;
    const label = err ? `\x1b[31mERROR\x1b[0m  ` : cleared ? ok(true) : widget ? "\x1b[33mWIDGET\x1b[0m " : ok(false);
    console.log(`${label} ${path.padEnd(24)} ${err || (cleared ? `(${solvedAt}s) ` : "") + body.replace(/\s+/g, " ").slice(0, 46)}`);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`\n\x1b[1m${passes}/${URLS.length} cleared\x1b[0m — screenshots in ${OUT}`);
console.log("WIDGET = page loads but an interactive captcha (Turnstile) is present and not auto-solved.");
