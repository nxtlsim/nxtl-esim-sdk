"""Threshold helpers, webhook routing, and a reseller-run usage sync."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Mapping
from typing import Any, Callable

from ..models import WEBHOOK_EVENT_NAMES
from .customers import AsyncCustomerDirectory, CustomerDirectory
from .packages import suspend_overage_lines


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
    customers = directory.store.list_customers(status="active")
    alerts: list[dict[str, Any]] = []
    period = options["period"]
    for customer in customers:
        lines = directory.store.list_assignments(customer_id=customer["id"], active_only=True)
        if not lines:
            continue
        report = directory.customer_usage(customer["id"], period, **_cost_options(options))
        recorded = directory.record_snapshot(customer["id"], report)
        delta = recorded["delta"]
        if delta["retail"] > 0 or delta["bytes"] > 0:
            alert = {"type": "usage_delta", "customer_id": customer["id"], "retail": delta["retail"], "margin": delta["margin"], "bytes": delta["bytes"]}
            alerts.append(alert)
            _emit(options, alert)
            if delta["retail"] > 0:
                directory.debit(customer["id"], delta["retail"], report["totals"].get("retail_currency") or "EUR", "Usage since last snapshot", report["until"])
        consumption = directory.apply_packages(customer["id"], {**report, "rows": delta["added"]}, options.get("package_mode") or "fifo")
        if options.get("suspend_overage"):
            suspend_overage_lines(directory.client, consumption["allocations"], directory.store.list_packages())
        for allocation in consumption["allocations"]:
            if allocation.get("status") != "overage":
                continue
            alert = {"type": "package_overage", "customer_id": customer["id"], "allocation_id": allocation["id"]}
            if allocation.get("iccid"):
                alert["iccid"] = allocation["iccid"]
            alerts.append(alert)
            _emit(options, alert)
        low = options.get("low_balance")
        if low:
            balance = directory.wallet_balance(customer["id"], low["currency"])
            if balance <= float(low["threshold"]):
                alert = {"type": "low_balance", "customer_id": customer["id"], "balance": balance, "currency": low["currency"]}
                alerts.append(alert)
                _emit(options, alert)
    return {"customers": len(customers), "alerts": alerts}


async def sync_reseller_async(directory: AsyncCustomerDirectory, **options: Any) -> dict[str, Any]:
    customers = directory.store.list_customers(status="active")
    alerts: list[dict[str, Any]] = []
    period = options["period"]
    for customer in customers:
        lines = directory.store.list_assignments(customer_id=customer["id"], active_only=True)
        if not lines:
            continue
        report = await directory.customer_usage(customer["id"], period, **_cost_options(options))
        recorded = directory.record_snapshot(customer["id"], report)
        delta = recorded["delta"]
        if delta["retail"] > 0:
            directory.debit(customer["id"], delta["retail"], report["totals"].get("retail_currency") or "EUR", "Usage since last snapshot", report["until"])
            alerts.append({"type": "usage_delta", "customer_id": customer["id"], "retail": delta["retail"], "margin": delta["margin"], "bytes": delta["bytes"]})
        directory.apply_packages(customer["id"], {**report, "rows": delta["added"]}, options.get("package_mode") or "fifo")
        low = options.get("low_balance")
        if low and directory.wallet_balance(customer["id"], low["currency"]) <= float(low["threshold"]):
            alerts.append({"type": "low_balance", "customer_id": customer["id"], "balance": directory.wallet_balance(customer["id"], low["currency"]), "currency": low["currency"]})
    return {"customers": len(customers), "alerts": alerts}


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
