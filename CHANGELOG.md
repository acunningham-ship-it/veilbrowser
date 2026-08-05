# Changelog

## 1.6.0 — 2026-08-05

### Added
- **MCP attach mode — `VEIL_CDP_URL`.** The MCP server can now drive a Chrome that is
  already running, instead of only launching its own.

  ```jsonc
  { "env": { "VEIL_CDP_URL": "127.0.0.1:9333" } }
  ```

  `connect()` has been the library answer since 1.3; the MCP had no equivalent, which meant
  the one thing agents most need a browser for — a profile a human is signed into — was the
  one thing the MCP could not do, because Chrome locks the `user-data-dir` and refuses a
  second instance. Every attempt died with a bare `CDP connection closed`, a message that
  names a socket and means a profile lock.

  It takes the tab already open rather than adding a blank one. An unreachable endpoint
  falls back to launching, so a day when nobody started the shared browser degrades the
  server instead of disabling it, and a launch that then hits the lock says so in words
  that name the fix.

### Fixed
- **A dead browser no longer poisons a long-lived MCP server.** The server outlives the
  Chrome it is attached to; a cached connection to a browser that has since quit rejected
  every later call with `CDP connection closed` until the server itself was restarted. It
  now detects the dropped connection and reconnects on the next call.
  `examples/mcp-attach-check.ts --recovery` covers this end to end (kills the browser
  mid-session and asserts the next call still works — it fails without the fix).

## 1.5.0 — 2026-07-27

### Added
- **Origin allowlist — confine an agent that is attached to a signed-in profile.**

  ```ts
  Browser.connect("127.0.0.1:9222", { allowOrigins: ["github.com"] })
  await page.restrictOrigins([...]); await page.unrestrictOrigins();
  ```

  `connect()` is the only way to drive a logged-in profile, and it hands the agent **every
  session in that cookie jar**. An agent told "check my order" can navigate to your mailbox,
  because it is the same browser. 1.3.x documented that boundary; this is the mechanism.

  Any **document** navigation — top-level or sub-frame — to a host outside the list fails
  `AccessDenied`. Entries match host plus subdomains **on a dot boundary**, so `github.com`
  covers `api.github.com` and rejects `notgithub.com` and `github.com.evil.tld`. Suffix
  matching without the boundary check is the classic hole in this kind of guard, so it has
  dedicated tests.

  **A deliberate asymmetry from the neighbouring guard:** the private-network block *exempts*
  the agent's own top-level navigation. This one has **no main-frame exemption**, because here
  the top-level navigation IS the threat. Copying the adjacent guard's shape would have
  produced something that blocks nothing.

  Implemented as guard #0 inside the existing `Fetch.requestPaused` handler that already
  reconciles the private-network block and resource blocking, with a Document-only intercept
  pattern so subresources are never paused — no per-image round trip.

  **What it does NOT do, in the README as well, because an over-trusted security control is
  worse than none:** subresources are not gated (gating them breaks every real site, and a
  guard that breaks sites gets switched off); everything on an allowed origin is fully
  reachable as that user; and a beacon-style POST to an unlisted origin is not blocked,
  because it is not a document.

  Raised by **u/zhonglin** on r/AI_Agents, who pointed out that reusing an authenticated
  browser moves the profile inside the agent's trust boundary.

### Verified
220/220 tests. Sensitivity checked by disabling **only** the guard block while leaving
`isOriginAllowed` exported — a compile error would have gone red for the wrong reason — giving
10 pass / 1 fail, the failure being exactly the blocked-navigation case. The matcher was then
re-tested independently against 14 adversarial hosts including both boundary attacks.


## 1.4.0 — 2026-07-27

