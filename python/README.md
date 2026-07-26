# veilbrowser (Python)

A stealth browser that **is** Chrome — the same binary a human runs, driven over raw
CDP with no framework in between. Python front end for
[veil](https://github.com/acunningham-ship-it/veilbrowser).

```bash
pip install git+https://github.com/acunningham-ship-it/veilbrowser.git#subdirectory=python
```

```python
import asyncio
from veilbrowser import Browser, Fingerprint

async def main():
    async with await Browser.launch(fingerprint=Fingerprint.preset("windows-chrome")) as b:
        page = await b.new_page()
        await page.goto("https://example.com")
        print(await page.title())
        await page.screenshot("shot.png")

asyncio.run(main())
```

## Drive a profile you are already signed into

Chrome locks a `user-data-dir`, so the one profile carrying your real sessions
**cannot be opened by a second instance**. Attach to the running browser instead of
launching a new one:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=~/.config/my-profile
```

```python
b = await Browser.connect("127.0.0.1:9222")   # ws:// URL, http:// origin, or host:port
page = (await b.pages())[0]                    # the tab that is already open
await b.close()                                # detaches — never kills a browser it didn't start
```

This is the difference between "works on sites that allow anonymous access" and
"works on the sites that matter": Google, Reddit, Meta and TikTok score the
**session**, not the IP, so an established profile passes where a fresh one hits a
wall.

## API

```python
b = await Browser.launch(headless=False, user_data_dir=None, proxy=None,
                         fingerprint=None, window_size=(1280, 800),
                         screen_size=(1920, 1080), gpu=None)
b = await Browser.connect(endpoint)
await b.new_page() / b.pages() / b.close()

await page.goto(url, timeout=30, wait_until="load")   # or "networkidle"
await page.evaluate("document.title")                  # a STRING, see below
await page.click(sel) / fill(sel, text) / type(text) / press("Control+a") / select(sel, v)
await page.wait_for_selector(sel, visible=True) / wait_for(expr) / wait_for_response(sub)
await page.text(sel) / attribute(sel, name) / title() / content() / inner_text() / url()
await page.screenshot(path=None, full_page=False) / pdf(path=None)
await page.get_cookies() / set_cookies([...]) / scroll(dx, dy) / set_viewport(w, h)
await page.block_private_network()

Fingerprint.preset("windows-chrome" | "mac-chrome" | "linux-chrome" | "android-chrome")
Fingerprint.random(seed=None)
```

`evaluate()` takes a **string**, not a callable — Python cannot serialise a function
to JS. An arrow function passed as a string evaluates to a function *object*, which
cannot be returned by value, so wrap it: `"(() => document.title)()"`.

## What it actually does

- **Real input.** Mouse and keys go through the CDP Input domain at real
  coordinates, with correct `key`/`code`/`windowsVirtualKeyCode`. A JS
  `element.click()` produces `isTrusted: false`, and a text-only key event arrives
  with `keyCode === 0` — both trivially detectable, and the second breaks
  keydown-driven login forms.
- **Coherent fingerprints.** Browser-level `Emulation.*` overrides first (Chrome
  sets those itself, so there is no JS getter for a page to unmask); only the handful
  CDP cannot set are injected, on the **prototype**, with `toString()` masked to
  `[native code]`. A half-spoofed identity is worse than none, because the
  inconsistency is itself the signal.
- **Deterministic canvas/audio noise.** Stable per seed, not per call — a per-call
  random would be its own tell.
- **Private-network guard** (on by default). Pages cannot port-scan `127.0.0.1` or
  your LAN; your own top-level navigation to a private host still works.
- **Element coordinates are re-read at action time**, so a re-render between lookup
  and click cannot make it click whatever slid into those coordinates.

## Relationship to the TypeScript package

The stealth layer is **not reimplemented here.** The injected script, the launch
flags, the profile identities and the keystroke table are generated from the
TypeScript source into `veilbrowser/_assets/`, and
`tests/python-parity.test.ts` fails the build if Python's assembled script differs
from the TypeScript one **by a single byte**.

That is deliberate. Two hand-maintained copies of a stealth patch drift, and a
drifted patch does not fail loudly — one front end simply becomes detectable while
all of its own tests stay green.

Deliberately **not** ported: the snapshot/ref system (selectors are what Python
callers write), auto-Xvfb (set `DISPLAY` or use `xvfb-run`; it degrades to headless
rather than failing), downloads, FedCM and frame switching. `Fingerprint.random(seed)`
is deterministic per seed but does not produce the same identity as the TypeScript
`random(seed)` — the two use different PRNGs, and nothing needs them to agree on a
random profile, only on the stealth script.

## Tests

```bash
DISPLAY=:98 python3 tests/test_smoke.py   # 21 checks against a real Chrome
bun test tests/python-parity.test.ts      # byte-parity with the TypeScript, from the repo root
```

## Licence

MIT
