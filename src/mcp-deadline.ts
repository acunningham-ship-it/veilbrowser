/**
 * Per-call deadline for the MCP server's tools/call handler.
 *
 * Why: mcp.ts serializes every message through ONE promise chain (browser state is shared). A tool
 * that never settles (a stalled CDP call on a heavy SPA) therefore wedged every later call, and the host
 * saw the whole server as disconnected. Racing each call against a timer returns an error the agent can
 * act on and lets the chain continue.
 *
 * Caveat, stated: the timer abandons the call, it does not cancel it. The stalled CDP request may still
 * complete later in the background; the error text tells the agent to use a lighter tool meanwhile.
 */

export const DEFAULT_DEADLINE_MS = 45_000;

/** Tools whose normal runtime legitimately exceeds the default. */
export const TOOL_DEADLINES_MS: Record<string, number> = {
  veil_wait_for: 120_000,
  veil_wait_for_text: 120_000,
  veil_wait_for_selector: 120_000,
  veil_wait_for_download: 120_000,
  veil_goto_and_wait: 120_000,
  veil_click_and_wait: 120_000,
  veil_upload_via_picker: 120_000,
  veil_batch: 180_000,
};

/**
 * Deadline in ms for one call. VEIL_TOOL_DEADLINE_MS replaces the default (not the per-tool map);
 * a caller-supplied `timeout` arg (ms) extends the deadline to timeout + 10 s so the tool's own,
 * more specific timeout error wins the race.
 */
export function deadlineFor(tool: string, args: any, env: Record<string, string | undefined> = process.env): number {
  const envMs = Number(env.VEIL_TOOL_DEADLINE_MS);
  const base = Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_DEADLINE_MS;
  let ms = TOOL_DEADLINES_MS[tool] !== undefined && !(Number.isFinite(envMs) && envMs > 0) ? TOOL_DEADLINES_MS[tool] : base;
  const t = Number(args?.timeout);
  if (Number.isFinite(t) && t > 0) ms = Math.max(ms, t + 10_000);
  return ms;
}

/** Resolve with `work`, or reject after `ms` with an actionable message. The late result is swallowed. */
export function withDeadline<T>(tool: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${Math.round(ms / 1000)}s on ${tool}; page may be stalled, try veil_dom or veil_click_text`)),
      ms,
    );
  });
  work.catch(() => {}); // an abandoned call that later rejects must not become an unhandled rejection
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}
