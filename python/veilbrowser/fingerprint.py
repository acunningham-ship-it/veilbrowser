"""Coherent fingerprint profiles.

The identities, the screen sets and the injected stealth script are NOT written
here — they are generated from the TypeScript source into ``_assets/`` (see
``tools-gen-python-assets.ts``). This module is the Python-side plumbing that
loads them and derives the client hints, nothing more. That split is deliberate:
a hand-maintained second copy of a stealth patch drifts, and a drifted patch does
not fail loudly, it just makes one front end detectable while its tests stay green.
"""

from __future__ import annotations

import json
import random as _random
import re
import time
from dataclasses import dataclass, field, replace
from functools import lru_cache
from pathlib import Path
from typing import Any

_ASSETS = Path(__file__).parent / "_assets"


@lru_cache(maxsize=None)
def _asset(name: str) -> str:
    return (_ASSETS / name).read_text()


@lru_cache(maxsize=None)
def _data() -> dict:
    return json.loads(_asset("presets.json"))


@dataclass
class FingerprintScreen:
    width: int
    height: int
    availWidth: int
    availHeight: int
    colorDepth: int


@dataclass
class Fingerprint:
    """A complete, internally-consistent browser identity.

    Coherence is the whole point: a Windows user agent with a macOS WebGL renderer
    is more detectable than no spoofing at all, because the INCONSISTENCY is itself
    the signal. Use a preset or :meth:`random`; if you hand-build one, keep every
    field in agreement with the user agent.
    """

    userAgent: str
    platform: str
    platformVersion: str
    architecture: str
    model: str
    mobile: bool
    hardwareConcurrency: int
    deviceMemory: int
    languages: list[str]
    screen: FingerprintScreen
    devicePixelRatio: float
    webglVendor: str
    webglRenderer: str
    timezone: str
    locale: str
    seed: int
    bitness: str = "64"
    geolocation: dict | None = None
    brands: list[dict] | None = None
    uaFullVersionList: list[dict] | None = None
    oscpu: str | None = None

    @staticmethod
    def from_dict(d: dict) -> "Fingerprint":
        d = dict(d)
        d["screen"] = FingerprintScreen(**d["screen"])
        known = Fingerprint.__dataclass_fields__.keys()
        return Fingerprint(**{k: v for k, v in d.items() if k in known})

    @staticmethod
    def presets() -> dict[str, "Fingerprint"]:
        return {k: Fingerprint.from_dict(v) for k, v in _data()["presets"].items()}

    @staticmethod
    def preset(name: str) -> "Fingerprint":
        presets = _data()["presets"]
        if name not in presets:
            raise KeyError(f"unknown preset {name!r}; have {sorted(presets)}")
        return Fingerprint.from_dict(presets[name])

    @staticmethod
    def random(seed: int | None = None) -> "Fingerprint":
        """A self-consistent random desktop profile.

        Picks a coherent preset first, then varies only the fields that are
        independent of the user agent (screen from that OS's realistic set, core
        count, US timezone plus matching coordinates). The coherence-critical core
        — UA, client hints, platform, WebGL — comes straight from the preset, so a
        randomized profile passes the same consistency checks as a preset one.

        NOTE: deterministic for a given seed, but it does NOT produce the same
        profile as the TypeScript ``Fingerprint.random(seed)``. The two use
        different PRNGs, and matching them would mean porting the RNG for no gain
        — nothing needs the two languages to agree on a random identity, only on
        the stealth script, which IS byte-identical.
        """
        if seed is None:
            seed = (int(time.time() * 1000) ^ _random.getrandbits(32)) & 0xFFFFFFFF
        rng = _random.Random(seed or 1)
        data = _data()
        base = Fingerprint.preset(rng.choice(["windows-chrome", "mac-chrome", "linux-chrome"]))
        screens = data["screenSets"].get(client_hint_platform(base)) or [base.screen.__dict__]
        tz = rng.choice(data["usTimezones"])
        return replace(
            base,
            hardwareConcurrency=rng.choice([4, 8, 12, 16]),
            screen=FingerprintScreen(**rng.choice(screens)),
            timezone=tz,
            geolocation=data["tzCoords"].get(tz),
            seed=seed & 0xFFFFFFFF,
        )