### Fixed
- **A ref is now an IDENTITY, not a position — a stale ref can no longer click a different
  element and report success.** Refs were renumbered `1..N` on every `snapshot()`, so an agent
  holding `ref 2` across a DOM change could press whatever slid into slot 2. Reproduced:
  `snap1 [1:Alpha, 2:Bravo, 3:Charlie]` → a banner is dismissed → `snap2 [1:Bravo, 2:Charlie]`
  → `click(2)` **did not throw and pressed Charlie**. That is the worst shape an agent failure
  can take: it looks like it worked.

  Reachable in practice, not theoretical: through MCP every tool call is independent, **no tool
  re-snapshots before acting**, and the model holds refs in its own context.

  **The detail that decided the design: a caller cannot predict renumbering.** Two insertion
  paths, same logical mutation, opposite outcomes — `appendChild` into a div above leaves
  numbering alone (the AX tree appends), while `document.body.prepend` shifts everything. So
  "did the DOM change in a way that renumbers?" is not answerable by the consumer, which is why
  documentation alone would not have fixed this.

  Now `backendNodeId → ref` is memoised for the life of the document, so **a number is never
  reused for a different element**. A removed node stops resolving and errors loudly. Identity
  resets on navigation and frame switch.

  Rejected alternatives, with reasons: **content-addressed refs** (hash of role+name+path)
  break whenever an accessible name changes (`Loading…`→`Submit`, `Cart (2)`→`Cart (3)`, i18n)
  and — far worse — silently **rebind among same-named siblings**, which is the standard case of
  ten "Delete" buttons in a list; that reintroduces the exact silent-wrong-element bug, and the
  disambiguating path is the selector fragility Veil exists to avoid. **Generation-tagging**
  (reject every ref from an older snapshot) makes staleness loud but punishes correct usage,
  forcing a full re-read after any re-snapshot.

  **Cost, stated plainly:** refs now develop gaps and can appear out of order (a newly prepended
  element is listed first while holding the highest number), and the identity map grows with
  distinct nodes seen per document. Not pruned — it resets on navigation.

  Credit to **u/Ok-Regret-2934** on r/AI_Agents, who said numbered elements "break on every dom
  change." That was correct, and it was reachable and silent.

### Changed
- README no longer claims ref numbering is "sequential, no gaps" — that held only for the first
  snapshot of a document. A doc that overpromises stability is how a caller comes to trust a
  stale ref.

### Verified
209/209 tests. The 5 new cases in `tests/ref-cross-snapshot.test.ts` were checked for
sensitivity by reverting `src/page.ts` alone: **4 of 5 go RED against the old implementation**
(the fifth — numbering resets on navigation — correctly passes both ways). A green test nobody
has seen fail would have been worth nothing here.


## 1.3.1 — 2026-07-26

### Fixed
- **`veilbrowser` (Python) no longer needs `websockets` just to build a stealth
  script.** It was imported at module scope, so `from veilbrowser.fingerprint import
  ...` pulled in the whole dependency — which failed the 1.3.0 release in CI with
  `ModuleNotFoundError` on a box that had no pip install, for a reason unrelated to
  anything the tests were checking. The import is now inside `CDP.connect()`, where it
  is actually needed, and raises a message naming the fix instead of a bare
  `ModuleNotFoundError`. `tests/python-parity.test.ts` now blocks the import
  explicitly, so this holds whether or not the machine running the tests happens to
  have `websockets` installed. (1.3.0 was tagged but never published — npm went
  straight from 1.2.0 to 1.3.1.)

## 1.3.0 — 2026-07-26

