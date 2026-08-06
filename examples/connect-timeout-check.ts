/**
 * Browser.connect() must FAIL FAST against a wedged browser, not hang.
 *
 * A wedged Chrome keeps its debug port open and still completes the TCP handshake — it
 * simply never answers. Before this check, connect()'s /json/version fetch had no timeout,
 * so it waited forever, and a caller with a launch fallback never reached the fallback.
 * Observed 2026-08-06: the morning scrape cron sat in exactly this state until its own
 * 300s timeout killed it, having printed nothing, so it looked like a slow scrape rather
 * than a stuck connect.
 *
 *   bun run examples/connect-timeout-check.ts
 *
 * Needs no Chrome: it stands up a socket that accepts and stays silent, which is the
 * failure mode reproduced exactly.
 */
import net from "node:net";
import { Browser } from "../src/index.js";

const PORT = 9556;
const srv = net.createServer(() => { /* accept, then never respond */ });
await new Promise<void>((r) => srv.listen(PORT, "127.0.0.1", () => r()));

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!ok) failures++;
};

// 1. It gives up, and quickly.
const t0 = Date.now();
try {
  await Browser.connect(`127.0.0.1:${PORT}`, { timeoutMs: 2000 });
  check("rejects a wedged endpoint", false, "connect() RETURNED — it should have thrown");
} catch (e: any) {
  const ms = Date.now() - t0;
  check("rejects a wedged endpoint", true, `threw after ${ms}ms`);
  // 2. Fast enough that a caller's own fallback still gets a turn.
  check("fails fast, not on the caller's timeout", ms < 6000, `${ms}ms (budget 2000ms + slack)`);
  // 3. The message has to name the real cause. "fetch failed" would send the next person
  //    hunting a network problem when the fix is to restart the browser.
  check("message names the cause", /wedged/.test(e.message) && /restart/.test(e.message),
        JSON.stringify(e.message.slice(0, 120)));
}

// 4. A port with nothing on it must still fail fast, and say something different.
const t1 = Date.now();
try {
  await Browser.connect("127.0.0.1:9557", { timeoutMs: 2000 });
  check("rejects a dead port", false, "connect() RETURNED");
} catch (e: any) {
  const ms = Date.now() - t1;
  check("rejects a dead port quickly", ms < 6000, `threw after ${ms}ms`);
  check("dead port reads differently from a wedged one", !/wedged/.test(e.message),
        JSON.stringify(e.message.slice(0, 90)));
}

srv.close();
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
