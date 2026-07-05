/**
 * Veil vs. the scrapingcourse.com challenge suite — a reproducible anti-bot scorecard.
 *   bun run examples/scrapingcourse.ts            # headful (stealthiest; auto-Xvfb on a server)
 *   VEIL_HEADLESS=1 bun run examples/scrapingcourse.ts
 *
 * For each page it navigates, waits for any challenge to clear, screenshots to
 * examples/out/scrapingcourse/, and prints PASS / BLOCKED. Real Chrome runs the
 * challenge JS, so the walls solve themselves. A page counts as cleared when the
 * challenge text is gone AND either the Cloudflare challenge iframe is gone OR a
 * Cloudflare Turnstile token was issued (managed Turnstile passes veil precisely
 * because it's a real browser — it earns the token, it doesn't "solve a captcha").
 * What this does NOT do: image captchas (reCAPTCHA grids) or forced-interactive checks.
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
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const browser = await Browser.launch({ headless: process.env.VEIL_HEADLESS === "1" });
let passes = 0;
try {
  for (const url of URLS) {
    const page = await browser.newPage();
    const path = url.replace("https://www.scrapingcourse.com", "");
    let body = "", err = "", via = "", solvedAt = -1;
    try {
      await page.goto(url, { timeout: 45000 });
      for (let i = 0; i < 25; i++) {
        await sleep(1000);
        body = await page.innerText().catch(() => "");
        // "<hasCfIframe>|<turnstileTokenLength>"
        const st = await page.evaluate<string>(
          `(function(){var f=!!document.querySelector('iframe[src*="challenges.cloudflare.com"]');var t=document.querySelector('[name="cf-turnstile-response"]');return f+"|"+(t?(t.value||"").length:0)})()`
        ).catch(() => "false|0");
        const iframe = st.split("|")[0] === "true";
        const tokLen = parseInt(st.split("|")[1] || "0", 10);
        // cleared = challenge text gone AND (no CF challenge iframe, OR Turnstile issued a token)
        if (body && !CHALLENGE.test(body) && (!iframe || tokLen > 15)) {
          solvedAt = i + 1;
          via = tokLen > 15 ? "Turnstile token" : "auto-solved";
          break;
        }
      }
      writeFileSync(`${OUT}${slug(url)}.png`, await page.screenshot());
    } catch (e: any) {
      err = String(e?.message || e).slice(0, 100);
    }
    const cleared = !err && solvedAt > 0;
    if (cleared) passes++;
    const label = err ? red("ERROR  ") : cleared ? green("PASS   ") : red("BLOCKED");
    const detail = err || (cleared ? `(${solvedAt}s, ${via}) ` : "still challenged: ") + body.replace(/\s+/g, " ").slice(0, 44);
    console.log(`${label} ${path.padEnd(24)} ${detail}`);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`\n\x1b[1m${passes}/${URLS.length} cleared\x1b[0m — screenshots in ${OUT}`);
