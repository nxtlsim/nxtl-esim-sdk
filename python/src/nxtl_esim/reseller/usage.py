"""Usage cost from the published usage endpoints.

``amount_usd`` and ``amount_eur`` are named in the human API reference.
Volume and country fields are not in the OpenAPI schema and are read only
when a row already contains them.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta, timezone
from typing import Any

from ..pricing import quote_price
from .fx import convert_fx

VOLUME_BYTES = ("bytes", "volume_bytes", "data_bytes", "octets")
VOLUME_MB = ("volume_mb", "data_mb", "usage_mb", "mb")
VOLUME_GB = ("volume_gb", "data_gb", "usage_gb", "gb")
COUNTRY_KEYS = ("iso2", "country", "country_code", "destination")
TIME_KEYS = ("at", "timestamp", "created_at", "recorded_at", "occurred_at", "day")


def period_bounds(period: Mapping[str, str]) -> dict[str, str]:
    kind = period["kind"]
    if kind == "daily":
        start = datetime.fromisoformat(period["day"] + "T00:00:00+00:00")
        end = start + timedelta(days=1)
        return {"since": _iso(start), "until": _iso(end)}
    if kind == "monthly":
        year, month = (int(part) for part in period["month"].split("-"))
        start = datetime(year, month, 1, tzinfo=timezone.utc)
        end = datetime(year + (1 if month == 12 else 0), 1 if month == 12 else month + 1, 1, tzinfo=timezone.utc)
        return {"since": _iso(start), "until": _iso(end)}
    return {"since": period["since"], "until": period["until"]}


def normalize_usage_row(raw: Mapping[str, Any], source: str = "manual", context: Mapping[str, Any] | None = None) -> dict[str, Any]:
    from .countries import country_name_to_iso2
    from .ledger import api_charge, parse_utc_timestamp, webhook_charge

    used = [source]
    amount_usd = _number(raw, ("amount_usd",), used)
    amount_eur = _number(raw, ("amount_eur",), used)
    currency = _string(raw, ("currency",), used)
    entry_type = _string(raw, ("entry_type",), used)
    money = webhook_charge(raw) if source == "webhook" else api_charge({"currency": currency, "amount_usd": amount_usd, "amount_eur": amount_eur})
    at_raw = _string(raw, TIME_KEYS, used)
    row: dict[str, Any] = {
        "source": source,
        "source_keys": used,
        "raw": dict(raw),
        "volume_trusted": False,
        "charge_kind": money["kind"],
        "consumption_charge": money["consumption_charge"],
    }
    if source == "cdr":
        ledger = raw.get("ledger_id") if isinstance(raw.get("ledger_id"), int) else raw.get("id")
        if isinstance(ledger, int):
            row["ledger_id"] = ledger
    elif isinstance(raw.get("ledger_id"), int):
        row["ledger_id"] = raw["ledger_id"]
    if isinstance(raw.get("detail_available"), bool):
        row["detail_available"] = raw["detail_available"]
    if source == "webhook" and isinstance(raw.get("id"), str):
        row["event_id"] = raw["id"]
    if entry_type:
        row["entry_type"] = entry_type
    iccid = _string(raw, ("iccid",), used)
    if iccid:
        row["iccid"] = iccid
    elif context and context.get("iccid"):
        row["iccid"] = context["iccid"]
    if at_raw:
        row["at"] = parse_utc_timestamp(at_raw)
    if amount_usd is not None:
        row["amount_usd"] = amount_usd
    if amount_eur is not None:
        row["amount_eur"] = amount_eur
    if currency or money["currency"]:
        row["currency"] = currency or money["currency"]
    trust = source == "manual" or (source == "line_usage" and entry_type == "usage") or (source == "cdr" and row.get("detail_available") is True) or (source == "webhook" and (_number(raw, ("bytes",), used) or 0) > 0)
    if source == "cdr" and row.get("detail_available") is not True:
        trust = False
    if trust:
        num_bytes = _number(raw, ("bytes",), used) if source in {"line_usage", "webhook"} else _bytes(raw, used)
        if num_bytes is not None and not (source == "webhook" and num_bytes == 0):
            row["bytes"] = num_bytes
            row["volume_trusted"] = True
        country_keys = ("country", "iso2") if source == "manual" else ("country",)
        country = _string(raw, country_keys, used)
        if country and country.strip():
            row["country"] = country.strip().upper() if source == "manual" and len(country.strip()) == 2 else country.strip()
            iso = country_name_to_iso2(str(row["country"]))
            if iso:
                row["country_iso2"] = iso
    network = _string(raw, ("network", "operator"), used)
    if network and source != "cdr":
        row["network"] = network
    return row


def row_in_period(row: Mapping[str, Any], since: str, until: str) -> bool:
    at = row.get("at")
    if not isinstance(at, str):
        return True
    try:
        moment = datetime.fromisoformat(at.replace("Z", "+00:00"))
        start = datetime.fromisoformat(since.replace("Z", "+00:00"))
        end = datetime.fromisoformat(until.replace("Z", "+00:00"))
    except ValueError:
        return True
    return start <= moment < end


def cost_usage(rows: Iterable[Mapping[str, Any]], options: Mapping[str, Any] | None = None) -> dict[str, Any]:
    opts = options or {}
    markup = opts.get("markup") or {"percentage": 0, "rounding": "nearest", "currency": "EUR"}
    retail_currency = str(opts.get("retail_currency") or markup.get("currency") or "EUR")
    totals = {
        "rows": 0,
        "bytes": 0.0,
        "rows_with_volume": 0,
        "wholesale_usd": 0.0,
        "wholesale_eur": 0.0,
        "priced_from_api": 0,
        "priced_from_feed": 0,
        "unpriced_rows": 0,
        "retail": 0.0,
        "retail_currency": retail_currency,
        "margin": 0.0,
        "zero_is_not_free": False,
    }
    materialized = list(rows)
    totals["rows"] = len(materialized)
    for row in materialized:
        if row.get("volume_trusted") and "bytes" in row:
            totals["bytes"] += float(row["bytes"])
            totals["rows_with_volume"] += 1
        if row.get("currency") == "EUR" and row.get("amount_usd") == 0 and float(row.get("consumption_charge") or 0) > 0:
            totals["zero_is_not_free"] = True
        if row.get("source") == "line_usage":
            continue
        priced = _price_row(row, opts, retail_currency)
        if priced is None:
            if float(row.get("consumption_charge") or 0) > 0:
                totals["unpriced_rows"] += 1
            continue
        totals["priced_from_api"] += 1
        if priced["native"] == "USD":
            totals["wholesale_usd"] += priced["native_amount"]
        if priced["native"] == "EUR":
            totals["wholesale_eur"] += priced["native_amount"]
        totals["retail"] += priced["retail"]
        totals["margin"] += priced["retail"] - priced["wholesale_in_retail"]
    return totals


def build_usage_report(rows: Iterable[Mapping[str, Any]], period: Mapping[str, str], options: Mapping[str, Any] | None = None) -> dict[str, Any]:
    bounds = period_bounds(period)
    filtered = [row for row in rows if row_in_period(row, bounds["since"], bounds["until"])]
    notes: list[str] = []
    if any("at" not in row for row in filtered):
        notes.append("Some usage rows had no timestamp and were kept inside the requested period.")
    if any("bytes" not in row for row in filtered):
        notes.append("TODO(spec): usage rows do not publish a byte field. Volume is set only when a byte, MB, or GB key is present.")
    country_rows = [row for row in filtered if row.get("country")]
    if not country_rows:
        notes.append("TODO(spec): the usage and CDR schemas do not name a country, so the per-country breakdown is empty unless a row already includes one.")
    return {
        "period": dict(period),
        "since": bounds["since"],
        "until": bounds["until"],
        "rows": filtered,
        "totals": cost_usage(filtered, options),
        "by_line": _group(filtered, lambda row: str(row.get("iccid") or "unknown"), options),
        "by_country": _group(country_rows, lambda row: str(row.get("country") or "unknown"), options),
        "by_day": _group([row for row in filtered if row.get("at")], lambda row: str(row.get("at"))[:10], options),
        "by_month": _group([row for row in filtered if row.get("at")], lambda row: str(row.get("at"))[:7], options),
        "country_breakdown_available": bool(country_rows),
        "notes": notes,
    }


def load_usage_details(client: Any, *, period: Mapping[str, str], iccid: str | None = None, include_partner_rollups: bool = False, **options: Any) -> dict[str, Any]:
    bounds = period_bounds(period)
    notes: list[str] = []
    query: dict[str, Any] = {"since": bounds["since"], "until": bounds["until"], "per_page": 100, "after_id": 0}
    if iccid:
        query["iccid"] = iccid
    cdrs = [normalize_usage_row(row, "cdr", {"iccid": iccid} if iccid else None) for row in client.iterate_accounting_cdrs(**query)]
    unavailable = any(row.get("detail_available") is None for row in cdrs)
    pending = any(row.get("detail_available") is False for row in cdrs)
    if unavailable:
        notes.append("accounting=1 was requested but detail_available was absent. Volume is unavailable and is not treated as measured zero.")
    if pending:
        notes.append("Some accounting CDRs have detail_available false. Charges can post while volume stays pending.")
    notes.append("Accounting CDRs are the charge and volume source. Per-line rows are not added, so one ledger id is not consumed twice.")
    report = build_usage_report(cdrs, period, options)
    report["volume_complete"] = not unavailable and not pending
    report["notes"].extend(notes)
    if include_partner_rollups:
        seconds = _parse(bounds["until"]) - _parse(bounds["since"])
        days = min(365, max(1, int((seconds.total_seconds() + 86399) // 86400)))
        summary = client.usage_summary(days=days)
        series = client.usage_timeseries(days=days)
        esim_kwargs: dict[str, Any] = {"since": bounds["since"], "until": bounds["until"]}
        if iccid:
            esim_kwargs["iccid"] = iccid
        per_esim = client.usage_esims(**esim_kwargs)
        report["partner_summary"] = {"summary": summary.data, "per_esim": per_esim.data}
        report["timeseries"] = series.data
        report["notes"].append("GET /usage/summary and GET /usage/timeseries accept days, not an arbitrary since/until. The day count is capped at 365.")
    return report


async def load_usage_details_async(client: Any, **kwargs: Any) -> dict[str, Any]:
    """Same report as ``load_usage_details`` for ``AsyncNxtlClient``."""

    period = kwargs.pop("period")
    iccid = kwargs.pop("iccid", None)
    include = kwargs.pop("include_partner_rollups", False)
    bounds = period_bounds(period)
    notes: list[str] = []
    query: dict[str, Any] = {"since": bounds["since"], "until": bounds["until"], "per_page": 100, "after_id": 0}
    if iccid:
        query["iccid"] = iccid
    cdrs = []
    async for row in client.iterate_accounting_cdrs(**query):
        cdrs.append(normalize_usage_row(row, "cdr", {"iccid": iccid} if iccid else None))
    unavailable = any(row.get("detail_available") is None for row in cdrs)
    pending = any(row.get("detail_available") is False for row in cdrs)
    if unavailable:
        notes.append("accounting=1 was requested but detail_available was absent. Volume is unavailable and is not treated as measured zero.")
    notes.append("Accounting CDRs are the charge and volume source. Per-line rows are not added, so one ledger id is not consumed twice.")
    report = build_usage_report(cdrs, period, kwargs)
    report["volume_complete"] = not unavailable and not pending
    report["notes"].extend(notes)
    if include:
        seconds = _parse(bounds["until"]) - _parse(bounds["since"])
        days = min(365, max(1, int((seconds.total_seconds() + 86399) // 86400)))
        summary = await client.usage_summary(days=days)
        series = await client.usage_timeseries(days=days)
        report["partner_summary"] = {"summary": summary.data}
        report["timeseries"] = series.data
    return report


def snapshot_usage(report: Mapping[str, Any], extra: Mapping[str, str] | None = None) -> dict[str, Any]:
    extra = extra or {}
    snap: dict[str, Any] = {
        "id": extra.get("id") or f"snap_{int(datetime.now(timezone.utc).timestamp())}",
        "taken_at": _iso(datetime.now(timezone.utc)),
        "period": report["period"],
        "rows": list(report["rows"]),
        "totals": report["totals"],
    }
    if extra.get("iccid"):
        snap["iccid"] = extra["iccid"]
    if extra.get("customer_id"):
        snap["customer_id"] = extra["customer_id"]
    return snap


def diff_snapshots(previous: Mapping[str, Any] | None, nxt: Mapping[str, Any]) -> dict[str, Any]:
    before = {_fingerprint(row) for row in (previous or {}).get("rows", [])}
    after = {_fingerprint(row) for row in nxt["rows"]}
    prev = (previous or {}).get("totals") or {}
    totals = nxt["totals"]
    return {
        "added": [row for row in nxt["rows"] if _fingerprint(row) not in before],
        "removed": [row for row in (previous or {}).get("rows", []) if _fingerprint(row) not in after],
        "wholesale_usd": totals["wholesale_usd"] - float(prev.get("wholesale_usd") or 0),
        "wholesale_eur": totals["wholesale_eur"] - float(prev.get("wholesale_eur") or 0),
        "retail": totals["retail"] - float(prev.get("retail") or 0),
        "margin": totals["margin"] - float(prev.get("margin") or 0),
        "bytes": totals["bytes"] - float(prev.get("bytes") or 0),
    }


def _fingerprint(row: Mapping[str, Any]) -> str:
    return "|".join(str(row.get(key, "")) for key in ("iccid", "at", "amount_usd", "amount_eur", "bytes", "country"))


def _price_row(row: Mapping[str, Any], options: Mapping[str, Any], retail_currency: str) -> dict[str, Any] | None:
    if row.get("charge_kind") != "debit" or not row.get("consumption_charge") or row.get("currency") not in {"EUR", "USD"}:
        return None
    native = str(row["currency"])
    native_amount = float(row["consumption_charge"])
    fx = options.get("fx")
    if native != retail_currency.upper() and not fx:
        return None
    wholesale = native_amount if native == retail_currency.upper() or not fx else convert_fx(native_amount, native, retail_currency, fx)
    markup = dict(options.get("markup") or {"percentage": 0, "rounding": "nearest"})
    markup["currency"] = retail_currency
    quote = quote_price(wholesale, markup)
    return {"source": "api", "native": native, "native_amount": native_amount, "wholesale_in_retail": wholesale, "retail": quote.retail}


def _group(rows: list[Mapping[str, Any]], key_of: Any, options: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    groups: dict[str, list[Mapping[str, Any]]] = {}
    for row in rows:
        groups.setdefault(key_of(row), []).append(row)
    return [{"key": key, "totals": cost_usage(group, options)} for key, group in groups.items()]


def _iter_line_usage(client: Any, iccid: str) -> Any:
    page = 1
    while page <= 100:
        payload = client.get_esim_usage(iccid, page=page).data
        rows = payload.get("usage") if isinstance(payload, dict) else None
        if not rows:
            return
        yield from rows
        if len(rows) < 50:
            return
        page += 1


def _extract_rows(payload: Any) -> list[Mapping[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("usage", "rows", "events", "cdrs", "items", "data"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def _bytes(raw: Mapping[str, Any], used: list[str]) -> float | None:
    amount = _number(raw, VOLUME_BYTES, used)
    if amount is not None:
        return amount
    mb = _number(raw, VOLUME_MB, used)
    if mb is not None:
        return mb * 1_000_000
    gb = _number(raw, VOLUME_GB, used)
    if gb is not None:
        return gb * 1_000_000_000
    return None


def _country(raw: Mapping[str, Any], used: list[str]) -> str | None:
    value = _string(raw, COUNTRY_KEYS, used)
    if not value:
        return None
    trimmed = value.strip()
    if len(trimmed) == 2 and trimmed.isalpha():
        return trimmed.upper()
    return trimmed


def _time(raw: Mapping[str, Any], used: list[str]) -> str | None:
    value = _string(raw, TIME_KEYS, used)
    if not value:
        return None
    if len(value) == 10 and value[4] == "-" and value[7] == "-":
        return value + "T00:00:00+00:00"
    try:
        return _iso(datetime.fromisoformat(value.replace("Z", "+00:00")))
    except ValueError:
        return value


def _number(raw: Mapping[str, Any], names: Iterable[str], used: list[str]) -> float | None:
    for name in names:
        value = raw.get(name)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            used.append(name)
            return float(value)
    return None


def _string(raw: Mapping[str, Any], names: Iterable[str], used: list[str]) -> str | None:
    for name in names:
        value = raw.get(name)
        if isinstance(value, str) and value:
            used.append(name)
            return value
    return None


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