### Added
- **A Python front end** (`python/`, `pip install git+…#subdirectory=python`) with
  `Browser.launch()` / `Browser.connect()` / `pages()` and a selector-based Page API
  (`goto`, `click`, `fill`, `type`, `press`, `select`, `wait_for_selector`,
  `wait_for_response`, `screenshot`, `pdf`, cookies, `evaluate`). One dependency
  (`websockets`); everything else is stdlib, because a stealth tool with someone
  else's HTTP stack in the middle of it is not one.

  **The stealth layer is not reimplemented.** The injected script, the launch flags,
  the profile identities and the keystroke table are GENERATED from the TypeScript
  source into `python/veilbrowser/_assets/` by `tools-gen-python-assets.ts`, and
  `tests/python-parity.test.ts` fails the build if Python's assembled script differs
  from the TypeScript one by a single byte. Two hand-maintained copies of a stealth
  patch drift, and a drifted patch does not fail loudly — one front end just becomes
  detectable while all of its own tests stay green.

  Verified: 21 checks against a real Chrome, run from the INSTALLED wheel outside the
  source tree (`python/tests/test_smoke.py`) — webdriver false, UA/platform/screen/
  timezone/WebGL from the profile, getters masked as `[native code]` and inherited
  from the prototype rather than own-properties, canvas noise stable across reads,
  real keyCodes (not 0), and `close()` on an attached browser leaving it alive.

  Deliberately not ported: the snapshot/ref system, auto-Xvfb, downloads, FedCM,
  frame switching. `Fingerprint.random(seed)` is deterministic but does not match the
  TypeScript `random(seed)` — different PRNGs, and nothing needs the two languages to
  agree on a random identity, only on the stealth script.
- `CHROME_FLAGS_LEAD` / `CHROME_FLAGS_TAIL` and `FINGERPRINT_STEALTH_BODY` are now
  exported, so the flag list and the injected body have one definition shared by both
  front ends instead of a copy in each.

### Fixed
- **The injected scripts are now pure ASCII, and a test enforces it.** Bun's
  transpiler escapes non-ASCII to `\uXXXX`, which is value-preserving in a normal
  template but NOT in `String.raw`, where the raw text IS the value: measured,
  ``String.raw`a—b` `` is 3 characters under node and **8 under bun**, with the
  literal characters `\ u 2 0 1 4` ending up in the script served to the page. Veil
  runs under bun, so the em dashes in the stealth patch's comments were reaching
  pages as escape sequences. All seven occurrences were inside `//` comments, so
  nothing was broken — but one non-ASCII character inside a string VALUE would have
  silently changed what the patch does, differently per runtime. Keeping these
  templates ASCII removes the class of bug, and it is what makes byte-parity with
  Python possible at all (node, bun and Python now emit identical bytes for every
  preset).

## 1.2.0 — 2026-07-26

### Added
- **`Browser.connect(endpoint)` + `browser.pages()`** — attach to an
  ALREADY-RUNNING Chrome instead of launching one. Chrome locks a `user-data-dir`,
  so the profile holding your real logged-in sessions cannot be opened by a second
  instance; previously the only options were killing the browser holding it or
  copying the whole profile and losing the live session. This is what makes the
  sites that matter reachable: Google, Reddit, Meta and TikTok score the **session**,
  not the IP, so an established profile passes where a fresh one hits a wall.
  Accepts a `ws://` URL, an `http://` origin, or a bare `host:port`. `pages()`
  returns the tabs that already exist (skipping `devtools://` and extensions).
  **`close()` on an attached Browser detaches only — it never kills a process it did
  not start.** A fingerprint is deliberately not re-applied to an attached page:
  changing `navigator` properties under a loaded document contradicts what the site
  already fingerprinted.
- **`evaluate()` accepts a function**, not just a string. `evaluate(() => document.title)`
  is what everyone writes coming from puppeteer/playwright; it used to stringify to
  `"() => document.title"`, which evaluates to a *function object* that
  `returnByValue` cannot serialise, so CDP replied `Invalid parameters (-32602)` —
  an error indistinguishable from a protocol regression. String form is unchanged.

### Fixed
- **`goto()` no longer hangs on a same-document navigation.** A `#fragment` — or any
  history/`pushState` navigation — loads no new document, so `Page.loadEventFired`
  never fires and the waiter ran to the full timeout and threw. Measured on Chrome
  150: `goto("https://example.com/#x")` failed after **15,001 ms** while real
  navigations took ~300 ms; anchor links, docs deep-links and SPA routes are ordinary
  things to follow, so this was a guaranteed 30 s stall on a common path. Now races
  `Page.navigatedWithinDocument` against the load waiter — chosen over comparing URLs,
  which would need to normalise trailing slashes, relative hrefs and encoding and
  would still miss `pushState`. Verified non-vacuous: an unresolvable host still
  rejects in 80 ms, a real page still returns 200, a 404 still reports 404.

