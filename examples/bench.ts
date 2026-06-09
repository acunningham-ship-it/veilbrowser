/**
 * Latency snapshot. Veil's pitch includes "fast" — so measure the hot paths.
 *   bun run examples/bench.ts
 */
import { Browser } from "../src/index.js";

const now = () => Number(process.hrtime.bigint() / 1000000n);
const mark = async (label: string, fn: () => Promise<any>) => {
  const t = now();
  await fn();
  console.log(`  ${(now() - t).toString().padStart(5)} ms  ${label}`);
};

const t0 = now();
let browser!: Browser;
await mark("cold launch + CDP connect", async () => (browser = await Browser.launch({ headless: true })));
let page!: Awaited<ReturnType<Browser["newPage"]>>;
await mark("newPage + init (stealth armed)", async () => (page = await browser.newPage()));
await mark("goto data: page", () => page.goto("data:text/html,<input aria-label=q><button>Go</button>"));
let snap: any;
await mark("snapshot (AX tree)", async () => (snap = await page.snapshot()));
await mark("fill + click (human input)", async () => {
  await page.fill(snap.elements[0].ref, "hi");
  await page.click(snap.elements[1].ref);
});
await mark("screenshot (PNG)", () => page.screenshot());
console.log(`  -----\n  ${(now() - t0).toString().padStart(5)} ms  total`);
await browser.close();
