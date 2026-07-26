"""One tab, driven over CDP.

Input goes through the **Input domain** — real mouse and key events at real
coordinates — not through JS. That is the difference that matters: an
``element.click()`` produces an event with ``isTrusted: false``, and a text-only
key event arrives with ``keyCode === 0``, both of which are trivially detectable
and break keydown-driven login forms. Every keystroke here carries the correct
``key``/``code``/``windowsVirtualKeyCode`` from the shared keymap.

Elements are addressed by CSS selector. (The TypeScript front end additionally has
a snapshot/ref system for agent use; that is a deliberate omission here, not an
oversight — selectors are what Python callers write.)
"""

from __future__ import annotations

import asyncio
import base64
import json
import random
import re
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .cdp import CDP, CDPError

_ASSETS = Path(__file__).parent / "_assets"


@lru_cache(maxsize=None)
def _keymap() -> dict[str, dict]:
    return json.loads((_ASSETS / "keymap.json").read_text())["keys"]


def _is_private_ipv4(host: str) -> bool:
    m = re.match(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$", host)
    if not m:
        return False
    a, b = int(m.group(1)), int(m.group(2))
    return (
        a == 127                      # loopback
        or a == 10                    # 10/8
        or a == 0                     # 0/8
        or (a == 100 and 64 <= b <= 127)  # CGNAT / Tailscale tailnet
        or (a == 192 and b == 168)
        or (a == 172 and 16 <= b <= 31)
        or (a == 169 and b == 254)    # link-local
    )


def _mapped_to_ipv4(tail: str) -> str:
    if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", tail):
        return tail
    parts = tail.split(":")
    if len(parts) != 2:
        return ""
    try:
        hi, lo = int(parts[0], 16), int(parts[1], 16)
    except ValueError:
        return ""
    return f"{(hi >> 8) & 0xFF}.{hi & 0xFF}.{(lo >> 8) & 0xFF}.{lo & 0xFF}"


def is_private_host(url: str) -> bool:
    """True for loopback / RFC1918 / CGNAT / link-local / IPv6-ULA hosts."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    if not host:
        return False
    host = host.strip("[]")
    if host == "localhost" or host.endswith(".localhost"):
        return True
    if host in ("::1", "0.0.0.0"):
        return True
    # IPv6 unique-local fc00::/7 — the v6 analog of RFC1918.
    if re.match(r"^f[cd][0-9a-f]{2}:", host):
        return True
    # IPv4-mapped IPv6 (::ffff:127.0.0.1) is the same host wearing a v6 hat, and a
    # public page could use it to reach loopback. Fold it back and re-apply v4 rules.
    if host.startswith("::ffff:"):
        return _is_private_ipv4(_mapped_to_ipv4(host[7:]))
    return _is_private_ipv4(host)


# Only these (private) requests are intercepted, so normal browsing keeps its exact
# timing rather than pausing every request. The globs over-capture slightly (172.1*);
# is_private_host() is the real gate in the handler. http/https only: CDP's Fetch
# domain does not intercept WebSocket handshakes, and real port-scanners use HTTP.
_PRIVATE_URL_PATTERNS = [
    {"urlPattern": f"{scheme}://{host}*"}
    for host in (
        "localhost", "127.", "0.0.0.0", "10.", "192.168.", "172.1", "172.2", "172.3",
        "169.254.", "100.6", "100.7", "100.8", "100.9", "100.1",
        "[::1]", "[fc", "[fd", "[::ffff:",
    )
    for scheme in ("http", "https")
]


def key_info(ch: str) -> dict:
    """Resolve one character to a well-formed keystroke.

    Anything outside printable ASCII degrades to a plain text commit, the way an
    IME delivers a composed character.
    """
    k = _keymap().get(ch)
    return k or {"key": ch, "code": "", "vk": 0, "text": ch, "shift": False}


class Page:
    def __init__(self, cdp: CDP, session_id: str, target_id: str) -> None:
        self._cdp = cdp
        self.session_id = session_id
        self.target_id = target_id
        self._mouse = (0.0, 0.0)
        self._rng = random.Random()
        self._block_private_on = False
        self._main_frame_id: str | None = None
        self._top_private = False

    async def _send(self, method: str, params: dict | None = None, timeout: float = 30.0) -> dict:
        return await self._cdp.send(method, params, self.session_id, timeout)

    # --- setup ---------------------------------------------------------------

    async def init(
        self,
        *,
        mask_webgl: bool = False,
        block_private_network: bool = True,
        fingerprint: Any | None = None,
    ) -> "Page":
        from .fingerprint import build_stealth

        await self._send("Page.enable")
        await self._send("Runtime.enable")
        await self._send("DOM.enable")
        # Base stealth first, so the fingerprint's masked getters win over any
        # self-gating backfill. When a fingerprint is active it owns the WebGL
        # vendor, so the SwiftShader mask is skipped — two getParameter overrides
        # stacking would be its own tell.
        await self._send(
            "Page.addScriptToEvaluateOnNewDocument",
            {"source": build_stealth(mask_webgl=mask_webgl and not fingerprint)},
        )
        if fingerprint is not None:
            await self.apply_fingerprint(fingerprint)
        if block_private_network:
            await self.block_private_network()
        return self

    async def apply_fingerprint(self, fp: Any) -> None:
        """Apply a profile: browser-level overrides first, injected getters last.

        The browser-level layer (``Emulation.*``) is the strong one — Chrome itself
        sets those values, so there is no JS getter for a page to unmask. Only the
        handful CDP cannot set are injected.
        """
        from .fingerprint import build_accept_language, build_client_hints, build_fingerprint_stealth

        await self._send(
            "Emulation.setUserAgentOverride",
            {
                "userAgent": fp.userAgent,
                "acceptLanguage": build_accept_language(fp.languages),
                "platform": fp.platform,  # also sets the legacy navigator.platform
                "userAgentMetadata": build_client_hints(fp),
            },
        )
        # width/height 0 => screen dims and DPR only, leaving the viewport
        # (window.innerWidth/Height) alone.
        await self._send(
            "Emulation.setDeviceMetricsOverride",
            {
                "width": 0,
                "height": 0,
                "deviceScaleFactor": fp.devicePixelRatio,
                "mobile": fp.mobile,
                "screenWidth": fp.screen.width,
                "screenHeight": fp.screen.height,
            },
        )
        await self._send("Emulation.setTimezoneOverride", {"timezoneId": fp.timezone})
        try:
            await self._send("Emulation.setLocaleOverride", {"locale": fp.locale})
        except CDPError:
            pass  # rejects if one is already mid-flight; non-fatal to the rest
        if fp.geolocation:
            await self._send(
                "Emulation.setGeolocationOverride",
                {
                    "latitude": fp.geolocation["latitude"],
                    "longitude": fp.geolocation["longitude"],
                    "accuracy": fp.geolocation.get("accuracy", 100),
                },
            )
        await self._send(
            "Page.addScriptToEvaluateOnNewDocument", {"source": build_fingerprint_stealth(fp)}
        )

    async def set_viewport(
        self, width: int, height: int, device_scale_factor: float = 1, mobile: bool = False
    ) -> None:
        await self._send(
            "Emulation.setDeviceMetricsOverride",
            {
                "width": width,
                "height": height,
                "deviceScaleFactor": device_scale_factor,
                "mobile": mobile,
            },
        )

    async def block_private_network(self) -> None:
        """Stop a visited page reaching loopback / LAN hosts.

        Detectors port-scan 127.0.0.1 from JS to fingerprint what else runs on the
        machine, and it leaks the LAN to every site. Blocked requests fail
        UNIFORMLY — the same instant error for an open port and a closed one — so a
        scan cannot tell them apart and comes back empty.

        Still allowed, and this is why it uses Fetch interception rather than a URL
        blocklist: the agent's OWN top-level navigation to a private host
        (``goto("http://localhost:3000")``), and a private page loading its own
        private resources. Only a PUBLIC page reaching a private host is blocked.
        Only private URLs are intercepted, so normal browsing keeps its exact timing.
        """
        if self._block_private_on:
            return
        self._block_private_on = True
        try:
            tree = await self._send("Page.getFrameTree")
            frame = (tree.get("frameTree") or {}).get("frame") or {}
            self._main_frame_id = frame.get("id")
            self._top_private = is_private_host(frame.get("url") or "")
        except CDPError:
            pass

        def on_nav(p: dict) -> None:
            f = p.get("frame") or {}
            if f and not f.get("parentId"):
                self._main_frame_id = f.get("id")
                self._top_private = is_private_host(f.get("url") or "")

        self._cdp.on("Page.frameNavigated", on_nav, self.session_id)
        self._cdp.on(
            "Fetch.requestPaused",
            lambda p: asyncio.ensure_future(self._on_fetch_paused(p)),
            self.session_id,
        )
        await self._send("Fetch.enable", {"patterns": _PRIVATE_URL_PATTERNS})

    async def _on_fetch_paused(self, p: dict) -> None:
        url = (p.get("request") or {}).get("url") or ""
        request_id = p.get("requestId")
        try:
            if self._block_private_on and is_private_host(url):
                is_main_nav = p.get("resourceType") == "Document" and p.get("frameId") == self._main_frame_id
                if not is_main_nav and not self._top_private:
                    await self._send(
                        "Fetch.failRequest", {"requestId": request_id, "errorReason": "AccessDenied"}
                    )
                    return
            await self._send("Fetch.continueRequest", {"requestId": request_id})
        except CDPError:
            pass  # request already gone (navigation raced us) — nothing to answer

    # --- navigation ----------------------------------------------------------

    async def goto(self, url: str, *, timeout: float = 30.0, wait_until: str = "load") -> dict:
        """Navigate and wait. Returns ``{"url", "status", "ok"}``.

        Races Chrome's same-document signal against the load waiter. A ``#fragment``
        (or any history/pushState navigation) loads no new document, so
        ``Page.loadEventFired`` NEVER fires — waiting only for it stalls for the whole
        timeout and then throws. Measured on Chrome 150: 15,001 ms for a fragment vs
        ~300 ms for a real navigation. Anchor links and SPA routes are ordinary things
        to follow, so this was a guaranteed stall on a common path.
        """
        await self._send("Network.enable")
        doc_status: dict[str, int] = {}

        def on_response(p: dict) -> None:
            if p.get("type") == "Document" and p.get("loaderId"):
                doc_status[p["loaderId"]] = (p.get("response") or {}).get("status")

        off_resp = self._cdp.on("Network.responseReceived", on_response, self.session_id)
        loop = asyncio.get_running_loop()
        within: asyncio.Future = loop.create_future()
        off_within = self._cdp.on(
            "Page.navigatedWithinDocument",
            lambda p: within.done() or within.set_result("within"),
            self.session_id,
        )
        try:
            waiter = asyncio.ensure_future(self._wait_for_load(wait_until, timeout))
            result = await self._send("Page.navigate", {"url": url}, timeout=timeout)
            if result.get("errorText"):
                # A DNS/connection failure must reject fast, not wait out the load
                # timeout — otherwise a typo'd host looks like a slow site.
                raise CDPError(f"navigation to {url} failed: {result['errorText']}")
            loader_id = result.get("loaderId")
            done, pending = await asyncio.wait(
                {waiter, within}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED
            )
            for t in pending:
                t.cancel()
            if not done:
                raise CDPError(f"navigation to {url} timed out after {timeout}s")
            for t in done:
                if t is waiter and t.exception():
                    raise t.exception()  # type: ignore[misc]
            status = doc_status.get(loader_id) if loader_id else None
            return {
                "url": await self.url(),
                "status": status,
                "ok": status is None or 200 <= status < 400,
            }
        finally:
            off_resp()
            off_within()
            if not within.done():
                within.cancel()

    async def _wait_for_load(self, wait_until: str, timeout: float) -> str:
        if wait_until == "networkidle":
            return await self._wait_network_idle(timeout)
        await self._cdp.wait_for("Page.loadEventFired", self.session_id, timeout)
        return "load"

    async def _wait_network_idle(self, timeout: float, idle_ms: float = 500) -> str:
        """No network activity for ~500ms — better than `load` for SPAs that fetch after it."""
        loop = asyncio.get_running_loop()
        inflight = 0
        done: asyncio.Future = loop.create_future()
        handle: asyncio.TimerHandle | None = None

        def arm() -> None:
            nonlocal handle
            if handle:
                handle.cancel()
            if inflight == 0:
                handle = loop.call_later(
                    idle_ms / 1000, lambda: done.done() or done.set_result("networkidle")
                )

        def sent(_p: dict) -> None:
            nonlocal inflight
            inflight += 1
            if handle:
                handle.cancel()

        def finished(_p: dict) -> None:
            nonlocal inflight
            inflight = max(0, inflight - 1)
            arm()

        offs = [
            self._cdp.on("Network.requestWillBeSent", sent, self.session_id),
            self._cdp.on("Network.loadingFinished", finished, self.session_id),
            self._cdp.on("Network.loadingFailed", finished, self.session_id),
        ]
        arm()
        try:
            return await asyncio.wait_for(done, timeout)
        except asyncio.TimeoutError as e:
            raise CDPError(f"networkidle not reached in {timeout}s") from e
        finally:
            if handle:
                handle.cancel()
            for off in offs:
                off()

    async def reload(self, *, timeout: float = 30.0, wait_until: str = "load") -> None:
        waiter = asyncio.ensure_future(self._wait_for_load(wait_until, timeout))
        await self._send("Page.reload")
        await waiter

    async def url(self) -> str:
        r = await self._send(
            "Runtime.evaluate", {"expression": "location.href", "returnByValue": True}
        )
        return (r.get("result") or {}).get("value") or ""

    async def title(self) -> str:
        return await self.evaluate("document.title")

    async def content(self) -> str:
        return await self.evaluate("document.documentElement.outerHTML")

    async def inner_text(self) -> str:
        return await self.evaluate("document.body ? document.body.innerText : ''")

    # --- evaluation ----------------------------------------------------------

    async def evaluate(self, expression: str, *, timeout: float = 30.0) -> Any:
        """Evaluate a JS expression and return it by value.

        Takes a STRING. Python has no way to serialise a callable to JS, so unlike
        the TypeScript ``evaluate()`` there is no function form. An arrow function
        passed as a string (``"() => document.title"``) evaluates to a function
        OBJECT, which cannot be returned by value — wrap it: ``"(() => …)()"``.
        """
        r = await self._send(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
            timeout=timeout,
        )
        if r.get("exceptionDetails"):
            d = r["exceptionDetails"]
            msg = (d.get("exception") or {}).get("description") or d.get("text") or "evaluate failed"
            raise CDPError(msg)
        return (r.get("result") or {}).get("value")

    # --- element resolution --------------------------------------------------

    async def _node_id(self, selector: str) -> int:
        doc = await self._send("DOM.getDocument", {"depth": 0})
        r = await self._send(
            "DOM.querySelector", {"nodeId": doc["root"]["nodeId"], "selector": selector}
        )
        node_id = r.get("nodeId") or 0
        if not node_id:
            raise CDPError(f"no element matches {selector!r}")
        return node_id

    async def _center(self, selector: str, action: str) -> tuple[float, float]:
        """The element's LIVE centre, re-read at action time.

        Never reuse a coordinate read earlier: any re-render between the read and
        the action — a banner appearing, lazy images landing, a list growing — moves
        the element, and a real mouse event at the stale point clicks whatever slid
        into those coordinates and throws nothing. That is the worst shape a failure
        can take, because it looks like it worked.
        """
        node_id = await self._node_id(selector)
        await self._send("DOM.scrollIntoViewIfNeeded", {"nodeId": node_id})
        try:
            model = (await self._send("DOM.getBoxModel", {"nodeId": node_id}))["model"]
        except CDPError as e:
            raise CDPError(
                f"{action}: {selector!r} has no layout box (display:none, or removed)"
            ) from e
        if (model.get("width") or 0) <= 0 or (model.get("height") or 0) <= 0:
            raise CDPError(f"{action}: {selector!r} has a zero-size box — refusing to click empty space")
        q = model["content"]
        return (q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4

    # --- input ---------------------------------------------------------------

    async def _move_to(self, x: float, y: float, buttons: int = 0) -> None:
        """Move along a few interpolated steps rather than teleporting.

        A cursor that jumps from (0,0) to a button with no intermediate mousemove is
        a behavioural tell, and some UIs only reveal a control on hover.
        """
        x0, y0 = self._mouse
        steps = max(3, min(12, int(abs(x - x0) + abs(y - y0)) // 40))
        for i in range(1, steps + 1):
            t = i / steps
            ease = t * t * (3 - 2 * t)  # smoothstep: accelerate, then settle
            await self._send(
                "Input.dispatchMouseEvent",
                {
                    "type": "mouseMoved",
                    "x": x0 + (x - x0) * ease,
                    "y": y0 + (y - y0) * ease,
                    "buttons": buttons,
                },
            )
            await asyncio.sleep(self._rng.uniform(0.008, 0.022))
        self._mouse = (x, y)

    async def click_at(self, x: float, y: float) -> None:
        await self._move_to(x, y)
        await asyncio.sleep(self._rng.uniform(0.03, 0.09))
        for kind in ("mousePressed", "mouseReleased"):
            await self._send(
                "Input.dispatchMouseEvent",
                {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1, "buttons": 1 if kind == "mousePressed" else 0},
            )
            if kind == "mousePressed":
                await asyncio.sleep(self._rng.uniform(0.04, 0.11))  # human press duration

    async def click(self, selector: str) -> None:
        x, y = await self._center(selector, "click")
        await self.click_at(x, y)

    async def _send_key(
        self, key: str, code: str, vk: int, text: str | None = None, modifiers: int = 0
    ) -> None:
        base = {
            "key": key,
            "code": code,
            "windowsVirtualKeyCode": vk,
            "nativeVirtualKeyCode": vk,
        }
        if modifiers:
            base["modifiers"] = modifiers
        await self._send(
            "Input.dispatchKeyEvent", {"type": "rawKeyDown", **base, **({"text": text} if text else {})}
        )
        if text:
            await self._send("Input.dispatchKeyEvent", {"type": "char", **base, "text": text})
        await self._send("Input.dispatchKeyEvent", {"type": "keyUp", **base})

    async def type(self, text: str) -> None:
        """Type into the focused element with human cadence."""
        for ch in text:
            k = key_info(ch)
            await self._send_key(k["key"], k["code"], k["vk"], k["text"], 8 if k["shift"] else 0)
            # Longer after a space or punctuation, like a real typist.
            await asyncio.sleep(self._rng.uniform(0.11, 0.24) if ch in " .,!?" else self._rng.uniform(0.04, 0.13))

    async def fill(self, selector: str, text: str) -> None:
        """Click the field, clear it, then type.

        Clearing is not optional: without it, filling a pre-populated input yields
        "oldnewvalue". Ctrl+A then Delete, through the same Input domain as
        everything else — assigning ``.value`` would skip the events a framework
        listens for.
        """
        await self.click(selector)
        await self._send_key("a", "KeyA", 65, modifiers=2)  # Ctrl+A
        await self._send_key("Delete", "Delete", 46)
        await self.type(text)

    async def press(self, key: str) -> None:
        """Press a named key or a modifier chord, e.g. "Enter", "Tab", "Control+a"."""
        # CDP's modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
        mods = {"alt": 1, "control": 2, "ctrl": 2, "meta": 4, "cmd": 4, "shift": 8}
        parts = key.split("+")
        name = parts[-1]
        modifiers = 0
        for p in parts[:-1]:
            modifiers |= mods.get(p.lower(), 0)
        named = {
            "Enter": ("Enter", 13), "Tab": ("Tab", 9), "Escape": ("Escape", 27),
            "Backspace": ("Backspace", 8), "Delete": ("Delete", 46), "Space": ("Space", 32),
            "ArrowUp": ("ArrowUp", 38), "ArrowDown": ("ArrowDown", 40),
            "ArrowLeft": ("ArrowLeft", 37), "ArrowRight": ("ArrowRight", 39),
            "Home": ("Home", 36), "End": ("End", 35),
            "PageUp": ("PageUp", 33), "PageDown": ("PageDown", 34),
        }
        if name in named:
            code, vk = named[name]
            # Enter must commit "\r" or forms that read event.key see the key but
            # inputs never receive the character.
            await self._send_key(name, code, vk, "\r" if name == "Enter" else None, modifiers)
        else:
            k = key_info(name)
            # A chord like Control+a must NOT commit text — Ctrl+A is "select all",
            # not the letter "a".
            await self._send_key(
                k["key"], k["code"], k["vk"], None if modifiers else k["text"],
                modifiers or (8 if k["shift"] else 0),
            )

    async def scroll(self, dx: float, dy: float) -> None:
        x, y = self._mouse
        await self._send(
            "Input.dispatchMouseEvent",
            {"type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy},
        )
        await asyncio.sleep(self._rng.uniform(0.08, 0.2))

    # --- reading -------------------------------------------------------------

    async def text(self, selector: str) -> str:
        return await self.evaluate(
            f"(() => {{ const e = document.querySelector({json.dumps(selector)});"
            f" return e ? (e.innerText || e.textContent || '') : null; }})()"
        )

    async def attribute(self, selector: str, name: str) -> str | None:
        return await self.evaluate(
            f"(() => {{ const e = document.querySelector({json.dumps(selector)});"
            f" return e ? e.getAttribute({json.dumps(name)}) : null; }})()"
        )

    async def select(self, selector: str, value: str) -> None:
        """Set a <select>'s value and fire `change`, which frameworks listen for."""
        await self.evaluate(
            f"(() => {{ const e = document.querySelector({json.dumps(selector)});"
            f" if (!e) throw new Error('no element'); e.value = {json.dumps(value)};"
            f" e.dispatchEvent(new Event('input', {{bubbles:true}}));"
            f" e.dispatchEvent(new Event('change', {{bubbles:true}})); }})()"
        )

    # --- waiting -------------------------------------------------------------

    async def wait_for_selector(
        self, selector: str, *, timeout: float = 30.0, visible: bool = True, poll: float = 0.1
    ) -> None:
        """Poll until the selector matches (and, by default, is actually visible).

        `visible` matters: a matched-but-hidden element is the usual cause of a
        click that lands on nothing, so the default waits for a layout box.
        """
        expr = (
            f"(() => {{ const e = document.querySelector({json.dumps(selector)}); if (!e) return false;"
            + (" const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0;" if visible else " return true;")
            + " })()"
        )
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            try:
                if await self.evaluate(expr):
                    return
            except CDPError:
                pass  # mid-navigation the context is gone; keep polling
            await asyncio.sleep(poll)
        raise CDPError(
            f"{selector!r} not {'visible' if visible else 'present'} after {timeout}s"
        )

    async def wait_for(self, expression: str, *, timeout: float = 30.0, poll: float = 0.1) -> Any:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            try:
                v = await self.evaluate(expression)
                if v:
                    return v
            except CDPError:
                pass
            await asyncio.sleep(poll)
        raise CDPError(f"condition never became truthy in {timeout}s: {expression}")

    async def wait_for_response(self, url_substring: str, *, timeout: float = 30.0) -> dict:
        """Resolve on the first response whose URL contains `url_substring`."""
        await self._send("Network.enable")
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()

        def on_resp(p: dict) -> None:
            r = p.get("response") or {}
            if url_substring in (r.get("url") or "") and not fut.done():
                fut.set_result({"url": r.get("url"), "status": r.get("status"), "requestId": p.get("requestId")})

        off = self._cdp.on("Network.responseReceived", on_resp, self.session_id)
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError as e:
            raise CDPError(f"no response matching {url_substring!r} in {timeout}s") from e
        finally:
            off()

    # --- cookies -------------------------------------------------------------

    async def get_cookies(self, urls: list[str] | None = None) -> list[dict]:
        r = await self._send("Network.getCookies", {"urls": urls} if urls else {})
        return r.get("cookies") or []

    async def set_cookies(self, cookies: list[dict]) -> None:
        await self._send("Network.setCookies", {"cookies": cookies})

    # --- output --------------------------------------------------------------

    async def screenshot(
        self,
        path: str | None = None,
        *,
        full_page: bool = False,
        fmt: str = "png",
        quality: int | None = None,
    ) -> bytes:
        params: dict[str, Any] = {"format": fmt, "captureBeyondViewport": full_page}
        if quality is not None and fmt == "jpeg":
            params["quality"] = quality
        r = await self._send("Page.captureScreenshot", params, timeout=60.0)
        data = base64.b64decode(r["data"])
        if path:
            Path(path).write_bytes(data)
        return data

    async def pdf(self, path: str | None = None, *, landscape: bool = False, print_background: bool = True) -> bytes:
        r = await self._send(
            "Page.printToPDF",
            {"landscape": landscape, "printBackground": print_background, "transferMode": "ReturnAsBase64"},
            timeout=60.0,
        )
        data = base64.b64decode(r["data"])
        if path:
            Path(path).write_bytes(data)
        return data

    async def close(self) -> None:
        try:
            await self._cdp.send("Target.closeTarget", {"targetId": self.target_id})
        except CDPError:
            pass
