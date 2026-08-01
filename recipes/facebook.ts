/**
 * Facebook Page video/Reel posting, as a first-class veil recipe.
 *
 * Learned the hard way across 5 failed techniques on 2026-07-31, then solved 2026-08-01. Every
 * constant encodes one finding so nobody rediscovers it:
 *
 *   1. The blocker was NEVER the page — it was the native GTK file chooser. Clicking the visible
 *      "Photo/video" button opens an OS dialog, and every technique that let that dialog open
 *      then failed to hand the file to the page: the dialog "closed cleanly" (which reads as
 *      success) and the composer received nothing. THE FIX is to never let the OS dialog open:
 *      set the hidden <input type=file> directly with CDP DOM.setFileInputFiles (veil's
 *      uploadFile), or intercept the chooser (veil's uploadViaPicker). No native dialog, no
 *      false success.
 *   2. Open the composer in TEXT mode — click "What's on your mind?" / "Share a thought…", NOT
 *      "Photo/video". The Create-post dialog already contains a hidden
 *      `div[role=dialog] input[type=file][accept*="video"]`, so we attach WITHOUT any click.
 *   3. Typing a caption that ends in a #hashtag pops FB's hashtag AUTOCOMPLETE, an overlay that
 *      then "covers" the composer buttons — veil correctly refuses to click through it, which
 *      looks like a broken selector. One press("Escape") closes the autocomplete; a SECOND
 *      Escape prompts "Discard post?", so press exactly once.
 *   4. A 9:16 video is routed to the REEL flow: the bottom button becomes Next -> Next -> Post,
 *      not a single "Post". After the terminal Post, FB shows an "Add WhatsApp button" promo
 *      interstitial — dismiss it with "Not now" or the publish stalls behind it.
 *   5. A published Reel lands under the Page's REELS tab, NOT the Posts feed. Verifying against
 *      the Posts feed reports a false negative forever. Confirm on ?sk=reels_tab.
 *   6. The caption box is a contenteditable — it must be TYPED (setting .value/.innerText leaves
 *      React's state empty and posts captionless).
 *
 * Usage:
 *   await postFacebookReel(browser, { pageUrl, file, caption });
 */
import type { Browser } from "../src/browser.ts";

export interface FbReelOptions {
  /** The Page profile URL, e.g. https://www.facebook.com/profile.php?id=... */
  pageUrl: string;
  /** Absolute path to the mp4 (9:16 is routed to Reels). */
  file: string;
  caption: string;
  /** Set false to stop before the irreversible Post (dry run). */
  publish?: boolean;
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function els(page: any): Promise<any[]> {
  const s: any = await page.snapshot();
  return s.elements ?? s;
}
const named = (l: any[], rx: RegExp) => l.find((e) => rx.test(String(e.name ?? "").trim()));
const button = (l: any[], rx: RegExp) =>
  l.find((e) => rx.test(String(e.name ?? "").trim()) && /button/i.test(String(e.role ?? "")));

async function clickNamed(page: any, rx: RegExp, tries = 8): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const hit = named(await els(page), rx);
    if (hit) {
      try { await page.click(hit.ref); return true; }
      catch { await page.scroll(0, 200); await sleep(500); }
    } else await sleep(1000);
  }
  return false;
}

