"""Threshold helpers, webhook routing, and a reseller-run usage sync."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Mapping
from typing import Any, Callable

from ..models import WEBHOOK_EVENT_NAMES
from .customers import AsyncCustomerDirectory, CustomerDirectory


def ensure_usage_percent_rule(client: Any, *, percent: float, action: str = "notify", period: str = "daily") -> Any:
    if percent <= 0 or percent > 100:
        raise TypeError("percent must be between 0 and 100")
    return client.create_threshold({
        "scope": "esim",
        "metric": "line_usage_pct",
        "operator": ">=",
        "threshold_value": percent,
        "period": period,
        "action": action,
        "enabled": True,
    })


def ensure_pool_balance_rule(client: Any, *, threshold_usd: float, action: str = "notify") -> Any:
    return client.create_threshold({
        "scope": "balance",
        "metric": "balance_below",
        "operator": "<=",
        "threshold_value": threshold_usd,
        "period": "instant",
        "action": action,
        "enabled": True,
    })


class WebhookRouter:
    def __init__(self, client: Any) -> None:
        self.client = client
        self.handlers: dict[str, list[Callable[..., Any]]] = {}

    def on(self, event: str, handler: Callable[..., Any]) -> WebhookRouter:
        if event != "*" and event not in WEBHOOK_EVENT_NAMES:
            # Unknown names are still delivered by the API. Accept them.
            pass
        self.handlers.setdefault(event, []).append(handler)
        return self

    def dispatch(self, event: Mapping[str, Any]) -> None:
        for handler in self.handlers.get(str(event["event"]), []) + self.handlers.get("*", []):
            handler(event, self.client)

    async def dispatch_async(self, event: Mapping[str, Any]) -> None:
        for handler in self.handlers.get(str(event["event"]), []) + self.handlers.get("*", []):
            result = handler(event, self.client)
            if isinstance(result, Awaitable):
                await result


def sync_reseller(directory: CustomerDirectory, **options: Any) -> dict[str, Any]:
    from .sync import sync_reseller as run
    return run(directory, **options)


async def sync_reseller_async(directory: AsyncCustomerDirectory, **options: Any) -> dict[str, Any]:
    from .sync import sync_reseller_async as run
    return await run(directory, **options)


async def sync_loop(run: Callable[[], Awaitable[Any]], interval_seconds: float, stop: asyncio.Event) -> None:
    """Local async loop. The API does not schedule polls."""

    if interval_seconds < 1:
        raise TypeError("interval_seconds must be >= 1")
    while not stop.is_set():
        await run()
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval_seconds)
        except asyncio.TimeoutError:
            continue


def _detail_key(row: Mapping[str, Any]) -> str:
    return "|".join(str(row.get(key, "")) for key in ("iccid", "entry_type", "at", "amount_eur", "amount_usd", "bytes", "country"))


def _cost_options(options: Mapping[str, Any]) -> dict[str, Any]:
    picked = {}
    for key in ("markup", "pricing", "fx", "retail_currency"):
        if key in options:
            picked[key] = options[key]
    return picked


def _emit(options: Mapping[str, Any], alert: Mapping[str, Any]) -> None:
    callback = options.get("on_alert")
    if callback:
        callback(alert)
