# nxtl-esim

Python SDK for the [NXTL eSIM](https://nxtlsim.com) B2B API. Issue and manage pay-as-you-go travel eSIMs, read the pooled balance, and verify signed webhooks.

Create a business account and API key at [NXTL for Business](https://nxtlsim.com/for-business/). Operation details are in the [API reference](https://nxtlsim.com/nxtl-api-reference/). This package tracks OpenAPI **2.6.1** (48 operations) at `https://nxtlsim.com/api/v1`.

```bash
pip install nxtl-esim
```

Python 3.9 or newer. The only runtime dependency is `httpx`. Sync and async clients share one operation surface.

## Quick start

```python
import os
from nxtl_esim import NxtlClient, fulfil_esim_order

with NxtlClient(os.environ["NXTL_API_KEY"]) as nxtl:
    nxtl.health()
    nxtl.partner()
    order = fulfil_esim_order(
        nxtl,
        client_reference="ORDER-123",
        nickname="Traveller 123",
        tier="cheapest",
        idempotency_key="order-123-esim",
    )
    print(order["activation"].get("lpa"))
```

Async:

```python
import os
from nxtl_esim import AsyncNxtlClient, fulfil_esim_order_async

async with AsyncNxtlClient(os.environ["NXTL_API_KEY"]) as nxtl:
    order = await fulfil_esim_order_async(
        nxtl,
        client_reference="ORDER-123",
        nickname="Traveller 123",
        tier="cheapest",
        idempotency_key="order-123-esim",
    )
```

`POST /esims` returns 202 and a `job_id`. The helper estimates, queues the eSIM, and polls `GET /jobs/{id}`. Do not treat the 202 body as a provisioned profile.

`tier` is `cheapest` or `best_coverage`. The alias `standard` is accepted by the API and stored as `cheapest`.

## Client options

Timeouts and retry delays are **seconds**.

```python
NxtlClient(
    api_key,                                  # omitted only for GET /health
    base_url="https://nxtlsim.com/api/v1",
    timeout=30.0,                             # seconds
    http_client=None,                         # your httpx.Client; not closed by the SDK
    user_agent="nxtl-esim/0.1.0 (+https://nxtlsim.com)",
    logger=None,                              # object with debug/info/warn/error
    retry=None,                               # mapping, or False to disable
    headers=None,                             # extra headers; X-NXTL-Key still comes from api_key
    idempotency_header="Idempotency-Key",     # or "X-NXTL-Idempotency-Key"
    auto_idempotency_key=True,                # POST /esims, /esims/bulk-issue, /topup
    accept_currency=None,                     # TODO(spec): human reference only, not in OpenAPI
)
```

`AsyncNxtlClient` takes the same arguments and an `httpx.AsyncClient`. Redirects are not followed, so the API key is not sent to another host. Pass a client you already configured if you need different transport behaviour.

Per-call `options` mapping: `idempotency_key`, `headers`, `timeout` (seconds), `retry`.

### Retries

HTTP 429 is retried. HTTP 5xx and transport errors are retried for GET, HEAD, PUT, and DELETE, and for any call that sent an idempotency key. Other POST and PATCH calls are not retried on 5xx unless `retry_unsafe` is true.

Delay is full jitter between 0 and `min(max_delay, base_delay * 2^attempt)`. `Retry-After` is a minimum, capped by `max_retry_after` (default 120 seconds).

| Retry key | Default | Unit |
| --- | --- | --- |
| `max_retries` | 2 | extra attempts |
| `base_delay` | 0.2 | seconds |
| `max_delay` | 8 | seconds |
| `max_retry_after` | 120 | seconds |
| `retry_unsafe` | false | |
| `sleep` | `time.sleep` or `asyncio.sleep` | |
| `random` | `random.random` | `[0, 1)` |

### Responses

Methods return `ApiResponse`: `data`, `status_code`, `headers`, `request_id`, `idempotent_replayed`, `rate_limit`, `idempotency_key`.

`request(method, path, query=..., json_body=..., options=...)` is the escape hatch.

Published constraints (`iccid` length, `quantity`, `amount_usd`, nickname length, tier, threshold enums) raise `ValueError` before a request is sent.

## Errors

| Class | When |
| --- | --- |
| `NxtlAuthError` | 401, or a missing API key |
| `NxtlAccessDeniedError` | 403 |
| `NxtlValidationError` | 400 |
| `NxtlInsufficientBalanceError` | 402 |
| `NxtlNotFoundError` | 404 |
| `NxtlConflictError` | 409 |
| `NxtlQuotaExceededError` | 409 `quota_exhausted` |
| `NxtlRateLimitError` | 429 |
| `NxtlServerError` | 5xx |
| `NxtlConnectionError` / `NxtlTimeoutError` | transport / timeout |
| `NxtlJobFailedError` | polled job failed |
| `NxtlWebhookError` | signature or envelope rejected |

Attributes: `status_code`, `code`, `error_type`, `request_id`, `doc_url`, `details`, `headers`, `body`, `retry_after`. Keep `request_id` for support at `support@nxtlsim.com`.

## Operations

| Method | HTTP |
| --- | --- |
| `health` | `GET /health` |
| `partner` | `GET /partner` |
| `quotas` | `GET /quotas` |
| `audit` / `iterate_audit` | `GET /audit` |
| `list_esims` / `iterate_esims` | `GET /esims` |
| `issue_esim` | `POST /esims` (idempotent) |
| `list_lines` / `iterate_lines` | `GET /lines` (legacy) |
| `get_esim` | `GET /esims/{iccid}` |
| `update_nickname` | `PATCH /esims/{iccid}/nickname` |
| `update_tier` | `PATCH /esims/{iccid}/tier` |
| `update_status` | `PATCH /esims/{iccid}/status` |
| `suspend_esim` | `POST /esims/{iccid}/suspend` |
| `resume_esim` | `POST /esims/{iccid}/resume` |
| `get_wallet` | `GET /esims/{iccid}/wallet` |
| `get_esim_usage` | `GET /esims/{iccid}/usage` |
| `get_esim_events` | `GET /esims/{iccid}/events` |
| `bulk_status` | `POST /esims/bulk-status` (max 100) |
| `bulk_tier` | `POST /esims/bulk-tier` (max 1000) |
| `bulk_issue` | `POST /esims/bulk-issue` (idempotent) |
| `estimate` | `POST /esims/estimate` |
| `list_jobs` | `GET /jobs` |
| `get_job` | `GET /jobs/{id}` |
| `get_esim_request` | `GET /esim-requests/{job_id}` (legacy) |
| `get_balance` | `GET /balance` |
| `list_balance_history` / `iterate_balance_history` | `GET /balance/history` |
| `topup` | `POST /topup` (idempotent, prepaid budget, no card charge) |
| `list_invoices` | `GET /invoices` |
| `usage_summary` | `GET /usage/summary` |
| `usage_esims` | `GET /usage/esims` |
| `usage_lines` | `GET /usage/lines` (legacy, no query params in the spec) |
| `usage_cdrs` / `iterate_usage_cdrs` | `GET /usage/cdrs` |
| `usage_timeseries` | `GET /usage/timeseries` |
| `list_api_keys` | `GET /api-keys` |
| `create_api_key` | `POST /api-keys` (secret once) |
| `revoke_api_key` | `DELETE /api-keys/{key_public}` |
| `get_webhooks` | `GET /webhooks` |
| `update_webhooks` | `PUT /webhooks` |
| `list_webhook_events` | `GET /webhooks/events` |
| `get_webhook_secret` | `GET /webhooks/secret` |
| `test_webhook` | `POST /webhooks/test` |
| `list_webhook_deliveries` / `iterate_webhook_deliveries` | `GET /webhooks/deliveries` |
| `get_webhook_delivery` | `GET /webhooks/deliveries/{id}` |
| `replay_webhook_delivery` | `POST /webhooks/deliveries/{id}/replay` |
| `replay_webhook_delivery_legacy` | `POST /webhooks/{id}/replay` |
| `list_thresholds` | `GET /thresholds` |
| `create_threshold` | `POST /thresholds` |
| `update_threshold` | `PATCH /thresholds/{id}` |
| `delete_threshold` | `DELETE /thresholds/{id}` |

`API_OPERATIONS` exports the same 48 entries. Scope names from the API reference (`esims:read`, `esims:write`, `balance:read`, `balance:write`, `keys:read`, `keys:write`, `webhooks:read`, `webhooks:write`, `thresholds:read`, `thresholds:write`, `audit:read`, `usage:read`) are enforced by the server.

Async methods have the same names and are awaited: `await client.issue_esim(...)`. Async iterators are `iterate_esims`, `iterate_lines`, `iterate_audit`, `iterate_balance_history`, `iterate_usage_cdrs`, and `iterate_webhook_deliveries`.

## Webhooks

```python
from nxtl_esim import construct_webhook_event, SIGNATURE_HEADER

event = construct_webhook_event(
    payload=raw_body,  # bytes or the exact UTF-8 string
    signature_header=headers[SIGNATURE_HEADER],
    secret=[active_secret, rotating_secret],
    tolerance_seconds=300,  # 0 skips the timestamp check
)
```

`verify_webhook_signature` returns a bool. `parse_webhook_event` requires `id`, `event`, integer `timestamp`, and object `data`. `WEBHOOK_EVENT_NAMES` lists the 15 names in the human reference. The schema types `event` as a string, so other names still parse. Read the live catalog with `list_webhook_events()`.

The signature is HMAC-SHA256 of `{timestamp}.{raw_body}` as described in the API reference. The OpenAPI text names the header and the algorithm.

## Reseller helpers

Markup runs locally. It does not call the API and does not convert currencies (`fx_applied` is always false). Public feed rates are EUR per GB. Issuance cost against the pooled balance comes from `estimate` and `quotas`.

```python
from nxtl_esim import quote_price, format_currency, PublicCatalog

quote = quote_price(
    2.5,
    {
        "mode": "tiered",  # percentage, fixed, or tiered
        "percentage": 30,
        "fixed": 0.5,
        "rounding": "0.99",  # none, nearest, up, down, 0.99, 0.95, 0.00
        "currency": "EUR",
        "tiers": [
            {"up_to": 5, "percentage": 40},
            {"up_to": 20, "percentage": 25},
            {"up_to": None, "percentage": 15},
        ],
        "country_overrides": {"JP": {"mode": "percentage", "percentage": 50}},
    },
    country="FR",
    locale="en_US",
)
```

`upTo` is accepted as an alias of `up_to`. Charm rounding selects the smallest amount at or above the raw retail with cents `.99`, `.95`, or `.00`.

```python
catalog = PublicCatalog()  # https://nxtlsim.com/ai/*.json
feed = catalog.pricing()
retail = catalog.quote_country_rate(feed, "FR", {"percentage": 40, "rounding": "0.99"})
```

Also `coverage()`, `destinations()`, `product()`, `load_all()`, and `AsyncPublicCatalog`. Options: `origin`, `timeout` (seconds), `user_agent`, `http_client`, `retry`.

```python
from nxtl_esim import (
    assess_balance,
    collect_usage,
    ensure_balance_threshold,
    submit_and_collect_bulk_issue,
)

assess_balance(nxtl, low_usd=25, exhausted_usd=0)
ensure_balance_threshold(nxtl, threshold_value=25, action="notify")
collect_usage(nxtl, days=7, include_cdrs=True)
submit_and_collect_bulk_issue(
    nxtl,
    {"quantity": 10, "tier": "cheapest", "client_reference": "BATCH-9"},
    idempotency_key="batch-9",
)
```

`assess_balance` uses `status="unknown"` when no candidate amount key is present. `sum_usage_amounts` sets `zero_is_not_free` when one of `amount_usd` / `amount_eur` is zero and the other is not.

## FastAPI sample

[`examples/fastapi-fulfilment/main.py`](../examples/fastapi-fulfilment/main.py).

## Release

Push a tag `py-vX.Y.Z`. The workflow sets the version from the tag and publishes with [PyPI trusted publishing](https://docs.pypi.org/trusted-publishers/) (`pypa/gh-action-pypi-publish`). Configure the publisher for this repository, workflow `release-py.yml`, and GitHub environment `pypi` (the workflow's `environment` name). No API token is stored in the workflow.

## License

MIT.
