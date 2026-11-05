"""Shared request preparation for the sync and async clients."""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from .errors import (
    NxtlAuthError,
    NxtlConnectionError,
    NxtlError,
    NxtlTimeoutError,
    create_api_error,
)
from .models import (
    API_SPEC_VERSION,
    DEFAULT_BASE_URL,
    DEFAULT_USER_AGENT,
    ApiResponse,
    JsonObject,
    RateLimitInfo,
)
from .retry import (
    ResolvedRetry,
    compute_delay,
    is_replay_safe,
    parse_rate_limit_reset_delay,
    parse_retry_after,
)
from .validate import validate_idempotency_key

AUTO_IDEMPOTENT = {"POST /esims", "POST /esims/bulk-issue", "POST /topup"}
_UNSET = object()


class PreparedCall:
    def __init__(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        content: bytes | None,
        timeout: float,
        idempotency_key: str | None,
        retry: ResolvedRetry | None,
    ) -> None:
        self.method = method
        self.url = url
        self.headers = headers
        self.content = content
        self.timeout = timeout
        self.idempotency_key = idempotency_key
        self.retry = retry


def prepare_call(
    *,
    api_key: str | None,
    base_url: str,
    timeout: float,
    user_agent: str,
    default_headers: Mapping[str, str],
    idempotency_header: str,
    auto_idempotency_key: bool,
    accept_currency: str | None,
    default_retry: ResolvedRetry | None,
    method: str,
    path: str,
    query: Mapping[str, Any] | None = None,
    json_body: Any = _UNSET,
    options: Mapping[str, Any] | None = None,
    auto_idempotency: bool = False,
) -> PreparedCall:
    if not path.startswith("/"):
        raise ValueError("path must start with /")
    if path != "/health" and not api_key:
        raise NxtlAuthError(
            "api_key is required. Create a key from an NXTL Business account.",
            status_code=0,
            code="missing_api_key",
        )
    call = dict(options or {})
    retry = default_retry
    if "retry" in call:
        from .retry import resolve_retry

        retry = resolve_retry(call.get("retry"))
    idempotency_key = _resolve_idempotency_key(
        method, path, call.get("idempotency_key"), auto_idempotency, auto_idempotency_key
    )
    headers = {
        "Accept": "application/json",
        "User-Agent": user_agent or DEFAULT_USER_AGENT,
        "X-NXTL-SDK": f"nxtl-esim/{API_SPEC_VERSION}",
    }
    headers.update(default_headers)
    extra = call.get("headers") or {}
    headers.update(dict(extra))
    if api_key:
        headers["X-NXTL-Key"] = api_key
    if accept_currency and "Accept-Currency" not in headers:
        headers["Accept-Currency"] = accept_currency
    content: bytes | None = None
    if json_body is not _UNSET:
        headers["Content-Type"] = "application/json"
        content = json.dumps(json_body).encode("utf-8")
    if idempotency_key:
        headers[idempotency_header] = idempotency_key
    url = _join(base_url or DEFAULT_BASE_URL, path, query)
    call_timeout = float(call["timeout"]) if call.get("timeout") is not None else timeout
    return PreparedCall(method, url, headers, content, call_timeout, idempotency_key, retry)


def interpret_response(
    status_code: int,
    headers: Mapping[str, str],
    content: bytes,
    reason: str,
    idempotency_key: str | None,
) -> ApiResponse[Any]:
    lowered = {key.lower(): value for key, value in headers.items()}
    body = _parse_body(content)
    if 200 <= status_code < 300:
        return _success(body, status_code, lowered, idempotency_key)
    raise create_api_error(status_code, body, lowered, reason or "request failed")


def retry_delay(
    status_code: int,
    method: str,
    idempotency_key: str | None,
    retry: ResolvedRetry | None,
    attempt: int,
    headers: Mapping[str, str],
) -> float | None:
    if retry is None or attempt >= retry.max_retries:
        return None
    rate_limited = status_code == 429
    server = 500 <= status_code <= 599
    if not rate_limited and not server:
        return None
    if server and not is_replay_safe(method, idempotency_key, retry.retry_unsafe):
        return None
    hinted = parse_retry_after(headers)
    if hinted is None and rate_limited:
        hinted = parse_rate_limit_reset_delay(headers)
    return compute_delay(retry, attempt, hinted)


def map_transport_error(exc: Exception, timeout: float, aborted: bool) -> NxtlError:
    if aborted:
        return NxtlTimeoutError("Request aborted", status_code=0, code="aborted")
    if isinstance(exc, httpx.TimeoutException):
        return NxtlTimeoutError(f"Request timed out after {timeout}s", status_code=0, code="timeout")
    return NxtlConnectionError(str(exc) or "Network request failed", status_code=0, code="connection_error")


def safe_meta(meta: Mapping[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in meta.items():
        if any(part in key.lower() for part in ("key", "secret", "authorization", "token")):
            out[key] = "[redacted]"
        else:
            out[key] = value
    return out


def _resolve_idempotency_key(
    method: str,
    path: str,
    supplied: str | None,
    auto_flag: bool,
    enabled: bool,
) -> str | None:
    if supplied is not None:
        return validate_idempotency_key(supplied)
    auto = auto_flag or f"{method.upper()} {path}" in AUTO_IDEMPOTENT
    if auto and enabled:
        return str(uuid.uuid4())
    return None


def _join(base_url: str, path: str, query: Mapping[str, Any] | None) -> str:
    base = base_url.rstrip("/")
    parts = urlsplit(base + path)
    params = []
    for key, value in (query or {}).items():
        if value is None:
            continue
        params.append(f"{key}={_query_escape(value)}")
    query_string = "&".join(params)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query_string, ""))


def _query_escape(value: Any) -> str:
    from urllib.parse import quote

    return quote(str(value), safe="")


def _parse_body(content: bytes) -> Any:
    if not content:
        return {}
    text = content.decode("utf-8")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"message": text}


def _success(data: Any, status_code: int, headers: Mapping[str, str], idempotency_key: str | None) -> ApiResponse[Any]:
    rate = RateLimitInfo(
        limit=_int_header(headers.get("x-ratelimit-limit")),
        remaining=_int_header(headers.get("x-ratelimit-remaining")),
        reset=headers.get("x-ratelimit-reset"),
        retry_after=_float_header(headers.get("retry-after")),
    )
    return ApiResponse(
        data=data,
        status_code=status_code,
        headers=dict(headers),
        request_id=headers.get("x-request-id"),
        idempotent_replayed=(headers.get("idempotent-replayed") or "").lower() == "true",
        rate_limit=rate,
        idempotency_key=idempotency_key,
    )


def _int_header(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _float_header(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def read_object(value: Any) -> JsonObject:
    if isinstance(value, dict):
        return value
    return {}

