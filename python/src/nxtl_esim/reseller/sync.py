"""Accounting-CDR sync shared by the sync and async reseller directories."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

from .money import posting_for_row
from .packages import apply_usage_to_packages, line_needs_suspension, refresh_allocations
from .usage import normalize_usage_row, period_bounds


def classify_usage_webhook(envelope: Mapping[str, Any]) -> dict[str, Any]:
    data = envelope.get("data") if isinstance(envelope.get("data"), Mapping) else {}
    ledger = data.get("ledger_id")
    if isinstance(ledger, int):
        return {"delivery_id": envelope.get("id"), "ledger_id": ledger, "deferred": False}
    return {"delivery_id": envelope.get("id"), "deferred": True}


def checkpoint_scope(account_id: str, iccid: str, since: str, until: str) -> str:
    return f"{account_id}|{iccid}|{since}|{until}"


def sync_reseller(directory: Any, **options: Any) -> dict[str, Any]:
    def cursor(**query: Any) -> list[dict[str, Any]]:
        return list(directory.client.iterate_accounting_cdrs(**query))

    def pages(**query: Any) -> list[dict[str, Any]]:
        return list(directory.client.iterate_usage_cdrs(**query))

    return _sync(directory, cursor, pages, options)


async def sync_reseller_async(directory: Any, **options: Any) -> dict[str, Any]:
    async def cursor(**query: Any) -> list[dict[str, Any]]:
        rows = []
        async for row in directory.client.iterate_accounting_cdrs(**query):
            rows.append(row)
        return rows

    async def pages(**query: Any) -> list[dict[str, Any]]:
        rows = []
        async for row in directory.client.iterate_usage_cdrs(**query):
            rows.append(row)
        return rows

    return await _sync_async(directory, cursor, pages, options)


def _sync(directory: Any, cursor: Any, pages: Any, options: Mapping[str, Any]) -> dict[str, Any]:
    return _finish(directory, options, lambda iccid, since, until, after: cursor(iccid=iccid, since=since, until=until, after_id=after, per_page=100), lambda iccid, since, until: pages(iccid=iccid, since=since, until=until, per_page=100, accounting=1))


async def _sync_async(directory: Any, cursor: Any, pages: Any, options: Mapping[str, Any]) -> dict[str, Any]:
    async def load_cursor(iccid: str, since: str, until: str, after: int) -> list[dict[str, Any]]:
        return await cursor(iccid=iccid, since=since, until=until, after_id=after, per_page=100)

    async def load_pages(iccid: str, since: str, until: str) -> list[dict[str, Any]]:
        return await pages(iccid=iccid, since=since, until=until, per_page=100, accounting=1)

    customers = directory.store.list_customers(status="active")
    alerts: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    unavailable = False
    wallet_currency = str(options.get("retail_currency") or "EUR")
    bounds = period_bounds(options["period"])
    account = str(options.get("account_id") or "default")
    for customer in customers:
        lines = directory.store.list_assignments(customer_id=customer["id"], active_only=True)
        if not lines:
            continue
        wallet: list[dict[str, Any]] = []
        applied: list[dict[str, str]] = []
        pending: list[dict[str, Any]] = []
        clear_pending: list[dict[str, Any]] = []
        checkpoints: list[dict[str, Any]] = []
        volume_rows: list[dict[str, Any]] = []
        manual = {line["iccid"] for line in lines if line.get("manual_pause")}
        for line in lines:
            scope = checkpoint_scope(account, line["iccid"], bounds["since"], bounds["until"])
            after = directory.store.get_checkpoint(scope)
            fresh = [normalize_usage_row(row, "cdr", {"iccid": line["iccid"]}) for row in await load_cursor(line["iccid"], bounds["since"], bounds["until"], after)]
            waiting = directory.store.list_pending(scope)
            if waiting:
                want = {int(item["ledger_id"]) for item in waiting}
                for raw in await load_pages(line["iccid"], bounds["since"], bounds["until"]):
                    row = normalize_usage_row(raw, "cdr", {"iccid": line["iccid"]})
                    if row.get("ledger_id") in want:
                        fresh.append(row)
            blocked, cursor_id, line_unavailable = _consume(customer, line, scope, after, fresh, directory, options, wallet_currency, wallet, applied, pending, clear_pending, volume_rows, unresolved)
            unavailable = unavailable or line_unavailable
            if cursor_id > after and not blocked:
                checkpoints.append({"scope": scope, "after_id": cursor_id})
            elif cursor_id > after:
                checkpoints.append({"scope": scope, "after_id": cursor_id})
        allocations, packages = _prepare_allocations(directory, customer["id"], volume_rows, unavailable, options)
        directory.store.commit_sync(wallet, applied, allocations=allocations, checkpoints=checkpoints, pending=pending, clear_pending=clear_pending)
        if options.get("suspend_overage", True):
            await _suspend_async(directory, customer["id"], lines, allocations, packages, manual, options)
        low = options.get("low_balance")
        if low and directory.wallet_balance(customer["id"], low["currency"]) <= float(low["threshold"]):
            alerts.append({"type": "low_balance", "customer_id": customer["id"], "balance": directory.wallet_balance(customer["id"], low["currency"]), "currency": low["currency"]})
    return {"customers": len(customers), "alerts": alerts, "unresolved": unresolved, "capability_unavailable": unavailable}


def _finish(directory: Any, options: Mapping[str, Any], load_cursor: Any, load_pages: Any) -> dict[str, Any]:
    customers = directory.store.list_customers(status="active")
    alerts: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    unavailable = False
    wallet_currency = str(options.get("retail_currency") or "EUR")
    bounds = period_bounds(options["period"])
    account = str(options.get("account_id") or "default")
    for customer in customers:
        lines = directory.store.list_assignments(customer_id=customer["id"], active_only=True)
        if not lines:
            continue
        wallet: list[dict[str, Any]] = []
        applied: list[dict[str, str]] = []
        pending: list[dict[str, Any]] = []
        clear_pending: list[dict[str, Any]] = []
        checkpoints: list[dict[str, Any]] = []
        volume_rows: list[dict[str, Any]] = []
        manual = {line["iccid"] for line in lines if line.get("manual_pause")}
        for line in lines:
            scope = checkpoint_scope(account, line["iccid"], bounds["since"], bounds["until"])
            after = directory.store.get_checkpoint(scope)
            fresh = [normalize_usage_row(row, "cdr", {"iccid": line["iccid"]}) for row in load_cursor(line["iccid"], bounds["since"], bounds["until"], after)]
            waiting = directory.store.list_pending(scope)
            if waiting:
                want = {int(item["ledger_id"]) for item in waiting}
                for raw in load_pages(line["iccid"], bounds["since"], bounds["until"]):
                    row = normalize_usage_row(raw, "cdr", {"iccid": line["iccid"]})
                    if row.get("ledger_id") in want:
                        fresh.append(row)
            _blocked, cursor_id, line_unavailable = _consume(customer, line, scope, after, fresh, directory, options, wallet_currency, wallet, applied, pending, clear_pending, volume_rows, unresolved)
            unavailable = unavailable or line_unavailable
            if cursor_id > after:
                checkpoints.append({"scope": scope, "after_id": cursor_id})
        allocations, packages = _prepare_allocations(directory, customer["id"], volume_rows, unavailable, options)
        directory.store.commit_sync(wallet, applied, allocations=allocations, checkpoints=checkpoints, pending=pending, clear_pending=clear_pending)
        if options.get("suspend_overage", True):
            _suspend(directory, customer["id"], lines, allocations, packages, manual, options)
        low = options.get("low_balance")
        if low:
            balance = directory.wallet_balance(customer["id"], low["currency"])
            if balance <= float(low["threshold"]):
                alert = {"type": "low_balance", "customer_id": customer["id"], "balance": balance, "currency": low["currency"]}
                alerts.append(alert)
                callback = options.get("on_alert")
                if callback:
                    callback(alert)
        for entry in wallet:
            if entry["kind"] == "debit":
                alert = {"type": "usage_delta", "customer_id": customer["id"], "retail": entry["amount"], "margin": 0, "bytes": 0}
                alerts.append(alert)
                callback = options.get("on_alert")
                if callback:
                    callback(alert)
    return {"customers": len(customers), "alerts": alerts, "unresolved": unresolved, "capability_unavailable": unavailable}


def _consume(customer: Mapping[str, Any], line: Mapping[str, Any], scope: str, after: int, fresh: list[dict[str, Any]], directory: Any, options: Mapping[str, Any], wallet_currency: str, wallet: list[dict[str, Any]], applied: list[dict[str, str]], pending: list[dict[str, Any]], clear_pending: list[dict[str, Any]], volume_rows: list[dict[str, Any]], unresolved: list[dict[str, Any]]) -> tuple[bool, int, bool]:
    fresh.sort(key=lambda row: int(row.get("ledger_id") or 0))
    cursor = after
    blocked = False
    unavailable = False
    seen: set[int] = set()
    for row in fresh:
        ledger_id = row.get("ledger_id")
        if not isinstance(ledger_id, int) or ledger_id in seen:
            continue
        seen.add(ledger_id)
        if row.get("detail_available") is None:
            unavailable = True
        key = str(ledger_id)
        financial_done = directory.store.has_applied("financial", key) or any(item["stream"] == "financial" and item["key"] == key for item in applied)
        if not financial_done and ledger_id > after:
            if blocked:
                continue
            posting = posting_for_row(row, wallet_currency=wallet_currency, markup=options.get("markup"), fx=options.get("fx"))
            if posting["status"] == "unresolved":
                unresolved.append({"customer_id": customer["id"], "ledger_id": ledger_id, "reason": posting.get("reason")})
                blocked = True
                continue
            if posting["status"] == "ready":
                wallet.append({
                    "id": f"wal_{customer['id']}_{posting['kind']}_{ledger_id}",
                    "customer_id": customer["id"],
                    "at": row.get("at") or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "kind": posting["kind"],
                    "amount": posting["selling"],
                    "currency": posting["currency"],
                    "memo": "NXTL API credit" if posting["kind"] == "credit" else "Reseller selling charge",
                    "reference": key,
                })
            applied.append({"stream": "financial", "key": key})
            cursor = ledger_id
        elif ledger_id > cursor and not blocked:
            cursor = ledger_id
        if directory.store.has_applied("volume", key) or any(item["stream"] == "volume" and item["key"] == key for item in applied):
            clear_pending.append({"scope": scope, "ledger_id": ledger_id})
            continue
        if row.get("detail_available") is True:
            volume_rows.append(row)
            applied.append({"stream": "volume", "key": key})
            clear_pending.append({"scope": scope, "ledger_id": ledger_id})
        elif row.get("detail_available") is False:
            pending.append({"scope": scope, "ledger_id": ledger_id, "iccid": row.get("iccid") or line["iccid"], "created_at": row.get("at")})
    return blocked, cursor, unavailable


def _clock(options: Mapping[str, Any]) -> datetime:
    now = options.get("now")
    if isinstance(now, datetime):
        return now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


def _prepare_allocations(directory: Any, customer_id: str, volume_rows: list[dict[str, Any]], unavailable: bool, options: Mapping[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    packages = directory.store.list_packages()
    allocations = directory.store.list_allocations(customer_id=customer_id)
    now = _clock(options)
    if volume_rows and not unavailable:
        allocations = apply_usage_to_packages(volume_rows, allocations, packages, options.get("package_mode") or "fifo", now)["allocations"]
    else:
        allocations = refresh_allocations(allocations, packages, now)
    return allocations, packages


def _suspend(directory: Any, customer_id: str, lines: list[Mapping[str, Any]], allocations: list[dict[str, Any]], packages: list[dict[str, Any]], manual: set[str], options: Mapping[str, Any]) -> None:
    now = _clock(options)
    owned = {line["iccid"] for line in lines}
    due = [iccid for iccid in owned if iccid not in manual and line_needs_suspension(iccid, allocations, packages, now)]
    failed: list[dict[str, Any]] = []
    clear: list[str] = []
    for iccid in due:
        try:
            directory.client.suspend_esim(iccid)
            clear.append(f"suspend_{iccid}")
        except Exception as exc:  # noqa: BLE001
            failed.append({"id": f"suspend_{iccid}", "iccid": iccid, "customer_id": customer_id, "kind": "suspend", "error": str(exc), "at": now.isoformat()})
    for action in directory.store.list_failed_actions():
        owner = action.get("customer_id")
        if owner and owner != customer_id:
            continue
        if not owner and action.get("iccid") not in owned:
            continue
        iccid = str(action.get("iccid"))
        still_due = iccid in owned and iccid not in manual and line_needs_suspension(iccid, allocations, packages, now)
        if not still_due:
            clear.append(str(action["id"]))
            continue
        if iccid in due:
            continue
        try:
            directory.client.suspend_esim(iccid)
            clear.append(str(action["id"]))
        except Exception as exc:  # noqa: BLE001
            failed.append({**action, "customer_id": customer_id, "error": str(exc), "at": now.isoformat()})
    if failed or clear:
        directory.store.commit_sync(failed_actions=failed, clear_failed=clear)


async def _suspend_async(directory: Any, customer_id: str, lines: list[Mapping[str, Any]], allocations: list[dict[str, Any]], packages: list[dict[str, Any]], manual: set[str], options: Mapping[str, Any]) -> None:
    now = _clock(options)
    owned = {line["iccid"] for line in lines}
    due = [iccid for iccid in owned if iccid not in manual and line_needs_suspension(iccid, allocations, packages, now)]
    failed: list[dict[str, Any]] = []
    clear: list[str] = []
    for iccid in due:
        try:
            await directory.client.suspend_esim(iccid)
            clear.append(f"suspend_{iccid}")
        except Exception as exc:  # noqa: BLE001
            failed.append({"id": f"suspend_{iccid}", "iccid": iccid, "customer_id": customer_id, "kind": "suspend", "error": str(exc), "at": now.isoformat()})
    for action in directory.store.list_failed_actions():
        owner = action.get("customer_id")
        if owner and owner != customer_id:
            continue
        if not owner and action.get("iccid") not in owned:
            continue
        iccid = str(action.get("iccid"))
        still_due = iccid in owned and iccid not in manual and line_needs_suspension(iccid, allocations, packages, now)
        if not still_due:
            clear.append(str(action["id"]))
            continue
        if iccid in due:
            continue
        try:
            await directory.client.suspend_esim(iccid)
            clear.append(str(action["id"]))
        except Exception as exc:  # noqa: BLE001
            failed.append({**action, "customer_id": customer_id, "error": str(exc), "at": now.isoformat()})
    if failed or clear:
        directory.store.commit_sync(failed_actions=failed, clear_failed=clear)
