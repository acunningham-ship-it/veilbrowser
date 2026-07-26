"""Browser: launch Chrome, or attach to one that is already running."""

from __future__ import annotations

import json
import urllib.request
from typing import Any

from .cdp import CDP
from .launcher import LaunchResult, launch_chrome
from .page import Page


class Browser:
    def __init__(
        self,
        cdp: CDP,
        launch: LaunchResult | None,
        block_private_network: bool = True,
        fingerprint: Any | None = None,
        attached: bool = False,
    ) -> None:
        self._cdp = cdp
        self._launch = launch
        self._block_private = block_private_network
        self._fingerprint = fingerprint
        #: True when we attached to an existing browser rather than starting it.
        #: Gates close(), because killing a process we did not start would destroy
        #: someone else's session as a side effect of cleanup.
        self._attached = attached

    @classmethod
    async def launch(
        cls,
        *,
        headless: bool = False,
        user_data_dir: str | None = None,
        chrome_path: str | None = None,
        window_size: tuple[int, int] = (1280, 800),
        screen_size: tuple[int, int] = (1920, 1080),
        proxy: str | None = None,
        gpu: str | None = None,
        extra_args: list[str] | None = None,
        block_private_network: bool = True,
        fingerprint: Any | None = None,
    ) -> "Browser":
        launch = await launch_chrome(
            headless=headless,
            user_data_dir=user_data_dir,
            chrome_path=chrome_path,
            window_size=window_size,
            screen_size=screen_size,
            proxy=proxy,
            gpu=gpu,
            extra_args=extra_args,
        )
        cdp = await CDP.connect(launch.ws_url)
        return cls(cdp, launch, block_private_network, fingerprint)

    @classmethod
    async def connect(
        cls,
        endpoint: str,
        *,
        block_private_network: bool = True,
        fingerprint: Any | None = None,
    ) -> "Browser":
        """Attach to an ALREADY-RUNNING Chrome instead of launching one.

        Why this matters more than it sounds: Chrome locks a ``user-data-dir``, so the
        one profile carrying your real logged-in sessions cannot be opened by a second
        instance. Without this, driving that profile means killing the browser holding
        it or copying the whole profile and losing the session. Attaching reuses the
        sessions as they are — which is the difference between "works on sites that
        allow anonymous access" and "works on the sites that matter", because Google,
        Reddit, Meta and TikTok score the SESSION, not the IP.

        Accepts a ``ws://`` DevTools URL, an ``http://`` origin, or a bare ``host:port``.
        """
        ws_url = endpoint
        if not endpoint.startswith(("ws://", "wss://")):
            origin = endpoint if endpoint.startswith(("http://", "https://")) else f"http://{endpoint}"
            url = f"{origin.rstrip('/')}/json/version"
            try:
                with urllib.request.urlopen(url, timeout=10) as r:
                    info = json.loads(r.read())
            except Exception as e:
                raise RuntimeError(
                    f"Browser.connect: could not read {url}. Is Chrome running with "
                    f"--remote-debugging-port, and is the port right?"
                ) from e
            ws_url = info.get("webSocketDebuggerUrl")
            if not ws_url:
                raise RuntimeError(f"Browser.connect: {origin} gave no webSocketDebuggerUrl")
        cdp = await CDP.connect(ws_url)
        return cls(cdp, None, block_private_network, fingerprint, attached=True)

    async def pages(self) -> list[Page]:
        """The tabs that already exist, as attached Pages.

        The companion to :meth:`connect`: after attaching you rarely want a blank
        tab, you want the page the human already has open and signed in. Skips
        ``devtools://`` and extension targets, which are never what a caller means.

        A fingerprint is deliberately NOT applied to an existing page — changing
        navigator properties under a document the site has already fingerprinted is
        worse than not changing them.
        """
        infos = (await self._cdp.send("Target.getTargets")).get("targetInfos") or []
        out: list[Page] = []
        for t in infos:
            url = t.get("url") or ""
            if t.get("type") != "page" or url.startswith(("devtools://", "chrome-extension://", "chrome://")):
                continue
            r = await self._cdp.send("Target.attachToTarget", {"targetId": t["targetId"], "flatten": True})
            out.append(Page(self._cdp, r["sessionId"], t["targetId"]))
        return out

    async def new_page(self) -> Page:
        t = await self._cdp.send("Target.createTarget", {"url": "about:blank"})
        r = await self._cdp.send("Target.attachToTarget", {"targetId": t["targetId"], "flatten": True})
        page = Page(self._cdp, r["sessionId"], t["targetId"])
        await page.init(
            mask_webgl=bool(self._launch and self._launch.mask_webgl),
            block_private_network=self._block_private,
            fingerprint=self._fingerprint,
        )
        return page

    async def close(self) -> None:
        # On an attached browser, detach only — the whole reason to attach is that
        # the session is valuable.
        if self._attached:
            self._cdp.close()
            return
        try:
            await self._cdp.send("Browser.close", timeout=5.0)
        except Exception:
            pass
        self._cdp.close()
        if self._launch:
            self._launch.kill()

    async def __aenter__(self) -> "Browser":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()
