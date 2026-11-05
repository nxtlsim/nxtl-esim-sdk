"""Reseller markup applied locally. This does not call the API and does not convert currencies."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

RoundingMode = str


@dataclass
class PriceQuote:
    wholesale: float
    retail: float
    markup_amount: float
    rounding: str
    fx_applied: bool = False
    currency: str | None = None
    country: str | None = None
    formatted: str | None = None


def quote_price(
    wholesale: float,
    config: Mapping[str, Any],
    *,
    country: str | None = None,
    locale: str = "en_US",
) -> PriceQuote:
    if isinstance(wholesale, bool) or not isinstance(wholesale, (int, float)) or wholesale < 0:
        raise TypeError("wholesale must be a finite number >= 0")
    resolved = _resolve(config, country)
    tiers = resolved.get("tiers") or []
    mode = resolved.get("mode")
    if mode is None:
        mode = "tiered" if tiers else "percentage"
    percentage = resolved.get("percentage")
    fixed = resolved.get("fixed")
    if mode == "tiered":
        tier = _select_tier(float(wholesale), list(tiers))
        percentage = tier.get("percentage")
        fixed = tier.get("fixed")
    elif mode == "fixed":
        percentage = 0
        if fixed is None:
            raise TypeError("fixed markup requires fixed")
    elif mode == "percentage" and percentage is None and fixed is None:
        raise TypeError("percentage markup requires percentage or fixed")
    _component(percentage, "percentage")
    _component(fixed, "fixed")
    raw = float(wholesale) * (1 + float(percentage or 0) / 100) + float(fixed or 0)
    if raw < 0 or raw != raw or raw in (float("inf"), float("-inf")):
        raise ValueError("markup produced a negative or non-finite retail price")
    rounding = str(resolved.get("rounding") or "nearest")
    retail = round_price(raw, rounding)
    currency = resolved.get("currency")
    quote = PriceQuote(
        wholesale=float(wholesale),
        retail=retail,
        markup_amount=round_price(retail - float(wholesale), "nearest"),
        rounding=rounding,
        currency=str(currency) if currency else None,
        country=country.upper() if country else None,
        fx_applied=False,
    )
    if quote.currency:
        quote.formatted = format_currency(retail, quote.currency, locale)
    return quote


def format_currency(amount: float, currency: str, locale: str = "en_US") -> str:
    if isinstance(amount, bool) or not isinstance(amount, (int, float)):
        raise TypeError("amount must be a finite number")
    try:
        return _format_intl(float(amount), currency, locale)
    except (ValueError, OverflowError):
        return f"{float(amount):.2f} {currency}"


def round_price(amount: float, mode: str) -> float:
    if amount != amount or amount in (float("inf"), float("-inf")):
        raise TypeError("amount must be finite")
    if mode == "none":
        return float(amount)
    if mode == "nearest":
        return _round_half_away(amount, 2)
    if mode == "up":
        return _ceil_cents(amount)
    if mode == "down":
        return _floor_cents(amount)
    if mode == "0.99":
        return _charm(amount, 99)
    if mode == "0.95":
        return _charm(amount, 95)
    if mode == "0.00":
        return _charm(amount, 0)
    raise TypeError(f"Unknown rounding mode {mode}")


def _format_intl(amount: float, currency: str, locale: str) -> str:
    # Babel is not a dependency. Use a small locale-independent fallback that
    # still goes through a strict ISO check, then format with a symbol when known.
    if not isinstance(currency, str) or len(currency) != 3 or not currency.isalpha():
        raise ValueError("invalid currency")
    symbols = {"USD": "$", "EUR": "€", "GBP": "£"}
    symbol = symbols.get(currency.upper())
    rendered = f"{amount:,.2f}"
    if symbol and locale.lower().startswith("en"):
        return f"{symbol}{rendered}"
    return f"{rendered} {currency.upper()}"


def _resolve(config: Mapping[str, Any], country: str | None) -> dict[str, Any]:
    resolved = dict(config)
    overrides = config.get("country_overrides") or config.get("countryOverrides") or {}
    if country and isinstance(overrides, Mapping):
        match = None
        for key, value in overrides.items():
            if str(key).upper() == country.upper():
                match = value
                break
        if isinstance(match, Mapping):
            if "tiers" not in match and "tiers" in resolved:
                tiers = resolved["tiers"]
            else:
                tiers = match.get("tiers", resolved.get("tiers"))
            resolved.update(match)
            resolved["tiers"] = tiers
            resolved.pop("country_overrides", None)
            resolved.pop("countryOverrides", None)
    return resolved


def _select_tier(wholesale: float, tiers: list[Any]) -> Mapping[str, Any]:
    if not tiers:
        raise TypeError("tiered markup requires at least one tier")
    open_tier: Mapping[str, Any] | None = None
    for tier in tiers:
        if not isinstance(tier, Mapping):
            raise TypeError("tier must be a mapping")
        if tier.get("up_to", tier.get("upTo")) is None and "up_to" not in tier and "upTo" not in tier:
            # A tier object without an upper bound is the open tier only when
            # the key is present and null. Missing key falls through to <= checks.
            pass
        upper = tier["up_to"] if "up_to" in tier else tier.get("upTo", _MISSING)
        if upper is None:
            open_tier = tier
            continue
        if upper is _MISSING:
            open_tier = tier
            continue
        if wholesale <= float(upper):
            return tier
    if open_tier is not None:
        return open_tier
    last = tiers[-1]
    if not isinstance(last, Mapping):
        raise TypeError("tiered markup requires at least one tier")
    return last


class _Missing:
    pass


_MISSING = _Missing()


def _component(value: Any, name: str) -> None:
    if value is None:
        return
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{name} must be a finite number")


def _round_half_away(amount: float, decimals: int) -> float:
    factor = 10**decimals
    sign = -1 if amount < 0 else 1
    return sign * round(abs(amount) * factor + 1e-9) / factor


def _ceil_cents(amount: float) -> float:
    import math

    return math.ceil(amount * 100 - 1e-9) / 100


def _floor_cents(amount: float) -> float:
    import math

    return math.floor(amount * 100 + 1e-9) / 100


def _charm(amount: float, ending_cents: int) -> float:
    cents = int(round(amount * 100))
    mod = cents % 100
    delta = ending_cents - mod
    if delta < 0:
        delta += 100
    return (cents + delta) / 100
