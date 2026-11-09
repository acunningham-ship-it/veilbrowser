/**
 * Pure MCP argument validation/aliasing — split out from mcp.ts (which has
 * side effects at import time: it wires up stdin/SIGINT/SIGTERM as soon as
 * it's imported) so this logic is unit-testable without touching a process's
 * stdio. Fixes a reported pain point: 4 failed calls in one session from an
 * unknown-but-plausible param name being silently ignored — most costly at
 * veil_wait_for(text:...), where the real `expression` param stayed
 * undefined and the tool ran anyway, burning a full timeout on a condition
 * that could never be true.
 */
export interface ToolSpec {
    name: string;
    inputSchema: {
        properties?: Record<string, unknown>;
        required?: string[];
    };
}
/**
 * Common wrong-but-plausible param names an agent guesses, mapped to the real
 * one. Applied BEFORE validation, so a caller using the guess still works
 * instead of failing on a technicality — but validateArgs still fires (with
 * the REAL name) if even the alias is missing.
 */
export declare const PARAM_ALIASES: Record<string, Record<string, string>>;
/** Rewrite any known wrong-name keys in `args` to their real name (see
 *  PARAM_ALIASES), without touching a key that's already correct. */
export declare function applyAliases(name: string, args: any): any;
/**
 * Validate `args` against a tool's declared inputSchema before it ever
 * reaches the handler. Every required-param miss fails FAST with the actual
 * expected param name, instead of running the handler with `undefined` and
 * surfacing a confusing downstream symptom (see veil_wait_for's old
 * "waitFor timed out: undefined").
 */
export declare function validateArgs(tools: ToolSpec[], name: string, args: any): void;
