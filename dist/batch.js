/** Actions runBatch knows how to execute — the query/text/coordinate-based
 *  primitives that don't need a snapshot ref from a prior step. Keep this
 *  list curated, not "every Page method": ref-based actions (click(ref),
 *  fill(ref), select(ref)) need a snapshot taken outside the batch first,
 *  which breaks self-containment, so they're intentionally excluded from v1. */
export const BATCH_ACTIONS = [
    "goto", "gotoAndWait", "clickText", "clickAndWait", "fillText", "fillForm",
    "extractText", "extractMany", "waitFor", "waitForText", "waitForSelector",
    "press", "type", "scroll", "scrollToText", "clickAt", "eval",
];
async function runOne(page, step) {
    const a = step.args ?? {};
    switch (step.action) {
        case "goto":
            if (!a.url)
                throw new Error(`goto: missing required arg "url"`);
            return page.goto(a.url, a.opts);
        case "gotoAndWait":
            if (!a.url)
                throw new Error(`gotoAndWait: missing required arg "url"`);
            return page.gotoAndWait(a.url, a.wait, a.opts);
        case "clickText":
            if (!a.query)
                throw new Error(`clickText: missing required arg "query"`);
            return page.clickText(a.query, a.opts);
        case "clickAndWait":
            if (!a.query)
                throw new Error(`clickAndWait: missing required arg "query"`);
            return page.clickAndWait(a.query, a.wait, a.opts);
        case "fillText":
            if (!a.query || a.value === undefined)
                throw new Error(`fillText: missing required arg "query" and/or "value"`);
            return page.fillText(a.query, a.value, a.opts);
        case "fillForm":
            if (!a.fields)
                throw new Error(`fillForm: missing required arg "fields"`);
            return page.fillForm(a.fields);
        case "extractText":
            if (!a.query)
                throw new Error(`extractText: missing required arg "query"`);
            return page.extractText(a.query, a.opts);
        case "extractMany":
            if (!a.fields)
                throw new Error(`extractMany: missing required arg "fields"`);
            return page.extractMany(a.fields);
        case "waitFor":
            if (!a.expression)
                throw new Error(`waitFor: missing required arg "expression"`);
            return page.waitFor(a.expression, a.opts);
        case "waitForText":
            if (!a.text)
                throw new Error(`waitForText: missing required arg "text"`);
            return page.waitForText(a.text, a.opts);
        case "waitForSelector":
            if (!a.selector)
                throw new Error(`waitForSelector: missing required arg "selector"`);
            return page.waitForSelector(a.selector, a.opts);
        case "press":
            if (!a.key)
                throw new Error(`press: missing required arg "key"`);
            return page.press(a.key, a.count ?? 1);
        case "type":
            if (a.text === undefined)
                throw new Error(`type: missing required arg "text"`);
            return page.type(a.text);
        case "scroll":
            return page.scroll(a.dx ?? 0, a.dy ?? 0, a.opts);
        case "scrollToText":
            if (!a.query)
                throw new Error(`scrollToText: missing required arg "query"`);
            return page.scrollToText(a.query, a.opts);
        case "clickAt":
            if (a.x == null || a.y == null)
                throw new Error(`clickAt: missing required arg "x" and/or "y"`);
            return page.clickAt(a.x, a.y);
        case "eval":
            if (!a.expression)
                throw new Error(`eval: missing required arg "expression"`);
            return page.evaluate(a.expression);
        default:
            throw new Error(`unknown batch action ${JSON.stringify(step.action)} — known actions: ${BATCH_ACTIONS.join(", ")}`);
    }
}
/**
 * Execute `steps` in order. Stops after the first step that throws (its
 * outcome is recorded as "error", every remaining step as "skipped") unless
 * `continueOnError` is set, in which case every step runs regardless. Either
 * way, ALL steps up to that point — successes and failures — are in the
 * returned array; nothing is ever lost or thrown past this function.
 */
export async function runBatch(page, steps, opts = {}) {
    const results = [];
    let broke = false;
    for (const step of steps) {
        if (broke && !opts.continueOnError) {
            results.push({ action: step.action, args: step.args, status: "skipped", ms: 0 });
            continue;
        }
        const t0 = Date.now();
        try {
            const result = await runOne(page, step);
            results.push({ action: step.action, args: step.args, status: "ok", result, ms: Date.now() - t0 });
        }
        catch (e) {
            results.push({ action: step.action, args: step.args, status: "error", error: String(e?.message ?? e), ms: Date.now() - t0 });
            broke = true;
        }
    }
    return { ok: results.every((r) => r.status === "ok"), steps: results };
}
