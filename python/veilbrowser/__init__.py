"""veilbrowser — a stealth browser that IS Chrome, driven over raw CDP.

    import asyncio
    from veilbrowser import Browser, Fingerprint

    async def main():
        async with await Browser.launch(fingerprint=Fingerprint.preset("windows-chrome")) as b:
            page = await b.new_page()
            await page.goto("https://example.com")
            print(await page.title())

    asyncio.run(main())

To drive a profile you are already signed into, attach instead of launching —
Chrome locks a user-data-dir, so a second instance cannot open it:

    b = await Browser.connect("127.0.0.1:9222")
    page = (await b.pages())[0]

The stealth layer (injected script, launch flags, profile identities, keymap) is
GENERATED from the TypeScript implementation into ``_assets/`` and shared, not
reimplemented here — so the two front ends cannot drift apart. See
``tools-gen-python-assets.ts`` and ``tests/python-parity.test.ts`` in the repo root.
"""

from .browser import Browser
from .cdp import CDP, CDPError
from .fingerprint import Fingerprint, FingerprintScreen
from .launcher import find_chrome, launch_chrome
from .page import Page

__version__ = "1.3.1"
__all__ = [
    "Browser",
    "Page",
    "Fingerprint",
    "FingerprintScreen",
    "CDP",
    "CDPError",
    "find_chrome",
    "launch_chrome",
    "__version__",
]
