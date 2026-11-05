"""Catalog search, trip quotes, per-customer provisioning, lifecycle, and audit."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Callable

from ..flows import extract_activation, job_id_of, poll_job, poll_job_async
from ..pricing import quote_price
from .fx import convert_fx
from .units import from_bytes


def search_catalog(**query: Any) -> dict[str, Any]:
    notes: list[str] = []
    matches: list[dict[str, Any]] = []
    text = str(query["text"]).lower() if query.get("text") else None
    if query.get("region"):
        notes.append("TODO(spec): destination region records do not list member countries. Region search returns the region row only.")
    pricing = query.get("pricing") or {}
    for country in pricing.get("countries") or []:
        if query.get("country") and str(country.get("iso2", "")).upper() != str(query["country"]).upper():
            continue
        if query.get("max_eur_per_gb") is not None and float(country["cheapest_eur_per_gb"]) > float(query["max_eur_per_gb"]):
            continue
        if text and text not in f"{country.get('iso2', '')} {country.get('name', '')}".lower():
            continue
        matches.append({"kind": "pricing", "id": country["iso2"], "name": country["name"], "eur_per_gb": country["cheapest_eur_per_gb"], "detail": dict(country)})
    destinations = (query.get("destinations") or {}).get("destinations") or []
    for destination in destinations:
        if query.get("region"):
            if destination.get("type") != "region":
                continue
            blob = f"{destination.get('slug', '')} {destination.get('title', '')}".lower()
            if str(query["region"]).lower() not in blob:
                continue
        if query.get("country") and str(destination.get("iso2", "")).upper() != str(query["country"]).upper():
            continue
        if text and text not in f"{destination.get('title', '')} {destination.get('slug', '')} {destination.get('iso2', '')}".lower():
            continue
        matches.append({"kind": "destination", "id": destination.get("slug") or destination.get("iso2"), "name": destination.get("title"), "detail": dict(destination)})
    return {"matches": matches, "notes": notes}


def quote_trip(**inputs: Any) -> dict[str, Any]:
    notes = ["This quote prices published per-GB rates. It is not POST /esims/estimate. Pass issuance_fee from that call or from GET /quotas when you want the profile fee included."]
    if inputs.get("segments"):
        segments = list(inputs["segments"])
    elif inputs.get("countries") is not None and inputs.get("estimated_gb") is not None:
        countries = list(inputs["countries"])
        split = inputs.get("split") or "even"
        gb = float(inputs["estimated_gb"]) if split == "each" else float(inputs["estimated_gb"]) / len(countries)
        segments = [{"country": country, "gb": gb} for country in countries]
    else:
        raise TypeError("Provide segments or countries plus estimated_gb")
    currency = str(inputs.get("present_currency") or (inputs.get("markup") or {}).get("currency") or "EUR")
    pricing = inputs["pricing"]
    fx = inputs.get("fx")
    priced = []
    for segment in segments:
        row = next((item for item in pricing["countries"] if str(item["iso2"]).upper() == str(segment["country"]).upper()), None)
        if row is None:
            raise RuntimeError(f"No public pricing row for {segment['country']}")
        wholesale_eur = float(segment["gb"]) * float(row["cheapest_eur_per_gb"])
        if currency.upper() != "EUR" and not fx:
            raise TypeError("FX table required when the present currency is not EUR")
        wholesale = wholesale_eur if currency.upper() == "EUR" else convert_fx(wholesale_eur, "EUR", currency, fx)
        markup = dict(inputs.get("markup") or {"percentage": 0, "rounding": "nearest"})
        markup["currency"] = currency
        retail = quote_price(wholesale, markup, country=str(segment["country"])).retail
        priced.append({**segment, "eur_per_gb": row["cheapest_eur_per_gb"], "wholesale_eur": wholesale_eur, "retail": retail})
    wholesale_eur = sum(item["wholesale_eur"] for item in priced)
    retail = sum(item["retail"] for item in priced)
    issuance = None
    if inputs.get("issuance_fee") is not None:
        fee_currency = str(inputs.get("issuance_currency") or "USD")
        issuance = float(inputs["issuance_fee"]) if fee_currency.upper() == currency.upper() or not fx else convert_fx(float(inputs["issuance_fee"]), fee_currency, currency, fx)
        retail += quote_price(issuance, {"percentage": 0, "rounding": markup.get("rounding", "nearest"), "currency": currency}).retail
    wholesale_present = wholesale_eur if currency.upper() == "EUR" or not fx else convert_fx(wholesale_eur, "EUR", currency, fx)
    result = {
        "segments": priced,
        "wholesale_eur": wholesale_eur,
        "retail": retail,
        "currency": currency,
        "margin": retail - wholesale_present - (issuance or 0),
        "notes": notes,
    }
    if issuance is not None:
        result["issuance_fee"] = issuance
    return result


def provision_customers(client: Any, directory: Any, rows: Iterable[Mapping[str, Any]], wait: bool = False, **poll: Any) -> list[dict[str, Any]]:
    """One POST /esims per customer. Bulk issue shares a single client_reference."""

    results = []
    for row in rows:
        try:
            body = {"client_reference": row.get("client_reference") or row["customer_id"]}
            if row.get("nickname"):
                body["nickname"] = row["nickname"]
            if row.get("tier"):
                body["tier"] = row["tier"]
            options = {"idempotency_key": row["idempotency_key"]} if row.get("idempotency_key") else None
            accepted = client.issue_esim(body, options=options)
            job_id = job_id_of(accepted.data)
            iccid = None
            if wait and job_id:
                job = poll_job(client, job_id, interval=poll.get("interval", 0.01), timeout=poll.get("timeout", 5), sleep=poll.get("sleep"))
                iccid = extract_activation(job.data).get("iccid")
                if iccid:
                    directory.assign_line(row["customer_id"], iccid)
            item: dict[str, Any] = {"customer_id": row["customer_id"], "ok": True}
            if job_id:
                item["job_id"] = job_id
            if iccid:
                item["iccid"] = iccid
            results.append(item)
        except Exception as exc:  # noqa: BLE001
            results.append({"customer_id": row["customer_id"], "ok": False, "error": str(exc)})
    return results


async def provision_customers_async(client: Any, directory: Any, rows: Iterable[Mapping[str, Any]], wait: bool = False) -> list[dict[str, Any]]:
    results = []
    for row in rows:
        try:
            body = {"client_reference": row.get("client_reference") or row["customer_id"]}
            if row.get("tier"):
                body["tier"] = row["tier"]
            options = {"idempotency_key": row["idempotency_key"]} if row.get("idempotency_key") else None
            accepted = await client.issue_esim(body, options=options)
            job_id = job_id_of(accepted.data)
            iccid = None
            if wait and job_id:
                job = await poll_job_async(client, job_id, interval=0.01, timeout=5, sleep=lambda _s: None)
                iccid = extract_activation(job.data).get("iccid")
                if iccid:
                    directory.assign_line(row["customer_id"], iccid)
            item = {"customer_id": row["customer_id"], "ok": True}
            if job_id:
                item["job_id"] = job_id
            if iccid:
                item["iccid"] = iccid
            results.append(item)
        except Exception as exc:  # noqa: BLE001
            results.append({"customer_id": row["customer_id"], "ok": False, "error": str(exc)})
    return results


class LineLifecycle:
    """API line operations. There is no DELETE and no per-line top-up."""

    def __init__(self, client: Any) -> None:
        self.client = client

    def issue(self, body: Mapping[str, Any] | None = None, **options: Any) -> Any:
        return self.client.issue_esim(body, options=options or None)

    def status(self, iccid: str) -> Any:
        return self.client.get_esim(iccid)

    def suspend(self, iccid: str) -> Any:
        return self.client.suspend_esim(iccid)

    def resume(self, iccid: str) -> Any:
        return self.client.resume_esim(iccid)

    def terminate(self, iccid: str) -> Any:
        return self.client.update_status(iccid, {"action": "terminate"})

    def wallet(self, iccid: str) -> Any:
        return self.client.get_wallet(iccid)

    def events(self, iccid: str) -> Any:
        return self.client.get_esim_events(iccid)

    def pool_topup(self, amount_usd: float, idempotency_key: str | None = None) -> Any:
        options = {"idempotency_key": idempotency_key} if idempotency_key else None
        return self.client.topup({"amount_usd": amount_usd}, options=options)


def read_audit(client: Any, on_entry: Callable[[Mapping[str, Any]], None], **filters: Any) -> int:
    count = 0
    for entry in client.iterate_audit(**filters):
        on_entry(entry)
        count += 1
    return count


def gb(num_bytes: float) -> float:
    return from_bytes(num_bytes)["gb"]
