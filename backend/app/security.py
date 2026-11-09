"""Keys, tokens, join codes, rate limiting."""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import re
import secrets
import time
from collections import deque
from collections.abc import Callable

_CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"
_CODE_SHAPE = re.compile(r"[A-Z0-9-]{1,16}")


def generate_code() -> str:
    letters = "".join(secrets.choice(_CODE_LETTERS) for _ in range(4))
    digits = "".join(secrets.choice("0123456789") for _ in range(2))
    return f"{letters}-{digits}"


def normalize_code(code: str) -> str:
    """Canonical form of a join code; anything that cannot be a code (NUL bytes, huge or
    non-ASCII strings) maps to ``""`` so that it never reaches the database."""
    code = code.strip().upper()
    return code if _CODE_SHAPE.fullmatch(code) else ""


def generate_secret() -> str:
    """>= 128 bit random URL-safe secret (we use 256 bit)."""
    return secrets.token_urlsafe(32)


def hash_secret(secret: str) -> str:

    return hashlib.sha256(secret.encode("utf-8", "surrogatepass")).hexdigest()


def verify_secret(secret: str | None, expected_hash: str) -> bool:
    if not secret:
        return False
    return hmac.compare_digest(hash_secret(secret), expected_hash)


def client_key(peer: str | None, forwarded: str | None, *, trusted: bool) -> str:
    """Rate-limit key of a client: its IP address, IPv6 reduced to the /64 prefix (one
    subscriber owns a whole /64, so per-address limits would be trivial to dodge).

    ``forwarded`` (X-Forwarded-For) is only honoured with ``trusted`` (i.e. behind our own
    reverse proxy, which overwrites it). Unparseable values fall back to the peer address,
    so junk headers cannot create unbounded numbers of distinct keys."""
    candidates: list[str] = []
    if trusted and forwarded:
        candidates.append(forwarded.split(",")[0].strip())
    candidates.append((peer or "unknown").strip())
    for candidate in candidates:
        try:
            ip = ipaddress.ip_address(candidate)
        except ValueError:
            continue
        if isinstance(ip, ipaddress.IPv6Address):
            if ip.ipv4_mapped is not None:
                return str(ip.ipv4_mapped)
            return str(ipaddress.ip_network(f"{ip}/64", strict=False))
        return str(ip)
    return candidates[-1][:64]


class SlidingWindowLimiter:
    """In-process sliding window counter, shared only within one worker."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock

        self._hits: dict[str, tuple[float, deque[float]]] = {}
        self._last_cleanup = float("-inf")

    def allow(self, key: str, limit: int, window_seconds: float) -> bool:
        now = self._clock()
        entry = self._hits.get(key)
        hits = entry[1] if entry is not None else deque()
        self._hits[key] = (window_seconds, hits)
        while hits and now - hits[0] > window_seconds:
            hits.popleft()
        if len(hits) >= limit:
            return False
        hits.append(now)
        if len(self._hits) > 10_000 and now - self._last_cleanup >= 1.0:
            self._last_cleanup = now
            for k in [k for k, (w, v) in self._hits.items() if not v or now - v[-1] > w]:
                self._hits.pop(k, None)
        return True
