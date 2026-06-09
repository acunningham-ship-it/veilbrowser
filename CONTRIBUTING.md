# Contributing to Veil

Thanks for your interest. Veil is a small, dependency-free codebase — easy to read end to end.

## Setup

```bash
bun install
bun run examples/selftest.ts   # launches real Chrome, runs the full chain
```

Requires Chrome/Chromium on PATH (or `VEIL_CHROME=/path/to/chrome`) and Bun.

## Before opening a PR

```bash
bun run typecheck     # tsc, must be clean
bun test              # unit tests, must pass
bun run examples/selftest.ts   # end-to-end smoke
```

If your change touches stealth, **prove it with the detectors** and paste the before/after:

```bash
bun run examples/detect.ts        # sannysoft + CreepJS
bun run examples/hardtargets.ts   # Cloudflare + antibot challenges
```

## Principles (please respect these)

1. **Zero runtime dependencies.** The core ships with an empty `dependencies`. If you think
   you need a package, you almost certainly don't — we have a global `WebSocket`, `fetch`,
   and `child_process`.
2. **Never call `Runtime.enable`** (or `Console.enable`). They're primary CDP detection
   vectors. `Runtime.evaluate` works without them.
3. **Stealth must match the environment.** Don't spoof a value you can serve authentically.
   A masked-but-inconsistent fingerprint is worse than an honest one (see the WebGL lesson
   in the README). Every patch should be self-gating: fire only when the value is genuinely
   anomalous.
4. **Smaller surface beats more patches.** The stealth layer's own footprint is detectable.
   When in doubt, remove a patch and re-test.

## Scope

Bug fixes, new detectors in `examples/`, agent-tooling ergonomics, and stealth hardening
(with evidence) are all welcome. For larger features (proxy pools, isolated-world eval,
network interception) open an issue first so we can align on the approach.
