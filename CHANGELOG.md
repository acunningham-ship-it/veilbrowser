# Changelog

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
