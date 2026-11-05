"""Reseller helpers built on documented API calls.

Activation strings are copied only when the job or webhook JSON already
contains them. A 202 response is not a provisioned profile.

TODO(spec): job status strings, per-row results, and activation fields are
not published in the OpenAPI schemas.
"""

from __future__ import annotations

import time
from typing import Any

from .errors import NxtlInsufficientBalanceError, NxtlJobFailedError, NxtlTimeoutError
from .models import ApiResponse, JsonObject
from .pagination import extract_items
from .transport import read_object

TERMINAL_JOB_STATUSES = {
    "complete",
    "completed",
    "success",
    "succeeded",
    "done",
    "failed",
    "failure",
    "error",
    "cancelled",
    "canceled",
    "partial",
    "partial_failure",
}

# TODO(spec): GET /balance has no schema. available_usd appears in the
# insufficient-balance error example, not as a balance-response field.
BALANCE_AMOUNT_CANDIDATE_KEYS = (
    "balance_usd",
    "available_usd",
    "available_balance_usd",
    "pooled_balance_usd",
    "pool_balance_usd",
    "balance",
)

# TODO(spec): GET /quotas has no schema. These names are guesses from the summary.
ISSUANCE_FEE_CANDIDATE_KEYS = ("issuance_fee_usd", "issuance_fee", "fee_usd")


def job_id_of(payload: Any) -> str | None:
    body = read_object(payload)
    value = body.get("job_id", body.get("jobId", body.get("id")))
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str) and value:
        return value
    return None


def job_status_of(payload: Any) -> str | None:
    body = read_object(payload)
    value = body.get("status", body.get("state"))
    return value if isinstance(value, str) else None


def job_is_terminal(payload: Any) -> bool:
    status = job_status_of(payload)
    return bool(status) and status.lower() in TERMINAL_JOB_STATUSES


def job_is_failed(payload: Any) -> bool:
    status = (job_status_of(payload) or "").lower()
    return "fail" in status or status in {"error", "cancelled", "canceled"}


def poll_job(
    client: Any,
    job_id: Any,
    *,
    interval: float = 2.0,
    timeout: float = 120.0,
    sleep: Any = None,
) -> ApiResponse[JsonObject]:
    sleeper = sleep or time.sleep
    started = time.monotonic()
    latest = client.get_job(job_id)
    while not job_is_terminal(latest.data):
        if time.monotonic() - started >= timeout:
            raise NxtlTimeoutError(
                f"Job {job_id} was not terminal after {timeout}s",
                status_code=0,
                code="job_timeout",
                body=latest.data,
            )
        sleeper(interval)
        latest = client.get_job(job_id)
    return latest


async def poll_job_async(
    client: Any,
    job_id: Any,
    *,
    interval: float = 2.0,
    timeout: float = 120.0,
    sleep: Any = None,
) -> ApiResponse[JsonObject]:
    import asyncio

    started = time.monotonic()
    latest = await client.get_job(job_id)
    while not job_is_terminal(latest.data):
        if time.monotonic() - started >= timeout:
            raise NxtlTimeoutError(
                f"Job {job_id} was not terminal after {timeout}s",
                status_code=0,
                code="job_timeout",
                body=latest.data,
            )
        if sleep is None:
            await asyncio.sleep(interval)
        else:
            result = sleep(interval)
            if hasattr(result, "__await__"):
                await result
        latest = await client.get_job(job_id)
    return latest


def fulfil_esim_order(
    client: Any,
    *,
    client_reference: str,
    nickname: str | None = None,
    tier: str | None = None,
    idempotency_key: str | None = None,
    estimate: bool = True,
    throw_on_failed: bool = True,
    interval: float = 2.0,
    timeout: float = 120.0,
    sleep: Any = None,
) -> dict[str, Any]:
    if not client_reference:
        raise ValueError("client_reference is required")
    estimate_response = None
    if estimate:
        body: dict[str, Any] = {"quantity": 1}
        if tier is not None:
            body["tier"] = tier
        estimate_response = client.estimate(body)
        if read_object(estimate_response.data).get("affordable") is False:
            raise NxtlInsufficientBalanceError(
                "POST /esims/estimate reported affordable: false",
                status_code=estimate_response.status_code,
                body=estimate_response.data,
                headers=estimate_response.headers,
                request_id=estimate_response.request_id,
            )
    issue: dict[str, Any] = {"client_reference": client_reference}
    if nickname is not None:
        issue["nickname"] = nickname
    if tier is not None:
        issue["tier"] = tier
    options = {"idempotency_key": idempotency_key} if idempotency_key else None
    accepted = client.issue_esim(issue, options=options)
    job_id = job_id_of(accepted.data)
    if not job_id:
        raise NxtlJobFailedError("POST /esims did not include job_id", accepted.data)
    job = poll_job(client, job_id, interval=interval, timeout=timeout, sleep=sleep)
    if throw_on_failed and job_is_failed(job.data):
        raise NxtlJobFailedError(f"Job {job_id} failed", job.data)
    result = {"accepted": accepted, "job": job, "activation": extract_activation(job.data)}
    if estimate_response is not None:
        result["estimate"] = estimate_response
    return result


