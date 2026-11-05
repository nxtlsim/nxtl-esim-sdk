"""NXTL eSIM ledger charges. Not upstream wholesale cost."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone

USAGE_POLL_INTERVAL_SECONDS = 600
SUPPLIER_LAG_LOOKBACK_SECONDS = 12 * 60 * 60
THRESHOLD_EVALUATION_NOTE = (
    "line_usage_pct is UTC month-to-date ABS(amount_usd) / notes.cap_per_line_usd, as a percentage. "
    "line_usage_usd_today is UTC calendar-day ABS(amount_usd). The stored period is ignored. "
    "action suspend pauses service and does not terminate the eSIM. "
    "Current EUR usage has amount_usd 0, so these USD rules do not see that EUR charge. "
    "Rules run on the minute tick after usage polling. Default polling is 600 seconds with a 12-hour supplier-lag lookback. "
    "That is not an instantaneous cap, and usage can arrive after 12 hours."
)


def api_charge(raw: Mapping[str, object]) -> dict[str, object]:
    currency = str(raw.get("currency") or "").strip().upper()
    if currency not in {"EUR", "USD"}:
        return {"currency": currency, "signed": 0.0, "consumption_charge": 0.0, "kind": "unspecified"}
    signed = raw.get("amount_eur") if currency == "EUR" else raw.get("amount_usd")
    if not isinstance(signed, (int, float)) or isinstance(signed, bool):
        return {"currency": currency, "signed": 0.0, "consumption_charge": 0.0, "kind": "unspecified"}
    value = float(signed)
    if value < 0:
        return {"currency": currency, "signed": value, "consumption_charge": abs(value), "kind": "debit"}
    if value > 0:
        return {"currency": currency, "signed": value, "consumption_charge": 0.0, "kind": "credit"}
    return {"currency": currency, "signed": 0.0, "consumption_charge": 0.0, "kind": "zero"}


def webhook_charge(raw: Mapping[str, object]) -> dict[str, object]:
    currency = str(raw.get("currency") or "").strip().upper()
    amount = raw.get("amount")
    if currency not in {"EUR", "USD"} or not isinstance(amount, (int, float)) or isinstance(amount, bool) or float(amount) <= 0:
        return {"currency": currency, "signed": 0.0, "consumption_charge": 0.0, "kind": "unspecified"}
    value = float(amount)
    return {"currency": currency, "signed": -value, "consumption_charge": value, "kind": "debit"}


def parse_utc_timestamp(value: str) -> str:
    text = value.strip()
    if len(text) == 19 and text[10] in {" ", "T"}:
        day, clock = text[:10], text[11:]
        return f"{day}T{clock}.000Z"
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_rollup_number(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value)
        except ValueError:
            return None
    return None
