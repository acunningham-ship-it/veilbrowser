/**
 * Extra parameter-name aliases for the MCP server, layered on mcp-validate's PARAM_ALIASES.
 * About a quarter of failed tool calls were agents guessing a parameter name. The canonical name stays the
 * documented one; an alias is only used when the canonical key is absent. Scoped per tool so an alias never
 * leaks onto a tool where the same word means something else (e.g. veil_pdf's real `path`).
 */
import { applyAliases } from "./mcp-validate.js";

const QUERY = { selector: "query", css: "query" };

export const NEW_ALIASES: Record<string, Record<string, string>> = {
  veil_click_text: QUERY,
  veil_fill_text: QUERY,
  veil_extract_text: QUERY,
  veil_scroll_into_view: QUERY,
  veil_fill: { value: "text" },
  veil_type: { value: "text" },
  veil_eval: { script: "expression", expr: "expression" },
  veil_wait_for: { script: "expression", expr: "expression" },
  veil_batch: { actions: "steps" },
  veil_enable_downloads: { path: "dir" },
  veil_drag: {
    to_x: "toX", endX: "toX", to_y: "toY", endY: "toY",
    from_x: "fromX", startX: "fromX", from_y: "fromY", startY: "fromY",
  },
  veil_scroll: { deltaY: "dy", deltaX: "dx" },
};

/** Rewrite aliased keys to canonical ones (new table first, then the legacy one). */
export function normalizeArgs(name: string, args: any): any {
  let out = args;
  const aliases = NEW_ALIASES[name];
  if (aliases && out && typeof out === "object") {
    out = { ...out };
    for (const [wrong, right] of Object.entries(aliases)) {
      if (out[right] === undefined && out[wrong] !== undefined) {
        out[right] = out[wrong];
        delete out[wrong];
      }
    }
  }
  return applyAliases(name, out);
}
