"""Raw Chrome DevTools Protocol client. No framework in between, by design."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Callable


class CDPError(RuntimeError):
    """A CDP command came back with an error, or the socket died mid-command."""


class CDP:
    """One WebSocket to the browser, multiplexing commands and flat sessions.

    Flat sessions (``Target.attachToTarget`` with ``flatten=True``) mean every
    page shares this single socket and is addressed by ``sessionId`` — the modern
    arrangement, and the reason there is no per-page connection to manage.
    """

    def __init__(self, ws: Any) -> None:
        self._ws = ws
        self._next_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        # (method, session_id) -> [callbacks]. session_id None means "any session".
        self._listeners: dict[tuple[str, str | None], list[Callable]] = {}
        self._reader: asyncio.Task | None = None
        self._closed = False

    @classmethod
    async def connect(cls, ws_url: str) -> "CDP":
        # Imported HERE, not at module scope, so the rest of the package works without
        # it. `veilbrowser.fingerprint` only builds strings — requiring a WebSocket
        # library to compute a stealth script made the TS/Python byte-parity test
        # depend on a pip install, and it failed CI for a reason unrelated to what it
        # tests. Anyone who actually opens a browser still needs the dependency, and
        # gets told so plainly rather than via a bare ModuleNotFoundError.
        try:
            import websockets
        except ImportError as e:  # pragma: no cover
            raise CDPError(
                "veilbrowser needs the `websockets` package to drive a browser: "
                "pip install websockets"
            ) from e
        # max_size=None is REQUIRED, not tuning: websockets defaults to a 1 MiB
        # frame cap, and a single Page.captureScreenshot of a normal viewport is
        # base64 well past that. With the default the connection dies on the
        # screenshot rather than returning an error, which reads like a browser
        # crash. ping_interval=None because Chrome does not answer WS pings and
        # the library would tear down a perfectly live connection after 20s idle.
        ws = await websockets.connect(ws_url, max_size=None, ping_interval=None)
        cdp = cls(ws)
        cdp._reader = asyncio.create_task(cdp._read_loop())
        return cdp

    async def _read_loop(self) -> None:
        try:
            async for raw in self._ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                mid = msg.get("id")
                if mid is not None:
                    fut = self._pending.pop(mid, None)
                    if fut and not fut.done():
                        if "error" in msg:
                            err = msg["error"]
                            fut.set_exception(
                                CDPError(f"{err.get('message')} ({err.get('code')})"
                                         + (f": {err['data']}" if err.get("data") else ""))
                            )
                        else:
                            fut.set_result(msg.get("result") or {})
                    continue
                method, sid = msg.get("method"), msg.get("sessionId")
                for key in ((method, sid), (method, None)):
                    for cb in list(self._listeners.get(key, ())):
                        try:
                            cb(msg.get("params") or {})
                        except Exception:
                            pass  # a listener must never kill the read loop
        except Exception:
            pass
        finally:
            self._closed = True
            # Fail everything still in flight. Without this, a command issued as
            # the browser exits hangs until its timeout instead of reporting the
            # real cause, and "the browser died" looks like "the site was slow".
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(CDPError("CDP connection closed"))
            self._pending.clear()

    async def send(
        self,
        method: str,
        params: dict | None = None,
        session_id: str | None = None,
        timeout: float = 30.0,
    ) -> dict:
        if self._closed:
            raise CDPError(f"CDP connection is closed (sending {method})")
        self._next_id += 1
        mid = self._next_id
        payload: dict[str, Any] = {"id": mid, "method": method, "params": params or {}}
        if session_id:
            payload["sessionId"] = session_id
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[mid] = fut
        await self._ws.send(json.dumps(payload))
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError as e:
            self._pending.pop(mid, None)
            raise CDPError(f"{method} timed out after {timeout}s") from e

    def on(self, method: str, cb: Callable, session_id: str | None = None) -> Callable[[], None]:
        """Subscribe to an event. Returns a function that unsubscribes."""
        key = (method, session_id)
        self._listeners.setdefault(key, []).append(cb)

        def off() -> None:
            try:
                self._listeners.get(key, []).remove(cb)
            except ValueError:
                pass

        return off

    async def wait_for(self, method: str, session_id: str | None = None, timeout: float = 30.0) -> dict:
        """Resolve on the next occurrence of an event."""
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        off = self.on(method, lambda p: fut.done() or fut.set_result(p), session_id)
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError as e:
            raise CDPError(f"timed out after {timeout}s waiting for {method}") from e
        finally:
            off()

    def close(self) -> None:
        self._closed = True
        if self._reader:
            self._reader.cancel()
        asyncio.create_task(self._ws.close())
