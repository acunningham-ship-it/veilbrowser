/**
 * FedCM end-to-end: complete a federated ("Sign in with Google"-style) login
 * that Chrome renders as a native account-chooser no click can reach.
 *   bun run examples/fedcm.ts          # headless (default)
 *   VEIL_HEADLESS=0 bun run examples/fedcm.ts   # headful (needs a display/Xvfb)
 *
 * Uses the canonical Chrome FedCM demo — a throwaway demo IdP with no real
 * credentials (any username, any ignored password). Proves veil can:
 *   1. establish the IdP session,
 *   2. intercept the FedCM account chooser over CDP (enableFedCm),
 *   3. select an account and land the RP signed in.
 */
import { Browser, type Page } from "../src/index.js";

const IDP = "https://fedcm-idp-demo.glitch.me/";
const RP = "https://fedcm-rp-demo.glitch.me/";
const ok = (c: boolean) => (c ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m");

/** Poll the snapshot until an element with one of the given roles appears. */
async function findRole(page: Page, roles: string[], timeout = 12000) {
  const start = Date.now();
  for (;;) {
    const snap = await page.snapshot();
    const hit = snap.elements.find((e) => roles.includes(e.role));
    if (hit) return hit;
    if (Date.now() - start > timeout) throw new Error(`no element with role ${roles.join("/")} after ${timeout}ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const browser = await Browser.launch({ headless: process.env.VEIL_HEADLESS !== "0" });
let passed = false;
try {
  const page = await browser.newPage();

  // --- 1. Sign in to the demo IdP (username -> ignored password) ---
  console.log("=== establishing IdP session ===");
  await page.goto(IDP);
  const user = await findRole(page, ["textbox", "searchbox"]);
  if (!user) throw new Error("IdP: no username field");
  await page.fill(user.ref, "veil-agent");
  const cont = await findRole(page, ["button"]);
  await page.click(cont!.ref);
  await page.waitFor(`/password|Welcome/i.test((document.body?document.body.innerText:''))`, { timeout: 15000 });

  if (/password/i.test(await page.innerText())) {
    const pw = await findRole(page, ["textbox"]);
    await page.fill(pw!.ref, "ignored");
    const signIn = await findRole(page, ["button"]);
    await page.click(signIn!.ref);
    await page.waitFor(`/Welcome/i.test((document.body?document.body.innerText:''))`, { timeout: 15000 });
  }
  console.log(`${ok(/Welcome/i.test(await page.innerText()))} IdP session established`);

  // --- 2. Intercept FedCM, then load the RP (passive mode fires the chooser) ---
  console.log("\n=== FedCM sign-in at the RP ===");
  await page.enableFedCm(); // autoSelectFirst:true -> picks account 0 for us
  await page.goto(RP);
  const dialog = await page.waitForFedCmDialog({ timeout: 20000 });
  console.log(`     dialog: ${dialog.type}, ${dialog.accounts.length} account(s)`);

  // --- 3. Confirm the RP considers us signed in ---
  await page.waitFor(`/You are signed in/i.test((document.body?document.body.innerText:''))`, { timeout: 15000 });
  const body = await page.innerText();
  const signedIn = /You are signed in/i.test(body);
  const who = body.match(/\(([^)]*@[^)]*)\)/)?.[1] ?? "?";
  console.log(`${ok(signedIn)} RP signed in as ${who}`);
  await page.disableFedCm();

  passed = signedIn;
  console.log(passed ? "\n\x1b[1mveil FedCM: end-to-end OK\x1b[0m\n" : "\n\x1b[31mFedCM flow did not complete\x1b[0m\n");
} finally {
  await browser.close();
}
process.exit(passed ? 0 : 1);
