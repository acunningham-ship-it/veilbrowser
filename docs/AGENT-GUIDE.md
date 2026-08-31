# Operating veil — an agent's guide

This is the doc to read instead of `src/` when you're operating veil, not
hacking on it. Two ways in: the **MCP tools** (`veil_*`, for an agent talking
to the veil MCP server) and the **`Page` API** (for driving veil directly from
TypeScript). Both wrap the same underlying methods — the tool docs below
double as the `Page` method docs; where a signature differs it's called out.

See [`examples/demo-batch.ts`](../examples/demo-batch.ts) /
[`docs/demo.cast`](demo.cast) for a real, runnable end-to-end flow using the
composites below (`asciinema play docs/demo.cast`, or `bun run
examples/demo-batch.ts` for the live version).

## The fast path: composites and batch (phase-2)

Profiling a real scrape+drill-down flow (goto → find a target → click → wait
→ extract) measured **8 separate MCP calls for one logical task** — and each
call is a full agent reasoning turn, which is the real cost, not Chrome's
response time. These primitives collapse that:

| Tool | Collapses | Page method |
|---|---|---|
| `veil_goto_and_wait` | goto + wait-for-something | `page.gotoAndWait(url, wait?, opts?)` |
| `veil_click_and_wait` | click + wait-for-something | `page.clickAndWait(query, wait?, opts?)` |
| `veil_extract_many` | N × extractText | `page.extractMany(fields)` |
| `veil_fill_form` | N × fillText | `page.fillForm(fields)` |
| `veil_batch` | any ordered sequence, in ONE round-trip | `runBatch(page, steps, opts?)` |

**The honesty rule, everywhere in this table:** none of these throw away a
real signal to report success. A wait timeout doesn't mean the action failed
— it means exactly what it says, reported separately. A batch step that runs
without throwing but whose *effect* didn't land (`scroll` returning
`moved:false`) shows that in its own result — it is never collapsed into a
blanket `ok: true`.

### `veil_goto_and_wait(url, wait?, waitUntil?)`

```json
{"url": "https://example.com", "wait": {"text": "Welcome", "timeout": 5000}}
```
Returns `{url, status, ok, retried?, wait?: {ok, error?}}`. Pass **at most
one** of `wait.text` / `wait.selector` / `wait.expression`; omit `wait`
entirely to just navigate (same as plain `veil_goto`). `wait` is omitted from
the result if no wait was requested.

### `veil_click_and_wait(query, wait?, nth?, exact?, role?)`

```json
{"query": "Submit", "wait": {"text": "Thank you", "timeout": 5000}}
```
Returns `{clicked: <the clicked element>, wait?: {ok, error?}}`. The click
itself either succeeded (and you get `clicked`) or threw — a `wait` timeout
never masks or is masked by that.

### `veil_extract_many(fields)`

```json
{"fields": {"title": "the headline", "price": "$"}}
```
`fields` maps a name you choose → the same query `veil_extract_text` would
take. Returns `Record<name, {ok:true, value} | {ok:false, error}>` — every
field is attempted independently; one miss doesn't hide or stop the rest.

### `veil_fill_form(fields)`

```json
{"fields": {"Name": "Ada", "Email": "ada@example.com"}}
```
`fields` maps each field's query → the value to type. v1 scope: plain text
targets only (input/textarea/contenteditable) — not select/checkbox/radio.
Same independent-per-field semantics as `extract_many`.

### `veil_batch(steps, continueOnError?)`

The general-purpose lever — run an ordered list of actions in one MCP
round-trip:

```json
{"steps": [
  {"action": "goto", "args": {"url": "https://news.ycombinator.com/"}},
  {"action": "clickText", "args": {"query": "75 comments"}},
  {"action": "waitForText", "args": {"text": "comments", "timeout": 8000}},
  {"action": "extractMany", "args": {"fields": {"commentCount": "comments"}}}
]}
```

**Known actions**: `goto, gotoAndWait, clickText, clickAndWait, fillText,
fillForm, extractText, extractMany, waitFor, waitForText, waitForSelector,
press, type, scroll, scrollToText, clickAt, eval`. Each step's `args` matches
that action's own `veil_*` tool args exactly (e.g. a `clickText` step's args
are `{query, nth?, exact?, role?}`).

