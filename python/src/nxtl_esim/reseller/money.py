"""Wallet posting policy. Debits are marked up after FX. Credits are not."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from ..pricing import quote_price
from .fx import convert_fx

CREDIT_REFUND_POLICY = (
    "A positive signed ledger amount is a credit or refund. It is converted into the wallet currency "
    "and posted as a credit of the acquisition amount. Markup is not applied. A negative signed amount "
    "is a debit: FX first, then markup. Missing FX leaves that row pending."
)


def round_half_up(value: float, decimals: int = 4) -> float:
    quantum = Decimal("1").scaleb(-decimals)
    return float(Decimal(str(value)).quantize(quantum, rounding=ROUND_HALF_UP))


def posting_for_row(row: Mapping[str, Any], **options: Any) -> dict[str, Any]:
    wallet = str(options.get("wallet_currency") or "EUR").upper()
    native = str(row.get("currency") or "").upper()
    kind = row.get("charge_kind")
    if kind in {"zero", "unspecified"}:
        return {"status": "ignored", "reason": kind}
    if native not in {"EUR", "USD"}:
        return {"status": "unresolved", "reason": "currency"}
    native_amount = abs(float(row.get("amount_usd") or 0)) if kind == "credit" and native == "USD" else (
        abs(float(row.get("amount_eur") or 0)) if kind == "credit" else float(row.get("consumption_charge") or 0)
    )
    if native_amount <= 0:
        return {"status": "ignored", "reason": "zero"}
    fx = options.get("fx")
    if native != wallet and not fx:
        return {"status": "unresolved", "reason": "missing_fx", "native_currency": native, "native_amount": native_amount}
    acquisition = round_half_up(native_amount if native == wallet or not fx else convert_fx(native_amount, native, wallet, fx))
    if kind == "credit":
        return {"status": "ready", "kind": "credit", "acquisition": acquisition, "selling": acquisition, "margin": 0.0, "currency": wallet}
    markup = dict(options.get("markup") or {"percentage": 0, "rounding": "nearest"})
    markup["currency"] = wallet
    quote = quote_price(acquisition, markup)
    selling = round_half_up(quote.retail)
    return {
        "status": "ready",
        "kind": "debit",
        "acquisition": acquisition,
        "selling": selling,
        "margin": round_half_up(selling - acquisition),
        "currency": wallet,
    }
