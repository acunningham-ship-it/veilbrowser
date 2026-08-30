/**
 * Pure MCP argument validation/aliasing — split out from mcp.ts (which has
 * side effects at import time: it wires up stdin/SIGINT/SIGTERM as soon as
 * it's imported) so this logic is unit-testable without touching a process's
 * stdio. Fixes joe's pain-list #4: 4 failed calls in one session from an
 * unknown-but-plausible param name being silently ignored — most costly at
 * veil_wait_for(text:...), where the real `expression` param stayed
 * undefined and the tool ran anyway, burning a full timeout on a condition
 * that could never be true.
 */
/**
 * Common wrong-but-plausible param names an agent guesses, mapped to the real
 * one. Applied BEFORE validation, so a caller using the guess still works
 * instead of failing on a technicality — but validateArgs still fires (with
 * the REAL name) if even the alias is missing.
 */
export const PARAM_ALIASES = {
    veil_upload: { files: "paths", file: "paths" },
    veil_click_text: { text: "query", selector: "query" },
    veil_fill_text: { text: "query", selector: "query" },
    veil_extract_text: { text: "query", selector: "query" },
    veil_wait_for_text: { expression: "text", selector: "text" },
};
/** Rewrite any known wrong-name keys in `args` to their real name (see
 *  PARAM_ALIASES), without touching a key that's already correct. */
export function applyAliases(name, args) {
    const aliases = PARAM_ALIASES[name];
    if (!aliases || !args)
        return args;
    const out = { ...args };
    for (const [wrong, right] of Object.entries(aliases)) {
        if (out[right] === undefined && out[wrong] !== undefined) {
            out[right] = out[wrong];
            delete out[wrong];
        }
    }
    return out;
}
/**
 * Validate `args` against a tool's declared inputSchema before it ever
 * reaches the handler. Every required-param miss fails FAST with the actual
 * expected param name, instead of running the handler with `undefined` and
 * surfacing a confusing downstream symptom (see veil_wait_for's old
 * "waitFor timed out: undefined").
 */
export function validateArgs(tools, name, args) {
    const tool = tools.find((t) => t.name === name);
    if (!tool)
        return; // unknown tool name — the caller's own dispatch handles this
    const required = tool.inputSchema.required ?? [];
    const props = Object.keys(tool.inputSchema.properties ?? {});
    const missing = required.filter((r) => args?.[r] === undefined);
    if (missing.length) {
        const got = args && Object.keys(args).length ? Object.keys(args).join(", ") : "nothing";
        throw new Error(`${name}: missing required param${missing.length > 1 ? "s" : ""} ${missing.map((m) => `"${m}"`).join(", ")} ` +
            `(got: ${got}; this tool's params are: ${props.join(", ")})`);
    }
}
