"""Exponential backoff with full jitter."""

from __future__ import annotations

import email.utils
import random
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Callable


@dataclass
class ResolvedRetry:
    max_retries: int = 2
    base_delay: float = 0.2
    max_delay: float = 8.0
    max_retry_after: float = 120.0
    retry_unsafe: bool = False
    sleep: Callable[[float], Any] | None = None
    random: Callable[[], float] = random.random


def resolve_retry(options: Any) -> ResolvedRetry | None:
    """``None`` uses defaults. ``False`` disables retries. A mapping overrides fields."""

    if options is False:
        return None
    if options is None:
        return ResolvedRetry()
    if isinstance(options, ResolvedRetry):
        return options
    if not isinstance(options, Mapping):
        raise TypeError("retry must be a mapping or False")
    resolved = ResolvedRetry()
    if "max_retries" in options:
        resolved.max_retries = int(options["max_retries"])
    if "base_delay" in options:
        resolved.base_delay = float(options["base_delay"])
    if "max_delay" in options:
        resolved.max_delay = float(options["max_delay"])
    if "max_retry_after" in options:
        resolved.max_retry_after = float(options["max_retry_after"])
    if "retry_unsafe" in options:
        resolved.retry_unsafe = bool(options["retry_unsafe"])
    if options.get("sleep") is not None:
        resolved.sleep = options["sleep"]
    if options.get("random") is not None:
        resolved.random = options["random"]
    return resolved


def is_replay_safe(method: str, idempotency_key: str | None, retry_unsafe: bool) -> bool:
    if retry_unsafe:
        return True
    if method.upper() in {"GET", "HEAD", "PUT", "DELETE", "OPTIONS"}:
        return True
    return bool(idempotency_key)


def compute_delay(retry: ResolvedRetry, attempt: int, retry_after: float | None) -> float:
    """Full jitter in ``[0, min(max_delay, base_delay * 2^attempt)]``.

    A Retry-After value is a minimum, capped by ``max_retry_after``. The
    exponential cap does not shrink a server hint below that ceiling.
    """

    expo = min(retry.max_delay, retry.base_delay * (2**attempt))
    jitter = retry.random() * max(expo, 0.0)
    if retry_after is None:
        return jitter
    hinted = min(max(0.0, retry_after), retry.max_retry_after)
    extra = retry.random() * min(0.25, retry.max_delay)
    return hinted + extra


def parse_retry_after(headers: Mapping[str, str], now: float | None = None) -> float | None:
    raw = _header(headers, "retry-after")
    if raw is None:
        return None
    try:
        return max(0.0, float(raw))
    except ValueError:
        parsed = email.utils.parsedate_to_datetime(raw)
        if parsed is None:
            return None
        current = time.time() if now is None else now
        return max(0.0, parsed.timestamp() - current)


def parse_rate_limit_reset_delay(headers: Mapping[str, str], now: float | None = None) -> float | None:
    """TODO(spec): ``X-RateLimit-Reset`` has no defined unit.

    Integers <= 86400 are treated as delta seconds.
    Integers >= 1_000_000_000 are treated as Unix seconds.
    """

    raw = _header(headers, "x-ratelimit-reset")
    if raw is None or not raw.strip().isdigit():
        return None
    value = int(raw.strip())
    if value <= 86_400:
        return float(value)
    if value >= 1_000_000_000:
        current = time.time() if now is None else now
        return max(0.0, value - current)
    return None


def _header(headers: Mapping[str, str], name: str) -> str | None:
    for key, value in headers.items():
        if key.lower() == name:
            return value
    return None