**Design constraint, on purpose:** steps are query/text-based and resolve
their target at *execution time* — no snapshot refs, no inter-step data
passing. Step N cannot consume step N-1's return value. If a flow needs a
value only visible after a prior step (e.g. "click the 3rd story's comment
link" when you don't know that string ahead of time), do that one read
outside the batch first, same as the demo does — this is a deliberate v1
scope line, not an oversight, because a batch that quietly reused a stale
snapshot ref across steps would be less reliable than one extra call.

**Failure semantics — this is the part that matters:**
- By default, batch stops after the first step that throws; every step after
  it reports `status:"skipped"`. Pass `continueOnError:true` to run every
  step regardless of earlier failures.
- **`runBatch` itself never throws.** Every call gets back
  `{ok, steps: [{action, args, status: "ok"|"error"|"skipped", result?,
  error?, ms}]}` — one entry per step, always, so a broken step is
  diagnosable in one look instead of losing whatever ran before it.
- `ok` at the top level means *every step ran without throwing* — it does
  **not** mean every step's effect landed. A step whose action genuinely
  didn't move anything (a `scroll` with nowhere to scroll) still gets
  `status:"ok"` with its real, honest `result` (`{moved:false, dx:0, dy:0}`)
  passed through untouched. Check individual step `result`s for that, the
  same as you would for any single non-batch call.

## Everything else (phase-1)

### `veil_verify_url(url, expectText, userAgents?, timeout?)`

Fetches `url` **completely outside the browser session** — plain HTTP, a
real crawler UA (tried Facebook → Twitter → Googlebot in order), no cookies,
no login — and checks whether `expectText` (a string or array) appears in
the body. This is the ground-truth check after publishing anything: a tool's
own return value proves the click happened, not that the content is actually
live and visible to someone who *isn't* logged in as you. Doesn't need
`veil_goto` first — standalone. Returns `{ok, usedUserAgent, status, bytes,
found: Record<string, boolean>, snippet}`.

### Snapshot-free intent primitives

`veil_click_text(query)`, `veil_fill_text(query, value)`, `veil_extract_text(query)`
— match by visible text/label/placeholder, not a CSS selector or a
pre-fetched `ref`. Pierce shadow DOM. These are what the composites above are
built on.

### Navigation / waiting

- `veil_goto(url, waitUntil?)` — returns `{url, status, ok,
  timedOutWaitingForLoad?, retried?}`, the real post-navigation URL (not just
  the URL you asked for), and silently retries once if the navigation didn't
  actually happen.
- `veil_wait_for(expression, timeout?, poll?)` — poll a JS boolean expression.
- `veil_wait_for_selector(selector, timeout?, visible?)` — poll for a CSS
  selector, shadow-DOM aware.
- `veil_wait_for_text` (`page.waitForText`) — poll for visible text anywhere
  on the page, including inside shadow roots (plain `innerText` misses those).
  Reports a snippet of what the page *does* show on timeout, not just "not
  found".

### Input

- `veil_scroll(dx, dy)` — returns `{moved, dx, dy}` (the real distance moved,
  not a blind success claim). `veil_scroll_into_view` / `page.scrollToText`
  scrolls a text match into view.
- `veil_press(key, count?)` — repeat a key press `count` times.
- `veil_click`, `veil_type`, `veil_fill`, `veil_drag`, `veil_click_at`,
  `veil_double_click`, `veil_right_click` — ref-based / coordinate-based
  primitives for when snapshot refs are the right tool (see
  `veil_snapshot`).

### Everything else

`veil_snapshot` (accessibility-tree, ref-numbered), `veil_dom`
(`domSnapshot`, a live in-page DOM walk), `veil_screenshot`, `veil_pdf`,
`veil_eval`, `veil_frames` / `veil_use_frame` (iframe targeting),
`veil_fedcm_enable` / `veil_fedcm_signin` (native Google Sign-In), cookie and
fingerprint controls (`veil_get_cookies`, `veil_set_fingerprint`,
`veil_set_user_agent`, `veil_set_viewport`), download handling
(`veil_enable_downloads`, `veil_wait_for_download`), and upload
(`veil_upload`, `veil_upload_via_picker`). Full list + exact schemas:
`src/mcp.ts`'s `TOOLS` array — this doc covers what you need to operate
veil day to day, not every tool's full parameter surface.

## Direct `Page` API (no MCP)

```ts
import { Browser, runBatch } from "veil";

const browser = await Browser.launch({ headless: true });
const page = await browser.newPage();
await page.gotoAndWait("https://example.com", { text: "Welcome" });
const r = await runBatch(page, [
  { action: "clickText", args: { query: "Sign in" } },
  { action: "waitForText", args: { text: "Dashboard", timeout: 5000 } },
]);
```

Every MCP tool above is a thin wrapper over the matching `Page` method (same
name, same shape) plus `runBatch` for `veil_batch` — see `src/index.ts` for
the full export list.
