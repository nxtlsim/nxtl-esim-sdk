"""Public JSON files under https://nxtlsim.com/ai/.

These files are not operations of the B2B REST API. The API reference lists a
destination catalogue as outside that surface. Issuance fees charged to the
pooled balance come from POST /esims/estimate, not from these files.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from .errors import NxtlConnectionError, NxtlError
from .models import DEFAULT_ORIGIN, DEFAULT_USER_AGENT, JsonObject
from .pricing import PriceQuote, quote_price
from .retry import compute_delay, resolve_retry


class PublicCatalog:
    def __init__(
        self,
        *,
        origin: str = DEFAULT_ORIGIN,
        timeout: float = 30.0,
        user_agent: str | None = None,
        http_client: httpx.Client | None = None,
        retry: Any = None,
    ) -> None:
        self.origin = origin.rstrip("/")
        self.timeout = timeout
        self.user_agent = user_agent or DEFAULT_USER_AGENT
        self.retry = resolve_retry(retry)
        self._owns = http_client is None
        self._client = http_client or httpx.Client(timeout=timeout, follow_redirects=False)

    def __enter__(self) -> PublicCatalog:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        if self._owns:
            self._client.close()

    def pricing(self) -> JsonObject:
        return self._get("/ai/pricing.json")

    def coverage(self) -> JsonObject:
        return self._get("/ai/coverage.json")

    def destinations(self) -> JsonObject:
        return self._get("/ai/destinations.json")

    def product(self) -> JsonObject:
        return self._get("/ai/nxtl-product.json")

    def load_all(self) -> dict[str, JsonObject]:
        return {
            "pricing": self.pricing(),
            "coverage": self.coverage(),
            "destinations": self.destinations(),
            "product": self.product(),
        }

    def find_pricing_country(self, feed: JsonObject, iso2: str) -> JsonObject | None:
        code = iso2.upper()
        for row in feed.get("countries") or []:
            if isinstance(row, dict) and str(row.get("iso2", "")).upper() == code:
                return row
        return None

    def find_coverage(self, feed: JsonObject, iso2: str) -> JsonObject | None:
        code = iso2.upper()
        for row in feed.get("coverage") or []:
            if isinstance(row, dict) and str(row.get("iso2", "")).upper() == code:
                return row
        return None

    def find_destination(self, feed: JsonObject, iso2_or_slug: str) -> JsonObject | None:
        needle = iso2_or_slug.lower()
        for row in feed.get("destinations") or []:
            if not isinstance(row, dict):
                continue
            if str(row.get("iso2", "")).lower() == needle or str(row.get("slug", "")).lower() == needle:
                return row
        return None

    def quote_country_rate(
        self,
        feed: JsonObject,
        iso2: str,
        markup: dict[str, Any],
        *,
        locale: str = "en_US",
    ) -> PriceQuote:
        row = self.find_pricing_country(feed, iso2)
        if row is None:
            raise NxtlError(f"No public pricing row for {iso2.upper()}", status_code=0, code="catalog_miss")
        config = {
            "currency": markup.get("currency") or row.get("currency") or feed.get("currency") or "EUR",
            **markup,
        }
        quote = quote_price(float(row["cheapest_eur_per_gb"]), config, country=str(row.get("iso2") or iso2), locale=locale)
        quote.country = str(row.get("iso2") or iso2).upper()
        return quote

    def _get(self, path: str) -> JsonObject:
        retry = self.retry
        attempts = (retry.max_retries if retry else 0) + 1
        last: Exception | None = None
        for attempt in range(attempts):
            try:
                response = self._client.get(
                    self.origin + path,
                    headers={"Accept": "application/json", "User-Agent": self.user_agent},
                    timeout=self.timeout,
                )
            except httpx.HTTPError as exc:
                last = NxtlConnectionError(str(exc), status_code=0, code="catalog_connection")
                if retry is None or attempt + 1 >= attempts:
                    raise last from exc
                (retry.sleep or time.sleep)(compute_delay(retry, attempt, None))
                continue
            if response.status_code >= 400:
                error = NxtlConnectionError(
                    f"Public feed {path} returned {response.status_code}",
                    status_code=response.status_code,
                    code="catalog_http",
                )
                if retry is None or response.status_code < 500 or attempt + 1 >= attempts:
                    raise error
                (retry.sleep or time.sleep)(compute_delay(retry, attempt, None))
                last = error
                continue
            payload = response.json()
            if not isinstance(payload, dict):
                raise NxtlConnectionError(f"Public feed {path} was not a JSON object", status_code=response.status_code)
            return payload
        raise last or NxtlConnectionError("Catalog request failed", status_code=0)


class AsyncPublicCatalog:
    def __init__(
        self,
        *,
        origin: str = DEFAULT_ORIGIN,
        timeout: float = 30.0,
        user_agent: str | None = None,
        http_client: httpx.AsyncClient | None = None,
        retry: Any = None,
    ) -> None:
        self.origin = origin.rstrip("/")
        self.timeout = timeout
        self.user_agent = user_agent or DEFAULT_USER_AGENT
        self.retry = resolve_retry(retry)
        self._owns = http_client is None
        self._client = http_client or httpx.AsyncClient(timeout=timeout, follow_redirects=False)

    async def __aenter__(self) -> AsyncPublicCatalog:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns:
            await self._client.aclose()

    async def pricing(self) -> JsonObject:
        return await self._get("/ai/pricing.json")

    async def coverage(self) -> JsonObject:
        return await self._get("/ai/coverage.json")

    async def destinations(self) -> JsonObject:
        return await self._get("/ai/destinations.json")

    async def product(self) -> JsonObject:
        return await self._get("/ai/nxtl-product.json")

    async def load_all(self) -> dict[str, JsonObject]:
        return {
            "pricing": await self.pricing(),
            "coverage": await self.coverage(),
            "destinations": await self.destinations(),
            "product": await self.product(),
        }

    def quote_country_rate(self, feed: JsonObject, iso2: str, markup: dict[str, Any], *, locale: str = "en_US") -> PriceQuote:
        return PublicCatalog.quote_country_rate(self, feed, iso2, markup, locale=locale)  # type: ignore[arg-type]

    find_pricing_country = PublicCatalog.find_pricing_country
    find_coverage = PublicCatalog.find_coverage
    find_destination = PublicCatalog.find_destination

    async def _get(self, path: str) -> JsonObject:
        import asyncio

        retry = self.retry
        attempts = (retry.max_retries if retry else 0) + 1
        last: Exception | None = None
        for attempt in range(attempts):
            try:
                response = await self._client.get(
                    self.origin + path,
                    headers={"Accept": "application/json", "User-Agent": self.user_agent},
                    timeout=self.timeout,
                )
            except httpx.HTTPError as exc:
                last = NxtlConnectionError(str(exc), status_code=0, code="catalog_connection")
                if retry is None or attempt + 1 >= attempts:
                    raise last from exc
                await asyncio.sleep(compute_delay(retry, attempt, None))
                continue
            if response.status_code >= 400:
                error = NxtlConnectionError(
                    f"Public feed {path} returned {response.status_code}",
                    status_code=response.status_code,
                    code="catalog_http",
                )
                if retry is None or response.status_code < 500 or attempt + 1 >= attempts:
                    raise error
                await asyncio.sleep(compute_delay(retry, attempt, None))
                last = error
                continue
            payload = response.json()
            if not isinstance(payload, dict):
                raise NxtlConnectionError(f"Public feed {path} was not a JSON object", status_code=response.status_code)
            return payload
        raise last or NxtlConnectionError("Catalog request failed", status_code=0)
