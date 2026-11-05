"""Reseller-defined allowances. These are not NXTL plans and are not API resources."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta, timezone
from typing import Any

from .units import to_bytes


def define_package(draft: Mapping[str, Any]) -> dict[str, Any]:
    if not draft.get("name"):
        raise TypeError("package name is required")
    gb = float(draft["data_cap_gb"])
    days = int(draft["validity_days"])
    if gb <= 0 or days < 1:
        raise TypeError("data cap and validity must be positive")
    package: dict[str, Any] = {
        "id": draft.get("id") or f"pkg_{int(datetime.now(timezone.utc).timestamp())}",
        "name": draft["name"],
        "data_cap_bytes": to_bytes(gb, "GB"),
        "validity_days": days,
        "countries": [str(code).upper() for code in draft.get("countries") or []],
        "price": float(draft["price"]),
        "currency": draft["currency"],
        "overage": draft.get("overage") or "flag",
        "priority": int(draft.get("priority") or 100),
    }
    if draft.get("usd_cap") is not None:
        package["usd_cap"] = float(draft["usd_cap"])
    return package


def open_allocation(customer_id: str, package: Mapping[str, Any], **options: Any) -> dict[str, Any]:
    starts = _parse(options["starts_at"]) if options.get("starts_at") else datetime.now(timezone.utc)
    expires = starts + timedelta(days=int(package["validity_days"]))
    allocation: dict[str, Any] = {
        "id": options.get("id") or f"alloc_{int(starts.timestamp())}_{package['id']}",
        "customer_id": customer_id,
        "package_id": package["id"],
        "starts_at": _iso(starts),
        "expires_at": _iso(expires),
        "consumed_bytes": 0.0,
        "status": "active",
    }
    if options.get("iccid"):
        allocation["iccid"] = options["iccid"]
    return allocation


def apply_usage_to_packages(
    rows: Iterable[Mapping[str, Any]],
    allocations: Iterable[Mapping[str, Any]],
    packages: Iterable[Mapping[str, Any]],
    mode: str = "fifo",
    now: datetime | None = None,
) -> dict[str, Any]:
    moment = now or datetime.now(timezone.utc)
    by_id = {item["id"]: item for item in packages}
    nxt = [dict(item) for item in allocations]
    order = sorted(nxt, key=lambda item: _sort_key(item, by_id, mode))
    consumed = overage = unmatched = 0.0
    unmetered = 0
    for row in sorted(rows, key=lambda item: str(item.get("at") or "")):
        if "bytes" not in row:
            unmetered += 1
            continue
        remaining = float(row["bytes"])
        for allocation in order:
            if remaining <= 0:
                break
            package = by_id.get(allocation["package_id"])
            if not package or not _accepts(allocation, package, row, moment):
                continue
            _refresh(allocation, package, moment)
            if allocation["status"] == "expired":
                continue
            room = max(0.0, _cap(allocation, package) - float(allocation["consumed_bytes"]))
            if room <= 0:
                allocation["status"] = "exhausted"
                continue
            take = min(room, remaining)
            allocation["consumed_bytes"] = float(allocation["consumed_bytes"]) + take
            consumed += take
            remaining -= take
            if allocation["consumed_bytes"] >= _cap(allocation, package):
                allocation["status"] = "exhausted"
        if remaining > 0:
            eligible = next((item for item in order if (by_id.get(item["package_id"]) and _matches(item, by_id[item["package_id"]], row, moment))), None)
            if eligible is not None:
                eligible["consumed_bytes"] = float(eligible["consumed_bytes"]) + remaining
                eligible["status"] = "overage"
                overage += remaining
            else:
                unmatched += remaining
    for allocation in nxt:
        package = by_id.get(allocation["package_id"])
        if package:
            _refresh(allocation, package, moment)
    return {
        "allocations": nxt,
        "consumed_bytes": consumed,
        "overage_bytes": overage,
        "unmatched_bytes": unmatched,
        "unmetered_rows": unmetered,
    }


def remaining_allowance(allocation: Mapping[str, Any], package: Mapping[str, Any], now: datetime | None = None) -> dict[str, Any]:
    moment = now or datetime.now(timezone.utc)
    ms = (_parse(str(allocation["expires_at"])) - moment).total_seconds()
    return {
        "bytes_remaining": max(0.0, _cap(allocation, package) - float(allocation["consumed_bytes"])),
        "days_remaining": max(0.0, ms / 86400),
        "expired": ms <= 0,
    }


def renew_allocation(current: Mapping[str, Any], package: Mapping[str, Any], **options: Any) -> dict[str, Any]:
    start = _parse(options["when"]) if options.get("when") else _parse(str(current["expires_at"]))
    days = int(package["validity_days"]) + int(options.get("extra_days") or 0)
    allocation: dict[str, Any] = {
        "id": f"alloc_{int(start.timestamp())}_{package['id']}",
        "customer_id": current["customer_id"],
        "package_id": package["id"],
        "starts_at": _iso(start),
        "expires_at": _iso(start + timedelta(days=days)),
        "consumed_bytes": 0.0,
        "status": "active",
    }
    if current.get("iccid"):
        allocation["iccid"] = current["iccid"]
    if options.get("extra_bytes"):
        allocation["bonus_bytes"] = float(options["extra_bytes"])
    return allocation


def top_up_allocation(allocation: Mapping[str, Any], **options: Any) -> dict[str, Any]:
    nxt = dict(allocation)
    nxt["status"] = "active"
    if options.get("extra_bytes"):
        nxt["bonus_bytes"] = float(allocation.get("bonus_bytes") or 0) + float(options["extra_bytes"])
    if options.get("extra_days"):
        nxt["expires_at"] = _iso(_parse(str(allocation["expires_at"])) + timedelta(days=int(options["extra_days"])))
    return nxt


def sync_package_threshold(client: Any, package: Mapping[str, Any]) -> dict[str, Any]:
    """Create a daily USD threshold when ``usd_cap`` is set.

    TODO(spec): published metrics cannot express a multi-day byte allowance.
    """

    if package.get("usd_cap") is None:
        return {"created": False, "reason": "No usd_cap. Byte allowances stay in the reseller store."}
    client.create_threshold({
        "scope": "esim",
        "metric": "line_usage_usd_today",
        "operator": ">=",
        "threshold_value": package["usd_cap"],
        "period": "daily",
        "action": "suspend" if package.get("overage") == "suspend" else "notify",
        "enabled": True,
        "notes": {"cap_per_line_usd": package["usd_cap"]},
    })
    return {"created": True}


def suspend_overage_lines(client: Any, allocations: Iterable[Mapping[str, Any]], packages: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    by_id = {item["id"]: item for item in packages}
    results = []
    for allocation in allocations:
        package = by_id.get(allocation["package_id"])
        if not package or package.get("overage") != "suspend" or allocation.get("status") != "overage" or not allocation.get("iccid"):
            continue
        try:
            client.suspend_esim(allocation["iccid"])
            results.append({"iccid": allocation["iccid"], "ok": True})
        except Exception as exc:  # noqa: BLE001 - per-line result, not a crash
            results.append({"iccid": allocation["iccid"], "ok": False, "error": str(exc)})
    return results


def _cap(allocation: Mapping[str, Any], package: Mapping[str, Any]) -> float:
    return float(package["data_cap_bytes"]) + float(allocation.get("bonus_bytes") or 0)


def _matches(allocation: Mapping[str, Any], package: Mapping[str, Any], row: Mapping[str, Any], now: datetime) -> bool:
    at = _parse(str(row["at"])) if row.get("at") else now
    if at < _parse(str(allocation["starts_at"])) or at >= _parse(str(allocation["expires_at"])):
        return False
    if allocation.get("iccid") and row.get("iccid") and allocation["iccid"] != row["iccid"]:
        return False
    countries = package.get("countries") or []
    if not countries:
        return True
    if not row.get("country"):
        return False
    return str(row["country"]).upper() in countries


def _accepts(allocation: Mapping[str, Any], package: Mapping[str, Any], row: Mapping[str, Any], now: datetime) -> bool:
    return allocation.get("status") != "expired" and _matches(allocation, package, row, now)


def _refresh(allocation: dict[str, Any], package: Mapping[str, Any], now: datetime) -> None:
    if _parse(str(allocation["expires_at"])) <= now:
        allocation["status"] = "expired"
        return
    if allocation.get("status") == "overage":
        return
    if float(allocation["consumed_bytes"]) >= _cap(allocation, package):
        allocation["status"] = "exhausted"
    elif allocation.get("status") != "active":
        allocation["status"] = "active"


def _sort_key(allocation: Mapping[str, Any], packages: Mapping[str, Mapping[str, Any]], mode: str) -> Any:
    priority = int((packages.get(allocation["package_id"]) or {}).get("priority") or 100)
    if mode == "priority":
        return (priority, allocation["starts_at"])
    return (allocation["starts_at"],)


def _parse(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _iso(moment: datetime) -> str:
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