# --- client-hint derivation (mirrors src/fingerprint.ts) ---------------------


def chrome_major(ua: str) -> str:
    m = re.search(r"Chrome/(\d+)", ua)
    return m.group(1) if m else "131"


def chrome_full_version(ua: str) -> str:
    m = re.search(r"Chrome/(\d+\.\d+\.\d+\.\d+)", ua)
    return m.group(1) if m else f"{chrome_major(ua)}.0.0.0"


def client_hint_platform(fp: Fingerprint) -> str:
    if re.search(r"Android", fp.userAgent, re.I):
        return "Android"
    p = fp.platform.lower()
    if p.startswith("win"):
        return "Windows"
    if p.startswith("mac"):
        return "macOS"
    if p.startswith("linux"):
        return "Linux"
    return "Unknown"


def build_client_hints(fp: Fingerprint) -> dict:
    major, full = chrome_major(fp.userAgent), chrome_full_version(fp.userAgent)
    return {
        "brands": fp.brands
        or [
            {"brand": "Chromium", "version": major},
            {"brand": "Google Chrome", "version": major},
            {"brand": "Not?A_Brand", "version": "99"},
        ],
        "fullVersionList": fp.uaFullVersionList
        or [
            {"brand": "Chromium", "version": full},
            {"brand": "Google Chrome", "version": full},
            {"brand": "Not?A_Brand", "version": "99.0.0.0"},
        ],
        "fullVersion": full,
        "platform": client_hint_platform(fp),
        "platformVersion": fp.platformVersion,
        "architecture": fp.architecture,
        "bitness": fp.bitness or "64",
        "model": fp.model,
        "mobile": fp.mobile,
        "wow64": False,
    }


def build_accept_language(languages: list[str]) -> str:
    """``["en-US","en"]`` -> ``"en-US,en;q=0.9"``.

    The q-weights belong in the header only. ``navigator.languages`` is set
    separately to the clean array, because a JS-visible "q=0.9" would be a tell.
    """
    return ",".join(
        lang if i == 0 else f"{lang};q={max(0.1, 1 - i * 0.1):.1f}" for i, lang in enumerate(languages)
    )


# --- the injected scripts (shared assets, not written here) ------------------


def fingerprint_stealth_payload(fp: Fingerprint) -> dict:
    """The nine values the injected body reads.

    KEY ORDER IS PART OF THE CONTRACT — the emitted script is compared byte-for-byte
    against the TypeScript output, and both languages preserve insertion order.
    Must stay in lockstep with ``fingerprintStealthPayload`` in src/fingerprint.ts.
    """
    return {
        "hardwareConcurrency": fp.hardwareConcurrency,
        "deviceMemory": fp.deviceMemory,
        "languages": fp.languages,
        "availWidth": fp.screen.availWidth,
        "availHeight": fp.screen.availHeight,
        "colorDepth": fp.screen.colorDepth,
        "webglVendor": fp.webglVendor,
        "webglRenderer": fp.webglRenderer,
        "seed": fp.seed & 0xFFFFFFFF,
    }


def _strip_banner(js: str) -> str:
    """Drop the generated-file banner comment, so the bytes match the TS exactly."""
    return js.split("*/\n", 1)[1] if js.startswith("/* GENERATED") else js


def build_fingerprint_stealth(fp: Fingerprint) -> str:
    """The page-level stealth script for a profile: shared body + this profile's values.

    ``separators`` and ``ensure_ascii=False`` are not style — they make this output
    byte-identical to ``JSON.stringify``, which is what the parity test asserts.
    """
    payload = json.dumps(
        fingerprint_stealth_payload(fp), separators=(",", ":"), ensure_ascii=False
    )
    return _strip_banner(_asset("fingerprint_stealth.js")).replace("__VEIL_FP__", payload, 1)


def build_stealth(mask_webgl: bool = False) -> str:
    """The base self-gating patch. Every override fires only if the value is wrong."""
    return _strip_banner(_asset("base_stealth_masked.js" if mask_webgl else "base_stealth.js"))


def chrome_flags() -> tuple[list[str], list[str]]:
    """(lead, tail) launch flags, generated from src/launcher.ts."""
    d = json.loads(_asset("chrome_flags.json"))
    return list(d["lead"]), list(d["tail"])
