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
export declare const DEFAULT_DEADLINE_MS = 45000;
/** Tools whose normal runtime legitimately exceeds the default. */
export declare const TOOL_DEADLINES_MS: Record<string, number>;
/**
 * Deadline in ms for one call. VEIL_TOOL_DEADLINE_MS replaces the default (not the per-tool map);
 * a caller-supplied `timeout` arg (ms) extends the deadline to timeout + 10 s so the tool's own,
 * more specific timeout error wins the race.
 */
export declare function deadlineFor(tool: string, args: any, env?: Record<string, string | undefined>): number;
/** Resolve with `work`, or reject after `ms` with an actionable message. The late result is swallowed. */
export declare function withDeadline<T>(tool: string, ms: number, work: Promise<T>): Promise<T>;
