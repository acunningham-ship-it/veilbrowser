# Changelog

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
