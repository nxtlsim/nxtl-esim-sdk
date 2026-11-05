"""Reseller invoices. GET /invoices on the API lists pool top-up orders, not these bills."""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from typing import Any

from .fx import convert_fx


def build_customer_invoice(**inputs: Any) -> dict[str, Any]:
    currency = str(inputs["currency"])
    fx = inputs.get("fx")
    lines: list[dict[str, Any]] = []
    usage = inputs.get("usage")
    if usage:
        wholesale = _wholesale(usage, currency, fx)
        retail_currency = usage["totals"].get("retail_currency") or currency
        retail = _convert(float(usage["totals"]["retail"]), retail_currency, currency, fx)
        lines.append({
            "kind": "usage",
            "description": f"NXTL API charge {usage['since'][:10]} to {usage['until'][:10]}",
            "quantity": usage["totals"]["bytes"],
            "unit": "bytes",
            "wholesale": wholesale,
            "amount": wholesale,
            "currency": currency,
        })
        lines.append({
            "kind": "markup",
            "description": "Reseller markup on usage",
            "wholesale": 0.0,
            "amount": max(0.0, retail - wholesale),
            "currency": currency,
        })
    for fee in inputs.get("package_fees") or []:
        package = fee["package"]
        quantity = int(fee.get("quantity") or 1)
        lines.append({
            "kind": "package_fee",
            "description": fee.get("description") or f"Package {package['name']}",
            "quantity": quantity,
            "wholesale": 0.0,
            "amount": _convert(float(package["price"]) * quantity, package["currency"], currency, fx),
            "currency": currency,
        })
    for adjustment in inputs.get("adjustments") or []:
        lines.append({
            "kind": "adjustment",
            "description": adjustment["description"],
            "wholesale": 0.0,
            "amount": _convert(float(adjustment["amount"]), adjustment["currency"], currency, fx),
            "currency": currency,
        })
    total = sum(line["amount"] for line in lines)
    wholesale_total = sum(line["wholesale"] for line in lines)
    return {
        "id": inputs.get("id") or f"inv_{int(datetime.now(timezone.utc).timestamp())}",
        "customer_id": inputs["customer_id"],
        "currency": currency,
        "period_since": inputs["period_since"],
        "period_until": inputs["period_until"],
        "lines": lines,
        "total": total,
        "wholesale_total": wholesale_total,
        "margin": total - wholesale_total,
        "issued_at": inputs.get("issued_at") or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def build_statement(**inputs: Any) -> dict[str, Any]:
    closing = float(inputs["opening_balance"]) + float(inputs["credits"]) - float(inputs["debits"])
    lines = [f"Customer {inputs['customer_id']}", f"Opening {inputs['opening_balance']:.2f} {inputs['currency']}"]
    for invoice in inputs["invoices"]:
        lines.append(f"Invoice {invoice['id']} {invoice['total']:.2f} {invoice['currency']} margin {invoice['margin']:.2f}")
    lines.extend([
        f"Credits {float(inputs['credits']):.2f}",
        f"Debits {float(inputs['debits']):.2f}",
        f"Closing {closing:.2f} {inputs['currency']}",
    ])
    return {**inputs, "closing_balance": closing, "lines": lines}


def margin_report(invoices: Iterable[Mapping[str, Any]], currency: str) -> dict[str, Any]:
    relevant = [item for item in invoices if str(item["currency"]).upper() == currency.upper()]
    by_customer: dict[str, dict[str, float]] = {}
    for invoice in relevant:
        bucket = by_customer.setdefault(invoice["customer_id"], {"revenue": 0.0, "cost": 0.0, "margin": 0.0})
        bucket["revenue"] += float(invoice["total"])
        bucket["cost"] += float(invoice["wholesale_total"])
        bucket["margin"] += float(invoice["margin"])
    return {
        "currency": currency,
        "revenue": sum(float(item["total"]) for item in relevant),
        "cost": sum(float(item["wholesale_total"]) for item in relevant),
        "margin": sum(float(item["margin"]) for item in relevant),
        "invoice_count": len(relevant),
        "by_customer": [{"customer_id": key, **value} for key, value in by_customer.items()],
    }


def invoices_to_json(invoices: Iterable[Mapping[str, Any]]) -> str:
    return json.dumps(list(invoices), indent=2)


def invoices_to_csv(invoices: Iterable[Mapping[str, Any]]) -> str:
    header = "invoice_id,customer_id,currency,period_since,period_until,line_kind,description,wholesale,amount,invoice_total,margin"
    rows = [header]
    for invoice in invoices:
        for line in invoice["lines"]:
            rows.append(",".join([
                str(invoice["id"]),
                str(invoice["customer_id"]),
                str(invoice["currency"]),
                str(invoice["period_since"]),
                str(invoice["period_until"]),
                str(line["kind"]),
                _csv(str(line["description"])),
                f"{float(line['wholesale']):.4f}",
                f"{float(line['amount']):.4f}",
                f"{float(invoice['total']):.4f}",
                f"{float(invoice['margin']):.4f}",
            ]))
    return "\n".join(rows) + "\n"


def _wholesale(report: Mapping[str, Any], currency: str, fx: Mapping[str, Any] | None) -> float:
    totals = report["totals"]
    code = currency.upper()
    usd = float(totals["wholesale_usd"])
    eur = float(totals["wholesale_eur"])
    if code == "USD":
        return usd + (_convert(eur, "EUR", "USD", fx) if fx else 0.0)
    if code == "EUR":
        return eur + (_convert(usd, "USD", "EUR", fx) if fx else 0.0)
    return _convert(usd, "USD", currency, fx) + _convert(eur, "EUR", currency, fx)


def _convert(amount: float, from_code: str, to_code: str, fx: Mapping[str, Any] | None) -> float:
    if from_code.upper() == to_code.upper():
        return amount
    if not fx:
        raise TypeError(f"FX table required to convert {from_code} to {to_code}")
    return convert_fx(amount, from_code, to_code, fx)


def _csv(value: str) -> str:
    if any(char in value for char in '",\n'):
        return '"' + value.replace('"', '""') + '"'
    return value
