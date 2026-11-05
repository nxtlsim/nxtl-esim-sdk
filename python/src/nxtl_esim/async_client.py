"""Asynchronous client for the NXTL eSIM B2B API."""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import AsyncIterator, Mapping
from typing import Any

import httpx

from .endpoints import AsyncEndpointMixin
from .errors import NxtlError
from .models import DEFAULT_BASE_URL, DEFAULT_USER_AGENT, ApiResponse, JsonObject
from .pagination import async_iterate_pages
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


class AsyncNxtlClient(AsyncEndpointMixin):
    """Async client. ``timeout`` is in seconds. Use ``async with`` to close an owned httpx client."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        http_client: httpx.AsyncClient | None = None,
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
        self._client = http_client or httpx.AsyncClient(timeout=timeout, follow_redirects=False)

    async def __aenter__(self) -> AsyncNxtlClient:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _request(
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
        return await self._send(prepared)

    async def request(
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

        return await self._request(
            method,
            path,
            query=query,
            json_body=json_body,
            options=options,
            auto_idempotency=auto_idempotency,
        )

    async def _send(self, prepared: Any) -> ApiResponse[JsonObject]:
        attempt = 0
        last_error: Exception | None = None
        while True:
            self._log("debug", "nxtl request", {"method": prepared.method, "path": prepared.url, "attempt": attempt})
            try:
                response = await self._client.request(
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
                await self._sleep(prepared.retry, delay)
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
                await self._sleep(prepared.retry, delay)
                attempt += 1
                last_error = error
        raise last_error or NxtlError("Request failed", status_code=0)

    async def iterate_esims(self, **query: Any) -> AsyncIterator[JsonObject]:
        per_page = int(query.pop("per_page", 50) or 50)
        max_pages = int(query.pop("max_pages", 100))
        options = query.pop("options", None)
        validate_page(None, per_page, 200)
        async for item in async_iterate_pages(
            lambda page: self.list_esims(page=page, per_page=per_page, options=options, **query),
            per_page=per_page,
            max_pages=max_pages,
        ):
            yield item

    async def iterate_audit(self, **query: Any) -> AsyncIterator[JsonObject]:
        per_page = int(query.pop("per_page", 50) or 50)
        max_pages = int(query.pop("max_pages", 100))
        options = query.pop("options", None)
        validate_page(None, per_page, 200)
        async for item in async_iterate_pages(
            lambda page: self.audit(page=page, per_page=per_page, options=options, **query),
            per_page=per_page,
            max_pages=max_pages,
        ):
            yield item

    async def iterate_lines(self, **query: Any) -> AsyncIterator[JsonObject]:
        per_page = int(query.pop("per_page", 50) or 50)
        max_pages = int(query.pop("max_pages", 100))
        options = query.pop("options", None)
        validate_page(None, per_page, 200)
        async for item in async_iterate_pages(
            lambda page: self.list_lines(page=page, per_page=per_page, options=options, **query),
            per_page=per_page,
            max_pages=max_pages,
        ):
            yield item

    async def iterate_balance_history(self, **query: Any) -> AsyncIterator[JsonObject]:
        per_page = int(query.pop("per_page", 50) or 50)
        max_pages = int(query.pop("max_pages", 100))
        options = query.pop("options", None)
        validate_page(None, per_page, None)
        async for item in async_iterate_pages(
            lambda page: self.list_balance_history(page=page, per_page=per_page, options=options, **query),
            per_page=per_page,
            max_pages=max_pages,
        ):
            yield item

    async def iterate_usage_cdrs(self, **query: Any) -> AsyncIterator[JsonObject]:
        per_page = int(query.pop("per_page", 100) or 100)
        max_pages = int(query.pop("max_pages", 100))
        options = query.pop("options", None)
        validate_page(None, per_page, 500)
        async for item in async_iterate_pages(
            lambda page: self.usage_cdrs(page=page, per_page=per_page, options=options, **query),
            per_page=per_page,
            max_pages=max_pages,
        ):
            yield item

    async def iterate_webhook_deliveries(self, **query: Any) -> AsyncIterator[JsonObject]:
        max_pages = int(query.pop("max_pages", 100))
        options = query.pop("options", None)
        async for item in async_iterate_pages(
            lambda page: self.list_webhook_deliveries(page=page, options=options, **query),
            max_pages=max_pages,
        ):
            yield item

    async def _sleep(self, retry: ResolvedRetry | None, delay: float) -> None:
        fn = retry.sleep if retry and retry.sleep else asyncio.sleep
        result = fn(delay)
        if inspect.isawaitable(result):
            await result

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
