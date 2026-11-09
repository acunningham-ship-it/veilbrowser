# Veil security model

Veil drives a real Chrome. When you **attach** to a browser you are already signed into
(`Browser.connect()`, or `VEIL_CDP_URL` for the MCP server), that browser's profile becomes
part of the agent's trust boundary. This page says what is and is not enforced, and where the
evidence lives. A control is listed as `enforced` only if a test in this repo exercises it;
`tests/docs-security.test.ts` checks that every `enforced` row names a token that exists in
`src/` and a test file that exists.

## Assets

| Asset | Why it matters |
|---|---|
| Cookie jar of the attached profile | Every signed-in session (mail, bank, admin panels). All-or-nothing: there is no per-site sandbox inside a profile. |
| Local files | `veil_upload` reads arbitrary absolute paths; downloads write to a directory the caller picks. |
| Open tabs | An attached browser may hold tabs the agent was never meant to touch. |

## Threats

- **Page-content injection.** A page tells the agent to navigate somewhere or act. Veil does not
  interpret page text, but the model reading it might.
- **Popup / new tab.** A page opens a window that is not subject to the navigation policy of the tab you configured.
- **Exfiltration from an allowed origin.** Script on an allowed page can `fetch()` or load an `<img>` against any origin; the allowlist does not see it.
- **`veil_eval`.** Runs arbitrary JavaScript in the page as the signed-in user.
- **Upload of arbitrary paths.** `veil_upload` / `veil_upload_via_picker` attach any absolute path the caller names to a page.
- **Downloads directory.** `veil_enable_downloads` writes files from the web into a caller-chosen directory.
- **Cookie read.** `veil_get_cookies` returns cookie values, including session tokens.

## Controls

Status values: `enforced` (a test exercises it), `pending` (implemented in an open PR that is
not on this branch; the row flips to `enforced` when it merges), `NOT enforced`.
The "Env var / API" column is the token the drift test looks for in `src/`.

| Control | Status | Env var / API | Test file | Notes |
|---|---|---|---|---|
| Document-navigation origin allowlist (library) | enforced | allowOrigins | origin-allowlist.test.ts | `Browser.connect(..., { allowOrigins })`, `page.restrictOrigins()`. Top-level and sub-frame document navigations only. |
| Private-host classifier (which hosts count as LAN/localhost) | enforced | isPrivateHost | private-host.test.ts | The decision function behind `blockPrivateNetwork`. |
| Private-network block in a live browser (public page cannot reach LAN/localhost) | NOT enforced | - | - | On by default (`blockPrivateNetwork`), but no test drives a public page at a private host, so it is not claimed as enforced. Raw WebSocket to a private host is not interceptable. |
| Detach-only close on attached browsers | NOT enforced | - | - | Implemented (`close()` detaches an attached browser) but no test covers it, so it is not claimed as enforced. |
| MCP server applies the origin allowlist (`VEIL_ALLOW_ORIGINS`) | enforced | VEIL_ALLOW_ORIGINS | mcp-core.test.ts | Applies to launched tabs and to the tabs that exist when the server attaches (#33). |
| Refuse to attach without an allowlist (`VEIL_ATTACH_STRICT`) | enforced | VEIL_ATTACH_STRICT | mcp-core.test.ts | (#33) |
| Cookie values redacted from `veil_get_cookies` (`VEIL_ALLOW_COOKIE_VALUES`) | enforced | VEIL_ALLOW_COOKIE_VALUES | mcp-core.test.ts | Values are withheld unless the env var is set (#33). |
| Subresource / fetch / image / beacon gating | NOT enforced | - | - | By design: gating subresources breaks real sites. |
| Popup / new-tab navigation policy | NOT enforced | - | - | The allowlist is applied to the page it was set on; a window opened by that page is not guaranteed to inherit it. |
| `veil_eval` restriction | NOT enforced | - | - | Arbitrary page JS. |
| Upload path restriction | NOT enforced | - | - | Any absolute path the caller names can be attached. |
| Downloads directory restriction | NOT enforced | - | - | The caller chooses `dir`. |

## Environment variables

These are the MCP server's attach-safety switches (all `enforced` above since #33).

- `VEIL_ALLOW_ORIGINS` - comma-separated hosts the MCP server may navigate to (subdomains included, dot boundary).
- `VEIL_ATTACH_STRICT` - when set, attaching via `VEIL_CDP_URL` without `VEIL_ALLOW_ORIGINS` is refused instead of falling back to unrestricted.
- `VEIL_ALLOW_COOKIE_VALUES` - when set, `veil_get_cookies` may return cookie values; otherwise values are withheld.

Already in use today: `VEIL_CDP_URL` (attach), `VEIL_USER_DATA_DIR`, `VEIL_HEADLESS`, `VEIL_CHROME`.

## Non-goals

- **Same-origin actions on an allowed site are full user power.** Allowlisting `github.com` grants the agent your GitHub.
- **The allowlist gates document navigation only**, not `fetch`, images, beacons or popups (confirmed by an analyst probe).
- Veil is not a sandbox for hostile code and does not protect a profile from the agent you point at it.

## Recommended setup

Attach to a **dedicated profile** (its own `--user-data-dir`) signed into only what the task needs, bind the debugging port to `127.0.0.1`, and set an allowlist for every run. Never attach an agent to your everyday browser.
