/**
 * Logged-out real-world test: do Reddit & Instagram serve Veil a normal page,
 * or flag/block/challenge it?  Headful + auto-Xvfb + real GPU.
 *   bun run examples/realsites.ts
 */
import { Browser } from "../src/index.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "out");
mkdirSync(OUT, { recursive: true });

// Capture the top-level HTTP status via the Network domain (read-only).
const BLOCK_WORDS = /(unusual (traffic|activity)|are you a robot|verify you('| a)re human|access denied|blocked|rate limit|too many requests|whoa there|something went wrong|press & hold|captcha)/i;

const browser = await Browser.launch({ headless: process.env.VEIL_HEADLESS === "1" });
const tests = [
  { name: "reddit-home", url: "https://www.reddit.com/" },
  { name: "reddit-sub", url: "https://www.reddit.com/r/popular/" },
  { name: "instagram-home", url: "https://www.instagram.com/" },
  { name: "instagram-profile", url: "https://www.instagram.com/nasa/" },
];

try {
  for (const t of tests) {
    const page = await browser.newPage();
    let status = 0;
    // sniff the main-document response status
    (browser as any); // page has its own session; hook Network on it
    await (page as any)["send"]?.("Network.enable").catch(() => {});
    const off = (page as any).cdp?.on?.("Network.responseReceived", (p: any) => {
      if (p.type === "Document" && !status) status = p.response?.status ?? 0;
    }, (page as any).sessionId);

    let finalUrl = "", title = "", bodyLen = 0, blocked = false, sample = "";
    try {
      await page.goto(t.url, { timeout: 40000 });
      await new Promise((r) => setTimeout(r, 2500));
      finalUrl = await page.evaluate<string>("location.href");
      title = await page.evaluate<string>("document.title");
      sample = await page.evaluate<string>("(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,400)");
      bodyLen = await page.evaluate<number>("(document.body?.innerText||'').length");
      blocked = BLOCK_WORDS.test(sample) || BLOCK_WORDS.test(title);
    } catch (e: any) {
      sample = `ERROR: ${e?.message}`;
    }
    off?.();

    const snap = await page.snapshot().catch(() => ({ elements: [] as any[] }));
    writeFileSync(join(OUT, `${t.name}.png`), await page.screenshot().catch(() => Buffer.alloc(0)));

    const verdict = blocked ? "\x1b[31mBLOCKED/CHALLENGE\x1b[0m" : bodyLen > 500 ? "\x1b[32mSERVED OK\x1b[0m" : "\x1b[33mTHIN/WALL\x1b[0m";
    console.log(`\n### ${t.name}  ->  ${verdict}`);
    console.log(`  http status : ${status || "?"}`);
    console.log(`  final url   : ${finalUrl}`);
    console.log(`  title       : ${title}`);
    console.log(`  body chars  : ${bodyLen}   interactive els: ${snap.elements.length}`);
    console.log(`  sample      : ${sample.slice(0, 220)}`);
  }
  console.log(`\nscreenshots -> ${OUT}/`);
} finally {
  await browser.close();
}