async def fulfil_esim_order_async(client: Any, **kwargs: Any) -> dict[str, Any]:
    client_reference = kwargs.get("client_reference")
    if not client_reference:
        raise ValueError("client_reference is required")
    nickname = kwargs.get("nickname")
    tier = kwargs.get("tier")
    idempotency_key = kwargs.get("idempotency_key")
    estimate = kwargs.get("estimate", True)
    throw_on_failed = kwargs.get("throw_on_failed", True)
    interval = kwargs.get("interval", 2.0)
    timeout = kwargs.get("timeout", 120.0)
    sleep = kwargs.get("sleep")
    estimate_response = None
    if estimate:
        body: dict[str, Any] = {"quantity": 1}
        if tier is not None:
            body["tier"] = tier
        estimate_response = await client.estimate(body)
        if read_object(estimate_response.data).get("affordable") is False:
            raise NxtlInsufficientBalanceError(
                "POST /esims/estimate reported affordable: false",
                status_code=estimate_response.status_code,
                body=estimate_response.data,
                headers=estimate_response.headers,
                request_id=estimate_response.request_id,
            )
    issue: dict[str, Any] = {"client_reference": client_reference}
    if nickname is not None:
        issue["nickname"] = nickname
    if tier is not None:
        issue["tier"] = tier
    options = {"idempotency_key": idempotency_key} if idempotency_key else None
    accepted = await client.issue_esim(issue, options=options)
    job_id = job_id_of(accepted.data)
    if not job_id:
        raise NxtlJobFailedError("POST /esims did not include job_id", accepted.data)
    job = await poll_job_async(client, job_id, interval=interval, timeout=timeout, sleep=sleep)
    if throw_on_failed and job_is_failed(job.data):
        raise NxtlJobFailedError(f"Job {job_id} failed", job.data)
    result = {"accepted": accepted, "job": job, "activation": extract_activation(job.data)}
    if estimate_response is not None:
        result["estimate"] = estimate_response
    return result


