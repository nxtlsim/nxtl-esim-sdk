"""Local checks for constraints published in the OpenAPI document."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import quote

TIERS = {"cheapest", "best_coverage", "standard"}
ACTIONS = {"suspend", "reactivate", "terminate"}
METRICS = {"balance_below", "line_usage_pct", "line_usage_usd_today"}
SCOPES = {"balance", "esim", "line"}
OPERATORS = {"<", "<=", "=", ">=", ">"}
PERIODS = {"instant", "daily", "weekly", "monthly"}
THRESHOLD_ACTIONS = {"notify", "suspend"}
STATUSES = {"pre_service", "ready", "suspended", "terminated"}


def omit_none(values: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None}


def encode_path(value: Any) -> str:
    return quote(str(value), safe="")


def validate_iccid(iccid: str) -> str:
    if not isinstance(iccid, str) or not 18 <= len(iccid) <= 22:
        raise ValueError("iccid must be a string of 18 to 22 characters")
    return iccid


def validate_iccids(iccids: list[str], maximum: int) -> list[str]:
    if not isinstance(iccids, list) or not 1 <= len(iccids) <= maximum:
        raise ValueError(f"iccids must contain 1 to {maximum} entries")
    return [validate_iccid(item) for item in iccids]


def validate_quantity(quantity: int) -> int:
    if not isinstance(quantity, int) or isinstance(quantity, bool) or not 1 <= quantity <= 1000:
        raise ValueError("quantity must be an integer from 1 to 1000")
    return quantity


def validate_amount_usd(amount: float) -> float:
    if isinstance(amount, bool) or not isinstance(amount, (int, float)) or amount < 0.01:
        raise ValueError("amount_usd must be a number >= 0.01")
    return float(amount)


def validate_nickname(nickname: str) -> str:
    if not isinstance(nickname, str) or len(nickname) > 80:
        raise ValueError("nickname must be a string of at most 80 characters")
    return nickname


def validate_tier(tier: str) -> str:
    if tier not in TIERS:
        raise ValueError("tier must be cheapest, best_coverage, or the standard alias")
    return tier


def validate_action(action: str) -> str:
    if action not in ACTIONS:
        raise ValueError("action must be suspend, reactivate, or terminate")
    return action


def validate_status(status: str) -> str:
    if status not in STATUSES:
        raise ValueError("status must be pre_service, ready, suspended, or terminated")
    return status


def validate_page(page: int | None, per_page: int | None, per_page_max: int | None = None) -> None:
    if page is not None and (isinstance(page, bool) or not isinstance(page, int) or page < 1):
        raise ValueError("page must be an integer >= 1")
    if per_page is not None:
        if isinstance(per_page, bool) or not isinstance(per_page, int) or per_page < 1:
            raise ValueError("per_page must be an integer >= 1")
        if per_page_max is not None and per_page > per_page_max:
            raise ValueError(f"per_page must be an integer from 1 to {per_page_max}")


def validate_idempotency_key(key: str) -> str:
    if not isinstance(key, str) or not 1 <= len(key) <= 128:
        raise ValueError("Idempotency-Key must be 1 to 128 characters")
    return key


def validate_integer_id(value: Any, name: str) -> str:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a non-negative integer")
    if isinstance(value, int) and value >= 0:
        return str(value)
    if isinstance(value, str) and value.isdigit():
        return value
    raise ValueError(f"{name} must be a non-negative integer")


def validate_days(days: int, maximum: int | None = None) -> int:
    if isinstance(days, bool) or not isinstance(days, int) or days < 1:
        raise ValueError("days must be an integer >= 1")
    if maximum is not None and days > maximum:
        raise ValueError(f"days must be an integer from 1 to {maximum}")
    return days


def validate_limit(limit: int, maximum: int = 500) -> int:
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= maximum:
        raise ValueError(f"limit must be an integer from 1 to {maximum}")
    return limit


def validate_threshold(body: Mapping[str, Any]) -> None:
    metric = body.get("metric")
    if metric not in METRICS:
        raise ValueError("metric must be one of " + ", ".join(sorted(METRICS)))
    value = body.get("threshold_value")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("threshold_value must be a finite number")
    scope = body.get("scope")
    if scope is not None and scope not in SCOPES:
        raise ValueError("scope must be one of balance, esim, line")
    operator = body.get("operator")
    if operator is not None and operator not in OPERATORS:
        raise ValueError("operator must be one of <, <=, =, >=, >")
    period = body.get("period")
    if period is not None and period not in PERIODS:
        raise ValueError("period must be one of instant, daily, weekly, monthly")
    action = body.get("action")
    if action is not None and action not in THRESHOLD_ACTIONS:
        raise ValueError("action must be notify or suspend")


def validate_key_public(value: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("key_public is required")
    return value
