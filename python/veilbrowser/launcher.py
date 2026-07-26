"""Launch a REAL, unmodified Chrome.

To a website this process IS Chrome — same TLS, same JS engine, same canvas and
WebGL fingerprint — because it is the same binary a human runs. The stealth game
at launch time is entirely about NOT adding the switches Puppeteer and Playwright
add: ``--enable-automation`` and its batch of ``--disable-*`` flags change
behaviour in fingerprintable ways.

The flag list itself is generated from ``src/launcher.ts`` (see
``fingerprint.chrome_flags``), not restated here.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import signal
import subprocess
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from .fingerprint import chrome_flags

RENDER_NODE = "/dev/dri/renderD128"

_CANDIDATES = [
    os.environ.get("VEIL_CHROME"),
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
]


def find_chrome() -> str:
    for c in _CANDIDATES:
        if c and Path(c).exists():
            return c
    raise RuntimeError("No Chrome/Chromium found. Set VEIL_CHROME=/path/to/chrome")


@dataclass
class LaunchResult:
    ws_url: str
    process: subprocess.Popen
    user_data_dir: str
    #: True only for SwiftShader — the page layer then masks the vendor.
    mask_webgl: bool
    _ephemeral: bool = False

    def kill(self) -> None:
        # Kill the GROUP, not the pid: Chrome forks renderer/gpu/zygote children,
        # and killing only the parent orphans them holding the profile lock.
        try:
            os.killpg(os.getpgid(self.process.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            try:
                self.process.kill()
            except ProcessLookupError:
                pass
        if self._ephemeral:
            shutil.rmtree(self.user_data_dir, ignore_errors=True)


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by someone else


def _clear_profile_lock(user_data_dir: Path) -> None:
    """Refuse a live profile, clear a stale one.

    Chrome locks a user-data-dir. If a real Chrome holds it, launching a second
    one silently fails in a way that looks like a CDP problem, so this reports it
    plainly instead. If the lock is stale (the owner crashed) it is safe to clear —
    otherwise a crash would make a profile permanently unusable.
    """
    lock = user_data_dir / "SingletonLock"
    try:
        target = os.readlink(lock)  # "host-pid"
        pid = int(target.rsplit("-", 1)[-1])
        if _pid_alive(pid):
            raise RuntimeError(
                f'Profile "{user_data_dir}" is already in use by Chrome (pid {pid}). '
                f"Close it, launch with a different user_data_dir, or use "
                f"Browser.connect() to drive the running one."
            )
    except (OSError, ValueError):
        pass  # absent, not a symlink, or unparseable -> treat as stale
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        try:
            (user_data_dir / name).unlink()
        except OSError:
            pass


def _resolve_gpu(mode: str | None) -> str:
    if mode and mode != "auto":
        return mode
    return "hardware" if Path(RENDER_NODE).exists() else "software"


async def launch_chrome(
    *,
    headless: bool = False,
    user_data_dir: str | None = None,
    chrome_path: str | None = None,
    window_size: tuple[int, int] = (1280, 800),
    screen_size: tuple[int, int] = (1920, 1080),
    proxy: str | None = None,
    gpu: str | None = None,
    extra_args: list[str] | None = None,
    timeout: float = 15.0,
) -> LaunchResult:
    chrome = chrome_path or find_chrome()
    ephemeral = user_data_dir is None
    udd = Path(user_data_dir or tempfile.mkdtemp(prefix="veil-profile-"))
    udd.mkdir(parents=True, exist_ok=True)
    _clear_profile_lock(udd)

    # Stale port file: if Chrome crashed, the OLD port is still on disk and we
    # would read it and connect to a dead endpoint — a confusing failure that
    # looks like the new browser is broken.
    port_file = udd / "DevToolsActivePort"
    try:
        port_file.unlink()
    except OSError:
        pass

    # The window sits INSIDE the screen, positioned like a real user's. A display
    # sized exactly to the window (screen == window) is a classic headless tell.
    sw, sh = screen_size
    w, h = min(window_size[0], sw), min(window_size[1], sh)
    px, py = max(0, (sw - w) // 2), max(0, (sh - h) // 2)

    lead, tail = chrome_flags()
    args = [
        *lead,
        f"--user-data-dir={udd}",
        f"--window-size={w},{h}",
        f"--window-position={px},{py}",
        *tail,
    ]

    resolved = _resolve_gpu(gpu)
    mask_webgl = False
    if resolved == "hardware":
        args += ["--use-gl=angle", "--use-angle=gl-egl"]
    elif resolved == "software":
        args += ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        mask_webgl = True  # SwiftShader's vendor is a server tell — hide it.
    if proxy:
        args.append(f"--proxy-server={proxy}")
    if extra_args:
        args += extra_args

    # Headful is the default because it is far less detectable, but it needs a
    # display. Unlike the TypeScript front end this does NOT start its own Xvfb —
    # it degrades to headless rather than failing, and honours an existing DISPLAY.
    # Run under `DISPLAY=:98` (or xvfb-run) for full headful stealth.
    if headless or not os.environ.get("DISPLAY"):
        args.insert(0, "--headless=new")

    proc = subprocess.Popen(
        [chrome, *args],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        start_new_session=True,  # own process group, so kill() takes the whole tree
    )

    port = await _wait_for_port(port_file, proc, timeout)
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=10) as r:
        info = json.loads(r.read())
    return LaunchResult(info["webSocketDebuggerUrl"], proc, str(udd), mask_webgl, ephemeral)


async def _wait_for_port(port_file: Path, proc: subprocess.Popen, timeout: float) -> int:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if proc.poll() is not None:
            # Surface Chrome's own complaint. Without this the caller only learns
            # "no debug port", which is the symptom of every possible cause.
            err = (proc.stderr.read() or b"").decode("utf8", "replace")[-600:] if proc.stderr else ""
            raise RuntimeError(f"Chrome exited early (code {proc.returncode}).\n{err}")
        if port_file.exists():
            try:
                port = int(port_file.read_text().splitlines()[0].strip())
                if port > 0:
                    return port
            except (ValueError, IndexError, OSError):
                pass
        await asyncio.sleep(0.05)
    raise RuntimeError("Chrome never opened a debug port")
