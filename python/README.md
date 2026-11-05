# nxtl-esim

Python SDK for the [NXTL eSIM](https://nxtlsim.com) B2B API. Issue and manage pay-as-you-go travel eSIMs, read the pooled balance, and verify signed webhooks.

Create a business account and API key at [NXTL for Business](https://nxtlsim.com/for-business/). Operation details are in the [API reference](https://nxtlsim.com/nxtl-api-reference/). This package tracks OpenAPI **2.6.3** (48 operations) at `https://nxtlsim.com/api/v1`.

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

## Reseller layer

Customer records, packages, wallets, and customer invoices live in your process. [NXTL eSIM](https://nxtlsim.com) is pay-as-you-go on a pooled balance. It does not store your customers or the packages you sell. API keys come from [NXTL for Business](https://nxtlsim.com/for-business/). Import the helpers from `nxtl_esim.reseller`. Async network calls are `load_usage_details_async`, `AsyncCustomerDirectory`, `sync_reseller_async`, and `provision_customers_async`.

### Usage and cost

`load_usage_details` reads `GET /usage/cdrs` and, for one ICCID, `GET /esims/{iccid}/usage`. Periods are daily, monthly, or a custom range. `include_partner_rollups=True` also calls summary, per-eSIM, and timeseries. Those last two day-count endpoints are capped at 365 days.

Reconciled cost uses the native field selected by `currency`. Current usage is EUR: `amount_eur` is a signed retail pool debit and `amount_usd` is `0`. That zero is not an FX conversion and is not free usage. The positive value is the NXTL API charge (reseller acquisition cost), not upstream wholesale. Markup sits on top of it. The public per-GB feed is only for `quote_trip`, not for reconciled charges.

Reseller sync requests `accounting=1`. Without it, CDR bytes and network text stay empty and are not measured zero. `detail_available` false stays pending. True with `bytes` 0 is measured zero. `after_id` is an ascending cursor (`id > after_id`, `page` 1, `next_cursor` or null). Checkpoints are per account, ICCID, and date window, and they move only after the commit. `sync_reseller_async` uses that same commit path. A webhook without `data.ledger_id` is not charged. Markup and FX apply to the selling charge. Missing FX stays unresolved. Credits are the acquisition amount with no markup. JSON replacement is atomic and single-process. SQL `commit_sync` requires a transaction. `Germany` maps to `DE`. A manual pause is not resumed. `POST /esims` 202 is not completed provisioning.

### Customers

`MemoryCustomerStore` is the default. `JsonFileCustomerStore` writes one JSON file. `SqlCustomerStore` sends `CUSTOMER_STORE_SQL` through your `query(sql, params)` callable. Placeholders are `?`.

```python
directory = CustomerDirectory(MemoryCustomerStore(), nxtl)
customer = directory.save_customer({"id": "cus_1", "name": "Ada", "external_id": "crm-1", "tags": ["vip"]})
directory.assign_line(customer["id"], iccid, "handset")
directory.credit(customer["id"], 40, "EUR", "prepaid wallet")
directory.suspend_customer(customer["id"])  # POST /esims/{iccid}/suspend
```

`flag_customer` only updates the store. Wallet credits and debits do not call `POST /topup`.

### Packages

`define_package` with a name such as `Europe 5GB 30 days`, a data cap, validity, country list, and price is your product. `open_allocation` starts it. `apply_usage_to_packages` consumes bytes FIFO or by priority. `top_up_allocation` and `renew_allocation` extend the store record.

`overage="suspend"` can call `suspend_overage_lines`. `sync_package_threshold` posts `line_usage_usd_today` only when `usd_cap` is set. A gigabyte allowance is not a published threshold metric, so the cap is tracked in the store.

### Billing

`build_customer_invoice` emits usage, markup, and package-fee lines. `invoices_to_csv` and `invoices_to_json` export them. `build_statement` includes wallet movement. `margin_report` sums revenue, cost, and margin. `convert_fx` uses your rates: base USD and `rates["EUR"] = 1.1` means 1 EUR = 1.1 USD.

### Monitoring

`ensure_usage_percent_rule` posts `line_usage_pct`. `ensure_pool_balance_rule` posts `balance_below`. `WebhookRouter.on` handles the event names in `WEBHOOK_EVENT_NAMES`, including `usage.recorded`, `balance.low`, `job.completed`, and `esim.provisioned`. `sync_reseller` polls active lines, snapshots usage, debits the retail delta, applies packages, and raises low-balance and overage alerts. `sync_loop` is a local async timer.

### Catalog, quotes, provisioning, lifecycle, audit

`search_catalog` filters pricing, destinations, and coverage by country, text, and max EUR per GB. Region search matches destination rows of type `region` and does not expand them to ISO codes.

`quote_trip` prices the public per-GB feed. `split="even"` divides gigabytes across countries. `split="each"` prices the full amount in every country. `issuance_fee` is optional and should come from `estimate` or `quotas`.

`provision_customers` calls `POST /esims` per customer. Bulk issue uses one `client_reference` for the batch, so it is not used for a customer list. `wait=True` polls the job and assigns the ICCID when the payload contains one.

`LineLifecycle` covers issue, status, suspend, resume, terminate, wallet, events, and `pool_topup`. Terminate is permanent. There is no DELETE and no per-line top-up. `read_audit` walks `GET /audit`.

## Examples

- FastAPI fulfilment: [`examples/fastapi-fulfilment/main.py`](../examples/fastapi-fulfilment/main.py).
- Monthly billing export: [`examples/monthly-billing/export.py`](../examples/monthly-billing/export.py).

## Release

Push a tag `py-vX.Y.Z`. The workflow sets the version from the tag and publishes with [PyPI trusted publishing](https://docs.pypi.org/trusted-publishers/) (`pypa/gh-action-pypi-publish`). Configure the publisher for this repository, workflow `release-py.yml`, and GitHub environment `pypi` (the workflow's `environment` name). No API token is stored in the workflow.

## License

MIT.
