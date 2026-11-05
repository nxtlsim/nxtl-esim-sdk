# NXTL eSIM SDKs

Official JavaScript/TypeScript and Python SDKs for the [NXTL eSIM](https://nxtlsim.com) B2B REST API. Issue, resell, and manage pay-as-you-go travel eSIMs against a pooled business balance.

API access belongs to an approved business account. Create the account and an API key at [NXTL for Business](https://nxtlsim.com/for-business/). The human reference is the [NXTL eSIM API documentation](https://nxtlsim.com/nxtl-api-reference/). The machine contract checked into `spec/nxtl-v1-openapi.json` is OpenAPI 2.6.3 (48 operations) from `https://nxtlsim.com/wp-content/plugins/nxtl-data-esim-v2/docs/nxtl-v1-openapi.json`.

| Package | Path | Install |
| --- | --- | --- |
| `@nxtlsim/esim-sdk` | [`js/`](js/README.md) | `npm install @nxtlsim/esim-sdk` |
| `nxtl-esim` | [`python/`](python/README.md) | `pip install nxtl-esim` |

Base URL: `https://nxtlsim.com/api/v1`. Authenticate with the `X-NXTL-Key` header. `GET /health` is public. The product model on the API is pay-as-you-go data: issue a profile, fund the pool from the partner prepaid budget, and reconcile usage.

```bash
curl -sS "https://nxtlsim.com/api/v1/health"
curl -sS -H "X-NXTL-Key: $NXTL_API_KEY" "https://nxtlsim.com/api/v1/partner"
```

Issuance is asynchronous. `POST /esims` and `POST /esims/bulk-issue` return **202** and a `job_id`. Wait for `GET /jobs/{id}` or the `esim.provisioned` webhook before handing a customer an activation string. `POST /topup` credits the pooled balance from prepaid budget (`amount_usd`). It does not charge a saved card.

## What both SDKs include

- A typed method for every operation in the OpenAPI document, including legacy aliases (`/lines`, `/esim-requests/{job_id}`, `/usage/lines`, `/webhooks/{id}/replay`).
- API key, base URL, timeout, custom fetch or httpx client, user agent, and a logger hook. Secrets are redacted from log metadata.
- Retries with exponential backoff and full jitter on HTTP 429 and 5xx. `Retry-After` is a minimum wait. 5xx retries run for safe methods and for calls that send an idempotency key.
- Automatic `Idempotency-Key` on `POST /esims`, `POST /esims/bulk-issue`, and `POST /topup`. The same key is reused for retries of that call. `X-NXTL-Idempotency-Key` is available as the legacy header.
- Page helpers for the list operations that publish `page` (and `per_page` where the document publishes it).
- Typed errors for authentication, access denied, validation, rate limit, not found, insufficient balance, quota conflict, and server failures.
- Webhook verification for `X-NXTL-Signature-V1` (HMAC-SHA256 over `{timestamp}.{raw_body}`) and typed parsing of the webhook envelope.
- Reseller helpers that run in your process: percentage, fixed, and tiered markup, `.99` / `.95` / `.00` rounding, per-country overrides, and currency formatting. These helpers do not convert currencies and do not call the API.
- Order helper: estimate, `POST /esims`, poll the job, return an LPA or QR string only when that string is already in the job JSON.
- Bulk helper: `POST /esims/bulk-issue`, poll, collect row objects.
- Usage rollup and balance/threshold helpers.
- A public catalog client for the JSON files at `https://nxtlsim.com/ai/pricing.json`, `coverage.json`, `destinations.json`, and `nxtl-product.json`. Those files are not B2B API operations.

Per-language options, method names, and error classes are documented in [`js/README.md`](js/README.md) and [`python/README.md`](python/README.md).

## Examples

Samples, not store plugins:

- [`examples/express-storefront/server.mjs`](examples/express-storefront/server.mjs) — checkout that prices locally and queues one eSIM.
- [`examples/woocommerce-fulfilment/server.mjs`](examples/woocommerce-fulfilment/server.mjs) — WooCommerce-style order webhook, then NXTL fulfilment.
- [`examples/shopify-fulfilment/server.mjs`](examples/shopify-fulfilment/server.mjs) — Shopify-style order webhook, then NXTL fulfilment.
- [`examples/fastapi-fulfilment/main.py`](examples/fastapi-fulfilment/main.py) — the same flow on FastAPI.
- [`examples/reseller-dashboard/sync.mjs`](examples/reseller-dashboard/sync.mjs) — poll usage into a reseller customer store.
- [`examples/monthly-billing/export.mjs`](examples/monthly-billing/export.mjs) and [`export.py`](examples/monthly-billing/export.py) — invoice CSV for a pay-as-you-go period.

The reseller layer (customers, prepaid wallets, sellable packages, invoices, sync) is local state on top of the API. NXTL eSIM does not host those records. Packages you define are not NXTL plans.

## Develop

```bash
cd js && npm ci && npm test && npm run build
cd python && pip install -e ".[dev]" && ruff check src tests && pytest
```

GitHub Actions (`.github/workflows/ci.yml`) runs those checks. Tag `js-vX.Y.Z` to publish `@nxtlsim/esim-sdk` with npm provenance (`NPM_TOKEN`). Tag `py-vX.Y.Z` to publish `nxtl-esim` with PyPI trusted publishing. This repository does not publish on its own.

## Spec gaps

The OpenAPI document names every operation and fully schemas errors, eSIM objects, issue/estimate/bulk bodies, threshold rules, and the webhook envelope. Many HTTP 200 payloads are descriptions only. Where that happens the SDK returns the JSON object as parsed and marks the gap with `TODO(spec)` in source. In particular:

- Health, partner, quotas, audit pages, eSIM pages, wallets, usage rows, ledger events, balance, estimates, jobs, acknowledgements, invoices, and webhook deliveries have no response schema. Pagination field names (`total_pages`, `has_more`, the array key) are not defined. The iterators stop on an empty page, a short page when `per_page` is known, a repeated first row, or those fields when they happen to be present.
- `GET /jobs` is described as paginated and publishes no `page` parameter. `GET /webhooks/deliveries` publishes `page` and not `per_page`. `GET /usage/lines` publishes no query parameters.
- Job status strings and per-row result objects are not enumerated. The poller treats `complete` / `completed` / `failed` and a short list of synonyms as terminal. `TODO(spec)` is on that list.
- `esim.provisioned` `data` and job results do not name an LPA, QR, or SM-DP+ field. `extractActivation` / `extract_activation` copies a string only when it starts with `LPA:` or sits under a key whose name contains `qr`, `iccid`, `smdp`, or `matchingid`.
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `X-Request-Id` are described in the human reference. The reset header's unit is not defined. Retry sleep uses `Retry-After` first, then a conservative reading of the reset header (delta seconds when the integer is ≤ 86400, Unix seconds when it is ≥ 1e9).
- `Accept-Currency` is described in the human reference and is not an OpenAPI parameter. Set `acceptCurrency` / `accept_currency` to send it. Typed methods do not add a `currency` query parameter.
- The OpenAPI info string specifies HMAC-SHA256 and `X-NXTL-Signature-V1: t=,v1=`. The signed payload `{timestamp}.{raw_body}` is specified in the human reference (and the secret endpoint returns a `signed_payload` description). The replay window is not specified. The default tolerance is 300 seconds; pass `0` to skip it.
- `affordable` is named in the human reference for estimates, not in the OpenAPI schema. The order helper throws only when that property is present and `false`.
- `GET /quotas` has no property names. Issuance-fee helpers try a documented candidate list and return nothing when none of those keys exist.
- The public `/ai/*.json` feeds are outside the REST surface. The catalog client fetches those URLs directly.
- Network tier `standard` is accepted by the API and stored as `cheapest`. It is not in the published enum. The SDK allows it on input.
- Some earlier operations can return `{ "error": "code" }` instead of the structured envelope. The error parser accepts both. HTTP status selects the exception class.
- No separate public sandbox base URL is documented. Point `baseUrl` / `base_url` at the host you were given.
- There is no customer, package, or customer-invoice resource. Those SDKs records are reseller-side. `GET /invoices` lists orders for API pool top-ups.
- `GET /usage/cdrs` without `accounting=1` leaves bytes and country empty. That is not measured zero. `accounting=1` adds `detail_available` and `ledger_id`. `after_id` adds `next_cursor`. Those fields are in the operation description and the human reference. The OpenAPI parameter array does not list them yet.
- `amount_usd: 0` on a EUR debit is not an FX rate and is not free usage. The API does not expose upstream wholesale cost. USD rules still use `ABS(amount_usd)`. Opt-in EUR metrics are `line_usage_eur_today` and `line_usage_pct_eur` with `notes.cap_per_line_eur`. `period` is stored and ignored. Rules run on the minute tick after usage polling (default 600 seconds, 12-hour supplier-lag lookback).
- A webhook envelope id is a delivery id. `data.ledger_id` may be null. The SDK does not charge that delivery. There is no documented subscriber opt-in for `usage.recorded`.
- `GET /jobs` is a paginated list with status counts and publishes no page parameters or status enum. `POST /esims` 202 is a job id, not a finished eSIM and not an activation code.
- `GET /balance` `wallets[]` is described in the human reference (`iccid`, `nickname`, `wallet_balance_usd`, `last_sync`). The OpenAPI response has no item schema. The JSON reseller file is single-process. SQL sync requires a transaction callback.
- There is no per-line top-up and no DELETE eSIM. `POST /topup` credits the partner pool from prepaid budget. Terminate is permanent.
- Public destination region rows do not list member countries, so region search does not expand to ISO codes.

## Related projects

These are separate NXTL repositories. They are not published packages.

- [nxtl-webhook-starter](https://github.com/nxtlsim/nxtl-webhook-starter) — verify `X-NXTL-Signature-V1` and forward webhook events.
- [nxtl-balance-alerts](https://github.com/nxtlsim/nxtl-balance-alerts) — poll `GET /balance` and alert when the pool is low.
- [awesome-esim](https://github.com/nxtlsim/awesome-esim) — list of eSIM tools. The NXTL entry is under Provider APIs and SDKs.

Samples in this repo are under [Examples](#examples).

## License

MIT. See [LICENSE](LICENSE).
