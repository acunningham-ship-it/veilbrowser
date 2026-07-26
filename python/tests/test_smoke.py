"""Real-browser smoke test for the Python front end.

Byte-parity with the TypeScript stealth script (tests/python-parity.test.ts) proves
the two agree on what to INJECT. It does not prove the browser then behaves — a
script can be identical and still never be applied. So this drives an actual Chrome
and reads the values back out of the page.

    DISPLAY=:98 python3 tests/test_smoke.py
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from veilbrowser import Browser, Fingerprint  # noqa: E402
from veilbrowser.cdp import CDPError  # noqa: E402

PASS, FAIL = [], []


def check(name: str, ok: bool, detail: str = "") -> None:
    (PASS if ok else FAIL).append(name)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))


FORM = (
    "data:text/html,"
    "<html><body><h1 id=h>hi</h1>"
    "<input id=i value='old'>"
    "<button id=b onclick=\"document.getElementById('h').textContent='clicked'\">go</button>"
    "<div id=keys></div>"
    "<script>document.getElementById('i').addEventListener('keydown',"
    "e=>{document.getElementById('keys').textContent += e.keyCode + ',';});</script>"
    "</body></html>"
)


async def main() -> None:
    fp = Fingerprint.preset("windows-chrome")
    browser = await Browser.launch(fingerprint=fp)
    try:
        page = await browser.new_page()
        await page.goto(FORM)

        # --- the stealth properties a fingerprinter reads first ---------------
        check("navigator.webdriver is false", await page.evaluate("navigator.webdriver") is False)
        check(
            "userAgent matches the profile",
            await page.evaluate("navigator.userAgent") == fp.userAgent,
        )
        check(
            "navigator.platform matches (browser-level, no getter to unmask)",
            await page.evaluate("navigator.platform") == fp.platform,
        )
        check(
            "hardwareConcurrency / deviceMemory from the profile",
            await page.evaluate("[navigator.hardwareConcurrency, navigator.deviceMemory]")
            == [fp.hardwareConcurrency, fp.deviceMemory],
        )
        check(
            "navigator.languages is the clean array (no q-weights leaking in)",
            await page.evaluate("navigator.languages") == fp.languages,
        )
        check(
            "screen.avail* + colorDepth from the profile",
            await page.evaluate("[screen.availWidth, screen.availHeight, screen.colorDepth]")
            == [fp.screen.availWidth, fp.screen.availHeight, fp.screen.colorDepth],
        )
        check(
            "timezone resolves natively",
            await page.evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone") == fp.timezone,
        )
        webgl = await page.evaluate(
            "(() => { const c = document.createElement('canvas').getContext('webgl');"
            " if (!c) return null; const e = c.getExtension('WEBGL_debug_renderer_info');"
            " return e ? c.getParameter(e.UNMASKED_VENDOR_WEBGL) : null; })()"
        )
        check("WebGL vendor from the profile", webgl == fp.webglVendor, f"got {webgl!r}")

        # The masking is the point: an override readable as "() => value" instead of
        # "[native code]" is the exact signature veil exists to avoid.
        tostr = await page.evaluate(
            "Object.getOwnPropertyDescriptor(Navigator.prototype,'hardwareConcurrency').get.toString()"
        )
        check("patched getter reports [native code]", "[native code]" in (tostr or ""), tostr or "")
        check(
            "the toString proxy hides itself",
            "[native code]" in (await page.evaluate("Function.prototype.toString.toString()") or ""),
        )
        check(
            "overrides live on the PROTOTYPE, not as own-properties",
            await page.evaluate(
                "!Object.getOwnPropertyDescriptor(navigator,'hardwareConcurrency')"
                " && !Object.getOwnPropertyDescriptor(screen,'availWidth')"
            )
            is True,
        )

        # --- deterministic (not per-call random) noise -------------------------
        twice = await page.evaluate(
            "(() => { const f = () => { const c = document.createElement('canvas');"
            " c.width = 40; c.height = 20; const x = c.getContext('2d');"
            " x.fillStyle = '#f0a'; x.fillRect(0,0,40,20); x.fillText('veil',2,12);"
            " return c.toDataURL(); }; return [f(), f()]; })()"
        )
        check(
            "canvas noise is stable across reads (a per-call random IS the tell)",
            twice[0] == twice[1],
        )

        # --- real input --------------------------------------------------------
        await page.fill("#i", "Hello!")
        check("fill() replaces the old value", await page.evaluate("document.getElementById('i').value") == "Hello!")
        keys = await page.evaluate("document.getElementById('keys').textContent")
        check(
            "key events carry a real keyCode (0 breaks login forms and is a tell)",
            bool(keys) and "0," not in keys,
            f"keyCodes: {keys}",
        )
        await page.click("#b")
        check("click() dispatches a trusted click", await page.text("#h") == "clicked")

        # --- the same-document goto fix ----------------------------------------
        t0 = time.monotonic()
        await page.goto("https://example.com/")
        base = time.monotonic() - t0
        t0 = time.monotonic()
        await page.goto("https://example.com/#fragment")
        frag = time.monotonic() - t0
        check(
            "same-document goto returns fast (used to run the full 15s timeout)",
            frag < 5.0,
            f"fragment {frag * 1000:.0f}ms vs full load {base * 1000:.0f}ms",
        )

        # A guard against the fix becoming vacuous: an unresolvable host must still
        # fail, and fail quickly, rather than every goto now "succeeding".
        t0 = time.monotonic()
        try:
            await page.goto("http://no-such-host.invalid/", timeout=20)
            check("unresolvable host still rejects", False, "it resolved?!")
        except CDPError:
            check("unresolvable host still rejects fast", time.monotonic() - t0 < 15)

        r = await page.goto("https://example.com/status-404-does-not-exist")
        check("HTTP status is reported", r["status"] == 404 and r["ok"] is False, json.dumps(r))

        # --- output ------------------------------------------------------------
        shot = await page.screenshot()
        check(
            "screenshot returns real PNG bytes (>1MiB would die on a default ws cap)",
            shot[:4] == b"\x89PNG" and len(shot) > 1000,
            f"{len(shot)} bytes",
        )

        # --- attach to the browser we already have ----------------------------
        # Same mechanism that makes a signed-in profile drivable.
        ws = browser._launch.ws_url  # noqa: SLF001 — testing the documented entry point
        other = await Browser.connect(ws)
        pages = await other.pages()
        check("connect() + pages() sees the live tab", len(pages) >= 1, f"{len(pages)} page(s)")
        await other.close()
        check(
            "close() on an attached browser does NOT kill it",
            await page.evaluate("1+1") == 2,
        )
    finally:
        await browser.close()

    print(f"\n  {len(PASS)}/{len(PASS) + len(FAIL)} checks passed")
    if FAIL:
        print("  FAILED: " + ", ".join(FAIL))
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