export async function postFacebookReel(browser: Browser, opts: FbReelOptions): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log("  " + m));
  const page = await (browser as any).newPage();
  try {
    await page.goto(opts.pageUrl, { timeout: 60000 });
    await sleep(6000);

    // Cookie/overlay pass — decline OPTIONAL cookies (privacy), never accept all.
    for (const rx of [/Decline optional/i, /Only allow essential/i, /^Not Now$/i]) {
      if (await clickNamed(page, rx, 1)) { log(`dismissed overlay: ${rx}`); await sleep(1000); }
    }

    // (2) Open the composer in TEXT mode — no chooser fires.
    if (!(await clickNamed(page, /what'?s on your mind|share a thought|create (a )?post/i, 6)))
      throw new Error("facebook: could not open the composer");
    await sleep(3500);

    // (6) Caption first; the modal opens with the textbox focused. Type in chunks, then VERIFY.
    const box = named(await els(page), /what'?s on your mind|type|say something/i);
    if (box) await page.click(box.ref).catch(() => {});
    await sleep(800);
    for (const chunk of opts.caption.trim().match(/[\s\S]{1,40}/g) ?? []) { await page.type(chunk); await sleep(120); }
    await sleep(1200);
    const landed = await page.evaluate(
      `[...document.querySelectorAll('[contenteditable="true"]')].map(e=>(e.innerText||'').trim()).filter(Boolean).join("\\n")`,
    );
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    if (!norm(String(landed)).includes(norm(opts.caption).slice(0, 40)))
      throw new Error("facebook: caption did not land — refusing to post captionless");
    log("caption verified in editor");

    // (3) Close the hashtag autocomplete BEFORE touching the composer buttons. Exactly one Escape.
    await page.press("Escape");
    await sleep(1000);

    // (1)+(2) Attach by setting the hidden input directly — no click, no OS dialog. Fall back to
    // the chooser-intercept picker if the input is created lazily.
    let attached = false;
    for (const sel of ['div[role=dialog] input[type=file][accept*="video"]', 'div[role=dialog] input[type=file]']) {
      try { await page.uploadFile([opts.file], sel); attached = true; log(`attached via ${sel}`); break; } catch {}
    }
    if (!attached) {
      const pv = named(await els(page), /^Photo\/video$/i) || named(await els(page), /photo\/video/i);
      if (!pv) throw new Error("facebook: no file input and no Photo/video button");
      await page.uploadViaPicker(pv.ref, [opts.file], { timeout: 20000 });
      log("attached via intercepted picker");
    }

    // Wait for the preview to render.
    let preview = false;
    for (let i = 0; i < 30; i++) {
      await sleep(5000);
      if (await page.evaluate(`!!document.querySelector('div[role=dialog] video')`)) { preview = true; break; }
    }
    if (!preview) throw new Error("facebook: no video preview — treat as NOT attached");
    log("video preview present");

    if (opts.publish === false) { log("dry run — stopping before Post"); return; }

    // (4) Reel flow: Next -> Next -> Post (terminal). Cap the walk.
    for (let step = 0; step < 5; step++) {
      const l = await els(page);
      const terminal = button(l, /^(Publish|Post|Share now|Share)$/i);
      if (terminal) { await page.click(terminal.ref); log(`clicked terminal: ${terminal.name}`); break; }
      const next = button(l, /^Next$/i);
      if (next) { await page.click(next.ref); log("clicked Next"); await sleep(3500); continue; }
      await sleep(2500);
    }

    // (4) Dismiss the "Add WhatsApp button" promo, then click Post if it re-presents.
    for (let i = 0; i < 4; i++) {
      if (await clickNamed(page, /^Not now$/i, 1)) { log("dismissed WhatsApp promo"); await sleep(2000); break; }
      await sleep(1000);
    }
    await clickNamed(page, /^(Publish|Post|Share)$/i, 3);

    // (5) VERIFY on the Reels tab — a published reel is NOT in the Posts feed.
    await page.goto(opts.pageUrl + "&sk=reels_tab", { timeout: 60000 }).catch(() => {});
    await sleep(6000);
    const key = norm(opts.caption).slice(0, 30);
    const live = await page.evaluate(
      `(${JSON.stringify(key)} && (document.querySelector('div[role=main]')?.innerText||'').replace(/\\s+/g,' ').includes(${JSON.stringify(key)}))`,
    );
    if (!live) throw new Error("facebook: reel not visible in the Reels tab — UNCONFIRMED, check the Page");
    log("posted — reel confirmed in the Reels tab");
  } finally {
    await page.close().catch(() => {});
  }
}