### Verified against Chrome 150
`examples/cdp150-smoke.ts` — run after any Chrome upgrade. Veil speaks raw CDP with
no framework in between, so a protocol change surfaces as a runtime failure in
whatever script runs next rather than as a build error. Checks the stealth properties
too (`navigator.webdriver` false, UA and UA-CH majors agreeing). 8/8 on 150.

### Also in this release (previously unreleased)

### Fixed
- `type()` now holds **Shift** for characters that require it — uppercase letters
  and shifted symbols (`!@#$%^&*()_+{}|:"<>?~`). Before, a capital or `@` was
  dispatched with `shiftKey:false`, a self-contradiction (that glyph is
  unreachable without Shift) that reads as a behavioural bot-tell and breaks
  shift-gated key handlers. `KeyboardEvent.shiftKey` / `getModifierState('Shift')`
  now agree with the character. The committed text is unchanged.

### Added
- `press()` gains `ArrowLeft`, `ArrowRight`, `Delete`, `Home`, `End`, `PageUp`,
  `PageDown` (previously only `ArrowUp`/`ArrowDown` existed — an asymmetric gap).
  Exposed through the MCP `veil_press` enum too.
- New CI unit suite `tests/key-dispatch.test.ts` drives a real `Page` against a
  mock CDP to lock the on-the-wire key events (shift modifier + navigation keys)
  without launching Chrome.

## 1.1.0 — 2026-07-23

Coherent fingerprint / profile control. Veil still ships your **real** Chrome
identity by default (the strongest identity there is); opt in with a
`Fingerprint` to present one internally consistent identity instead. The design
rule is coherence, not spoof-count.

### Added
- `Fingerprint` applied as one coherent set — timezone, locale, and geolocation
  derived together so nothing contradicts (`page.applyFingerprint` /
  `Browser.launch({ fingerprint })`).
- Seeded WebGL / canvas / audio noise — deterministic per profile, not per call
  (a per-call jitter is itself a signal).
- Preset profiles (`PRESETS`) and `Fingerprint.random(seed?)`.
- MCP: `veil_set_fingerprint` tool. (Runnable `veil-mcp` bin shipped in 1.0.1.)
- Consistency guard: derived values (client-hint platform, brand major,
  Accept-Language) are computed from the profile so they can't drift out of sync.

### Notes
- Everything CDP can set is set browser-level (UA + full client hints, platform,
  screen/DPR, timezone, locale, geolocation) — no JS getter to unmask. Only what
  CDP can't reach (`hardwareConcurrency`, `deviceMemory`, `languages`,
  `screen.avail*`, WebGL vendor/renderer, canvas/audio noise) is injected on the
  prototype and masked to `[native code]` by a single self-hiding
  `Function.prototype.toString` proxy.
- `screen.colorDepth` rides an injected getter — CDP can't set it.
- Deliberately not spoofed: `navigator.oscpu` (Firefox-only — a Chrome profile
  exposing it is itself an anomaly) and WebGL-canvas `toDataURL` read-back.
- 134 tests pass; the core stealth suite is unchanged from 1.0.x.

## 1.0.1 — 2026-07-22
- Runnable `veil-mcp` bin so `npx -y -p @achamm/veilbrowser veil-mcp` works as an
  MCP server.

## 1.0.0 — 2026-07-22
- 10 new page methods: `getCookies`, `waitForSelector`, `select`,
  `text`/`attribute`, element + clip screenshots, `blockResources`, `pdf`,
  `setViewport`/`setUserAgent`, history navigation, and `networkidle` waiting.
  Plus `evaluate`/`goto` timeouts and `{status, ok}` from `goto`.

## 0.4.0 — earlier
- Core raw-CDP stealth browser: zero-dependency, ships the real Chrome fingerprint.