def submit_and_collect_bulk_issue(client: Any, body: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    options = {"idempotency_key": kwargs["idempotency_key"]} if kwargs.get("idempotency_key") else None
    accepted = client.bulk_issue(body, options=options)
    job_id = job_id_of(accepted.data)
    if not job_id:
        raise NxtlJobFailedError("POST /esims/bulk-issue did not include job_id", accepted.data)
    job = poll_job(
        client,
        job_id,
        interval=kwargs.get("interval", 2.0),
        timeout=kwargs.get("timeout", 120.0),
        sleep=kwargs.get("sleep"),
    )
    if kwargs.get("throw_on_failed", True) and job_is_failed(job.data):
        raise NxtlJobFailedError(f"Bulk job {job_id} failed", job.data)
    return {"accepted": accepted, "job": job, "rows": extract_job_rows(job.data)}


def extract_job_rows(payload: Any) -> list[JsonObject]:
    body = read_object(payload)
    for key in ("results", "rows", "items", "esims", "lines"):
        value = body.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return extract_items(body)


def extract_activation(payload: Any) -> dict[str, Any]:
    found: dict[str, Any] = {"matched_keys": []}
    _walk(payload, "", found)
    return found


def _walk(value: Any, key: str, found: dict[str, Any]) -> None:
    if isinstance(value, str):
        _consider(key, value, found)
        return
    if isinstance(value, list):
        for item in value:
            _walk(item, key, found)
        return
    if isinstance(value, dict):
        for child_key, child in value.items():
            _walk(child, str(child_key), found)


def _consider(key: str, value: str, found: dict[str, Any]) -> None:
    import re

    normalized = re.sub(r"[^a-z0-9]+", "", key.lower())
    if "lpa" not in found and value.startswith("LPA:"):
        found["lpa"] = value
        found["matched_keys"].append(key or "lpa")
    if "qr" not in found and "qr" in normalized and value:
        found["qr"] = value
        found["matched_keys"].append(key)
    if "iccid" not in found and (normalized == "iccid" or normalized.endswith("iccid")):
        found["iccid"] = value
        found["matched_keys"].append(key)
    if "smdp_address" not in found and "smdp" in normalized:
        found["smdp_address"] = value
        found["matched_keys"].append(key)
    if "matching_id" not in found and "matchingid" in normalized:
        found["matching_id"] = value
        found["matched_keys"].append(key)
    if "activation_code" not in found and "activationcode" in normalized and not value.startswith("LPA:"):
        found["activation_code"] = value
        found["matched_keys"].append(key)


def assess_balance(
    client: Any,
    *,
    low_usd: float | None = None,
    exhausted_usd: float = 0,
) -> dict[str, Any]:
    response = client.get_balance()
    located = _find_number(response.data, BALANCE_AMOUNT_CANDIDATE_KEYS)
    currency = _find_string(response.data, ("currency",))
    status = "unknown"
    if located is not None:
        if located[0] <= exhausted_usd:
            status = "exhausted"
        elif low_usd is not None and located[0] <= low_usd:
            status = "low"
        else:
            status = "ok"
    return {
        "response": response,
        "amount_usd": None if located is None else located[0],
        "candidate_key": None if located is None else located[1],
        "currency": currency,
        "status": status,
        "low_usd": low_usd,
        "exhausted_usd": exhausted_usd,
    }


def ensure_balance_threshold(client: Any, *, threshold_value: float, **overrides: Any) -> ApiResponse[JsonObject]:
    body = {
        "metric": overrides.pop("metric", "balance_below"),
        "threshold_value": threshold_value,
        "scope": overrides.pop("scope", "balance"),
        "operator": overrides.pop("operator", "<="),
        "period": overrides.pop("period", "instant"),
        "action": overrides.pop("action", "notify"),
        "enabled": overrides.pop("enabled", True),
    }
    if "notes" in overrides:
        body["notes"] = overrides["notes"]
    return client.create_threshold(body)


def collect_usage(client: Any, **query: Any) -> dict[str, Any]:
    summary = client.usage_summary(days=query.get("days")) if query.get("days") is not None else client.usage_summary()
    timeseries = (
        client.usage_timeseries(days=query.get("days")) if query.get("days") is not None else client.usage_timeseries()
    )
    esim_kwargs = {key: query[key] for key in ("since", "until", "iccid") if query.get(key) is not None}
    esims = client.usage_esims(**esim_kwargs)
    report: dict[str, Any] = {"summary": summary, "timeseries": timeseries, "esims": esims}
    if query.get("include_cdrs"):
        cdr_kwargs = {key: query[key] for key in ("since", "until", "iccid") if query.get(key) is not None}
        cdr_kwargs["per_page"] = query.get("cdr_per_page", 100)
        rows = list(client.iterate_usage_cdrs(max_pages=query.get("max_cdr_pages", 20), **cdr_kwargs))
        report["cdrs"] = rows
        report["totals"] = sum_usage_amounts(rows)
    return report


def sum_usage_amounts(rows: list[JsonObject]) -> dict[str, Any]:
    """Sum amount_usd and amount_eur when present.

    TODO(spec): CDR items are not schematized. The human reference says a zero
    converted amount must not be read as free usage.
    """

    totals = {
        "rows": len(rows),
        "amount_usd": 0.0,
        "amount_eur": 0.0,
        "rows_with_usd": 0,
        "rows_with_eur": 0,
        "zero_is_not_free": False,
    }
    for row in rows:
        usd = row.get("amount_usd") if isinstance(row.get("amount_usd"), (int, float)) else None
        eur = row.get("amount_eur") if isinstance(row.get("amount_eur"), (int, float)) else None
        if isinstance(usd, bool):
            usd = None
        if isinstance(eur, bool):
            eur = None
        if usd is not None:
            totals["amount_usd"] += float(usd)
            totals["rows_with_usd"] += 1
        if eur is not None:
            totals["amount_eur"] += float(eur)
            totals["rows_with_eur"] += 1
        if (usd == 0 and eur not in (None, 0)) or (eur == 0 and usd not in (None, 0)):
            totals["zero_is_not_free"] = True
    return totals


def read_issuance_fee(quotas: Any) -> tuple[float, str] | None:
    return _find_number(quotas, ISSUANCE_FEE_CANDIDATE_KEYS)


def _find_number(payload: Any, keys: tuple[str, ...]) -> tuple[float, str] | None:
    wanted = set(keys)
    found: tuple[float, str] | None = None

    def visit(value: Any) -> None:
        nonlocal found
        if found is not None or not isinstance(value, dict):
            return
        for key, child in value.items():
            if key in wanted and isinstance(child, (int, float)) and not isinstance(child, bool):
                found = (float(child), key)
                return
        for child in value.values():
            if isinstance(child, dict):
                visit(child)
            if found is not None:
                return

    visit(payload)
    return found


def _find_string(payload: Any, keys: tuple[str, ...]) -> str | None:
    if not isinstance(payload, dict):
        return None
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    for value in payload.values():
        if isinstance(value, dict):
            nested = _find_string(value, keys)
            if nested:
                return nested
    return None
