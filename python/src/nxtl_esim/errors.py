"""Typed errors for the NXTL eSIM API."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


class NxtlError(Exception):
    """Base class for NXTL eSIM API failures.

    ``status_code`` 0 means the SDK rejected the call before sending it.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        code: str | None = None,
        error_type: str | None = None,
        request_id: str | None = None,
        doc_url: str | None = None,
        details: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        body: Any = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.error_type = error_type
        self.request_id = request_id
        self.doc_url = doc_url
        self.details = dict(details) if details is not None else None
        self.headers = dict(headers or {})
        self.body = body
        self.retry_after = retry_after


class NxtlAuthError(NxtlError):
    """HTTP 401, or a missing API key before the request is sent."""


class NxtlAccessDeniedError(NxtlAuthError):
    """HTTP 403. The key is valid and lacks the scope for the operation."""


class NxtlValidationError(NxtlError):
    """HTTP 400."""


class NxtlRateLimitError(NxtlError):
    """HTTP 429."""


class NxtlNotFoundError(NxtlError):
    """HTTP 404."""


class NxtlServerError(NxtlError):
    """HTTP 5xx, including 502 upstream_error."""


class NxtlConnectionError(NxtlServerError):
    """Network failure or a request that produced no HTTP response."""


class NxtlTimeoutError(NxtlConnectionError):
    """The SDK timeout elapsed, or a job poll exceeded its deadline."""


class NxtlInsufficientBalanceError(NxtlError):
    """HTTP 402. Pooled balance or prepaid budget cannot cover the call."""


class NxtlConflictError(NxtlError):
    """HTTP 409."""


class NxtlQuotaExceededError(NxtlConflictError):
    """HTTP 409 when the code is quota_exhausted."""


class NxtlWebhookError(NxtlError):
    """Webhook signature or envelope checks."""

    def __init__(self, message: str, **kwargs: Any) -> None:
        kwargs.setdefault("status_code", 0)
        super().__init__(message, **kwargs)


class NxtlJobFailedError(NxtlError):
    """A polled job reached a failed terminal status. ``body`` is the job payload."""

    def __init__(self, message: str, body: Any = None) -> None:
        super().__init__(message, status_code=0, body=body)


def parse_error_body(body: Any, fallback: str) -> dict[str, Any]:
    if isinstance(body, dict) and body.get("error") is True and isinstance(body.get("message"), str):
        return {
            "code": body.get("code") if isinstance(body.get("code"), str) else None,
            "error_type": body.get("type") if isinstance(body.get("type"), str) else None,
            "message": body["message"],
            "request_id": body.get("request_id") if isinstance(body.get("request_id"), str) else None,
            "doc_url": body.get("doc_url") if isinstance(body.get("doc_url"), str) else None,
            "details": body.get("details") if isinstance(body.get("details"), dict) else None,
        }
    # Human reference: some earlier operations return {"error": "code"}.
    if isinstance(body, dict) and isinstance(body.get("error"), str):
        return {"code": body["error"], "message": body["error"], "error_type": None, "request_id": None, "doc_url": None, "details": None}
    if isinstance(body, dict) and isinstance(body.get("message"), str):
        return {"code": None, "error_type": None, "message": body["message"], "request_id": None, "doc_url": None, "details": None}
    return {"code": None, "error_type": None, "message": fallback or "NXTL API request failed", "request_id": None, "doc_url": None, "details": None}


def create_api_error(status_code: int, body: Any, headers: Mapping[str, str], reason: str) -> NxtlError:
    parsed = parse_error_body(body, reason)
    lowered = {key.lower(): value for key, value in headers.items()}
    request_id = lowered.get("x-request-id") or parsed["request_id"]
    retry_after = _float_or_none(lowered.get("retry-after"))
    parts = [f"NXTL eSIM API {status_code}"]
    if parsed["code"]:
        parts.append(str(parsed["code"]))
    parts.append(str(parsed["message"]))
    if request_id:
        parts.append(f"(request {request_id})")
    message = ": ".join(parts)
    kwargs = {
        "status_code": status_code,
        "code": parsed["code"],
        "error_type": parsed["error_type"],
        "request_id": request_id,
        "doc_url": parsed["doc_url"],
        "details": parsed["details"],
        "headers": lowered,
        "body": body,
        "retry_after": retry_after,
    }
    code = str(parsed["code"] or "").lower()
    if status_code == 400:
        return NxtlValidationError(message, **kwargs)
    if status_code == 401:
        return NxtlAuthError(message, **kwargs)
    if status_code == 403:
        return NxtlAccessDeniedError(message, **kwargs)
    if status_code == 404:
        return NxtlNotFoundError(message, **kwargs)
    if status_code == 402:
        return NxtlInsufficientBalanceError(message, **kwargs)
    if status_code == 409:
        if code in {"quota_exhausted", "quota_exceeded"}:
            return NxtlQuotaExceededError(message, **kwargs)
        return NxtlConflictError(message, **kwargs)
    if status_code == 429:
        return NxtlRateLimitError(message, **kwargs)
    if status_code >= 500:
        return NxtlServerError(message, **kwargs)
    return NxtlError(message, **kwargs)


def _float_or_none(value: str | None) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except ValueError:
        return None
