"""Reseller-supplied FX. The NXTL eSIM API does not convert currencies.

``rates[CODE]`` is how many units of ``base`` equal 1 unit of CODE.
"""

from __future__ import annotations

from collections.abc import Mapping


def convert_fx(amount: float, from_code: str, to_code: str, fx: Mapping[str, object]) -> float:
    return (amount * _rate(fx, from_code)) / _rate(fx, to_code)


def _rate(fx: Mapping[str, object], currency: str) -> float:
    base = str(fx["base"])
    if currency.upper() == base.upper():
        return 1.0
    rates = fx.get("rates") or {}
    if not isinstance(rates, Mapping):
        raise TypeError("fx.rates must be a mapping")
    raw = rates.get(currency.upper(), rates.get(currency))
    if not isinstance(raw, (int, float)) or isinstance(raw, bool) or raw <= 0:
        raise TypeError(f"Missing reseller FX rate for {currency.upper()} (base {base})")
    return float(raw)


def format_money(amount: float, currency: str, present: str | None = None, fx: Mapping[str, object] | None = None) -> dict[str, object]:
    target = present or currency
    converted = amount if currency.upper() == target.upper() or fx is None else convert_fx(amount, currency, target, fx)
    code = target if fx and currency.upper() != target.upper() else currency
    return {"amount": converted, "currency": code, "formatted": f"{converted:.2f} {code}"}
