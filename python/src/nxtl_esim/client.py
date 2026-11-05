"""Synchronous client for the NXTL eSIM B2B API."""

from __future__ import annotations

import time
from collections.abc import Iterator, Mapping
from typing import Any

import httpx

from .endpoints import EndpointMixin
from .errors import NxtlError
from .models import (
    DEFAULT_BASE_URL,
    DEFAULT_USER_AGENT,
    ApiResponse,
    JsonObject,
)
from .pagination import iterate_pages
from .retry import ResolvedRetry, resolve_retry
from .transport import (
    _UNSET,
    interpret_response,
    map_transport_error,
    prepare_call,
    retry_delay,
    safe_meta,
)
from .validate import validate_page


class NxtlClient(EndpointMixin):
    """Sync client. ``timeout`` is in seconds. Authenticate with ``X-NXTL-Key``."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        http_client: httpx.Client | None = None,
        user_agent: str | None = None,
        logger: Any = None,
        retry: Any = None,
        headers: Mapping[str, str] | None = None,
        idempotency_header: str = "Idempotency-Key",
        auto_idempotency_key: bool = True,
        accept_currency: str | None = None,
    ) -> None:
        if idempotency_header not in {"Idempotency-Key", "X-NXTL-Idempotency-Key"}:
            raise ValueError("idempotency_header must be Idempotency-Key or X-NXTL-Idempotency-Key")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.user_agent = user_agent or DEFAULT_USER_AGENT
        self.logger = logger
        self.retry = resolve_retry(retry)
        self.headers = dict(headers or {})
        self.idempotency_header = idempotency_header
        self.auto_idempotency_key = auto_idempotency_key
        self.accept_currency = accept_currency
        self._owns_client = http_client is None
        self._client = http_client or httpx.Client(timeout=timeout, follow_redirects=False)

    def __enter__(self) -> NxtlClient:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def _request(
        self,
        method: str,
        path: str,
        *,
        query: Mapping[str, Any] | None = None,
        json_body: Any = _UNSET,
        options: Mapping[str, Any] | None = None,
        auto_idempotency: bool = False,
        **_ignored: Any,
    ) -> ApiResponse[JsonObject]:
        prepared = prepare_call(
            api_key=self.api_key,
            base_url=self.base_url,
            timeout=self.timeout,
            user_agent=self.user_agent,
            default_headers=self.headers,
            idempotency_header=self.idempotency_header,
            auto_idempotency_key=self.auto_idempotency_key,
            accept_currency=self.accept_currency,
            default_retry=self.retry,
            method=method,
            path=path,
            query=query,
            json_body=json_body,
            options=options,
            auto_idempotency=auto_idempotency,
        )
        return self._send(prepared)

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Mapping[str, Any] | None = None,
        json_body: Any = _UNSET,
        options: Mapping[str, Any] | None = None,
        auto_idempotency: bool = False,
    ) -> ApiResponse[Any]:
        """Low-level call. ``path`` is relative to the base URL and starts with ``/``."""

        return self._request(
            method,
            path,
            query=query,
            json_body=json_body,
            options=options,
            auto_idempotency=auto_idempotency,
        )

    def _send(self, prepared: Any) -> ApiResponse[JsonObject]:
        attempt = 0
        last_error: Exception | None = None
        while True:
            self._log("debug", "nxtl request", {"method": prepared.method, "path": prepared.url, "attempt": attempt})
            try:
                response = self._client.request(
                    prepared.method,
                    prepared.url,
                    headers=prepared.headers,
                    content=prepared.content,
                    timeout=prepared.timeout,
                )
            except httpx.HTTPError as exc:
                mapped = map_transport_error(exc, prepared.timeout, False)
                delay = retry_delay(503, prepared.method, prepared.idempotency_key, prepared.retry, attempt, {})
                if delay is None:
                    raise mapped from exc
                self._log("warn", "nxtl retry", {"method": prepared.method, "attempt": attempt, "delay": delay})
                self._sleep(prepared.retry, delay)
                attempt += 1
                last_error = mapped
                continue
            try:
                return interpret_response(
                    response.status_code,
                    response.headers,
                    response.content,
                    response.reason_phrase,
                    prepared.idempotency_key,
                )
            except NxtlError as error:
                delay = retry_delay(
                    error.status_code,
                    prepared.method,
                    prepared.idempotency_key,
                    prepared.retry,
                    attempt,
                    error.headers,
                )
                if delay is None:
                    raise
                self._log(
                    "warn",
                    "nxtl retry",
                    {
                        "method": prepared.method,
                        "status": error.status_code,
                        "attempt": attempt,
                        "delay": delay,
                        "request_id": error.request_id,
                    },
                )
                self._sleep(prepared.retry, delay)
                attempt += 1
                last_error = error
        raise last_error or NxtlError("Request failed", status_code=0)

    def iterate_audit(self, **query: Any) -> Iterator[JsonObject]:
        per_page = int(query.pop("per_page", 50) or 50)
        max_pages = int(query.pop("max_pages", 100))
        options = query.pop("options", None)
        validate_page(None, per_page, 200)
        return iterate_pages(
            lambda page: self.audit(page=page, per_page=per_page, options=options, **query),
            per_page=per_page,
            max_pages=max_pages,
        )

    def iterate_esims(self, **query: Any) -> Iterator[JsonObject]:
        per_page = int(query.pop("per_page", 50) or 50)
        max_pages = int(query.pop("max_pages", 100))
        options = query.pop("options", None)
        validate_page(None, per_page, 200)
        return iterate_pages(
            lambda page: self.list_esims(page=page, per_page=per_page, options=options, **query),
            per_page=per_page,
            max_pages=max_pages,
        )

    def iterate_lines(self, **query: Any) -> Iterator[JsonObject]:
        per_page = int(query.pop("per_page", 50) or 50)
        max_pages = int(query.pop("max_pages", 100))
        options = query.pop("options", None)
        validate_page(None, per_page, 200)
        return iterate_pages(
            lambda page: self.list_lines(page=page, per_page=per_page, options=options, **query),
            per_page=per_page,
            max_pages=max_pages,
        )

    def iterate_balance_history(self, **query: Any) -> Iterator[JsonObject]:
        per_page = int(query.pop("per_page", 50) or 50)
        max_pages = int(query.pop("max_pages", 100))
        options = query.pop("options", None)
        validate_page(None, per_page, None)
        return iterate_pages(
            lambda page: self.list_balance_history(page=page, per_page=per_page, options=options, **query),
            per_page=per_page,
            max_pages=max_pages,
        )

    def iterate_usage_cdrs(self, **query: Any) -> Iterator[JsonObject]:
        if query.get("after_id") is not None:
            raise TypeError("after_id uses iterate_accounting_cdrs, not page iteration")
        per_page = int(query.pop("per_page", 100) or 100)
        max_pages = int(query.pop("max_pages", 100))
        options = query.pop("options", None)
        validate_page(None, per_page, 500)
        return iterate_pages(
            lambda page: self.usage_cdrs(page=page, per_page=per_page, options=options, **query),
            per_page=per_page,
            max_pages=max_pages,
        )

    def iterate_accounting_cdrs(self, **query: Any) -> Iterator[JsonObject]:
        """after_id cursor with accounting=1. page is always 1. pages/total are ignored."""
        after = int(query.pop("after_id", 0) or 0)
        per_page = int(query.pop("per_page", 100) or 100)
        options = query.pop("options", None)
        query.pop("max_pages", None)
        seen: set[int] = set()
        while True:
            payload = self.usage_cdrs(after_id=after, accounting=1, page=1, per_page=per_page, options=options, **query).data
            rows = payload.get("cdrs") if isinstance(payload, dict) else None
            if not rows:
                return
            last = rows[-1].get("id") if isinstance(rows[-1], dict) else None
            if not isinstance(last, int) or last <= after:
                return
            yield from rows
            nxt = payload.get("next_cursor") if isinstance(payload, dict) else None
            if not isinstance(nxt, int) or nxt <= after or nxt in seen:
                return
            seen.add(nxt)
            after = nxt

    def iterate_webhook_deliveries(self, **query: Any) -> Iterator[JsonObject]:
        max_pages = int(query.pop("max_pages", 100))
        options = query.pop("options", None)
        return iterate_pages(
            lambda page: self.list_webhook_deliveries(page=page, options=options, **query),
            max_pages=max_pages,
        )

    def _sleep(self, retry: ResolvedRetry | None, delay: float) -> None:
        fn = retry.sleep if retry and retry.sleep else time.sleep
        fn(delay)

    def _log(self, level: str, message: str, meta: Mapping[str, Any]) -> None:
        if self.logger is None:
            return
        fn = getattr(self.logger, level, None)
        if fn is None:
            return
        try:
            fn(message, safe_meta(meta))
        except Exception:
            return
