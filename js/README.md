# @nxtlsim/esim-sdk

TypeScript SDK for the [NXTL eSIM](https://nxtlsim.com) B2B API. Issue and manage pay-as-you-go travel eSIMs, read the pooled balance, and verify signed webhooks.

Create a business account and API key at [NXTL for Business](https://nxtlsim.com/for-business/). Operation details are in the [API reference](https://nxtlsim.com/nxtl-api-reference/). This package tracks OpenAPI **2.6.1** (48 operations) at `https://nxtlsim.com/api/v1`.

```bash
npm install @nxtlsim/esim-sdk
```

Node.js 18 or newer. The package is ESM and CJS, typed, and uses global `fetch` plus Web Crypto, so the same client runs on Node, Cloudflare Workers, and other edge runtimes that provide those globals. On Node 18, webhook HMAC falls back to `node:crypto` when `globalThis.crypto.subtle` is missing. There are no runtime dependencies.

## Quick start

```ts
import { NxtlClient, fulfilEsimOrder } from "@nxtlsim/esim-sdk";

const nxtl = new NxtlClient({ apiKey: process.env.NXTL_API_KEY });

const health = await nxtl.health();
const partner = await nxtl.partner();

const order = await fulfilEsimOrder(nxtl, {
  clientReference: "ORDER-123",
  nickname: "Traveller 123",
  tier: "cheapest",
  idempotencyKey: "order-123-esim",
});

// Present only when the completed job JSON already contains it.
console.log(order.activation.lpa, partner.data, health.status);
```

`POST /esims` returns 202 and a `job_id`. `fulfilEsimOrder` estimates first, queues the eSIM, and polls `GET /jobs/{id}`. Do not treat the 202 body as a provisioned profile.

`tier` is `cheapest` or `best_coverage`. The alias `standard` is accepted by the API and stored as `cheapest`.

## Client options

```ts
new NxtlClient({
  apiKey: process.env.NXTL_API_KEY,          // omitted only for GET /health
  baseUrl: "https://nxtlsim.com/api/v1",     // override for a host you were given
  timeout: 30_000,                           // milliseconds
  fetch: globalThis.fetch,                   // custom fetch
  userAgent: "@nxtlsim/esim-sdk/0.1.0 (+https://nxtlsim.com)",
  logger: console,                           // debug/info/warn/error; key-like fields are redacted
  retry: { maxRetries: 2 },                  // or false to disable
  headers: { "X-Partner-Debug": "1" },       // extra headers; X-NXTL-Key still comes from apiKey
  idempotencyHeader: "Idempotency-Key",      // or "X-NXTL-Idempotency-Key"
  autoIdempotencyKey: true,                  // POST /esims, /esims/bulk-issue, /topup
  acceptCurrency: "EUR",                     // TODO(spec): human reference only, not in OpenAPI
});
```

Per-call `CallOptions`: `idempotencyKey`, `headers`, `timeout` (ms), `signal` (`AbortSignal`), `retry`.

### Retries

HTTP 429 is retried. HTTP 5xx and network timeouts are retried for GET, HEAD, PUT, and DELETE, and for any call that sent an idempotency key. Other POST and PATCH calls are not retried on 5xx unless `retry.retryUnsafe` is true. A caller `AbortSignal` is never retried.

Delay is full jitter: random between 0 and `min(maxDelayMs, baseDelayMs * 2^attempt)`. `Retry-After` (seconds or HTTP date) is a minimum, capped by `maxRetryAfterMs` (default 120s). The exponential cap does not shrink that hint. `X-RateLimit-Reset` is consulted only when `Retry-After` is absent; its unit is not in the spec (see the root README).

| Retry field | Default | Unit |
| --- | --- | --- |
| `maxRetries` | 2 | extra attempts |
| `baseDelayMs` | 200 | milliseconds |
| `maxDelayMs` | 8000 | milliseconds |
| `maxRetryAfterMs` | 120000 | milliseconds |
| `retryUnsafe` | false | |
| `sleep` | `setTimeout` | tests |
| `random` | `Math.random` | `[0, 1)` |

### Responses

Methods return `ApiResponse<T>`: `data`, `status`, `headers` (lower-case names), `requestId` (`X-Request-Id`), `idempotentReplayed` (`Idempotent-Replayed: true`), `rateLimit`, and `idempotencyKey` when one was sent.

`request(method, path, { query, body, options })` is the escape hatch. It does not add operations that are absent from the spec.

Argument checks that match published constraints (`iccid` length 18–22, `quantity` 1–1000, `amount_usd` ≥ 0.01, nickname length, tier, threshold enums) throw `TypeError` before a request is sent.

## Errors

| Class | When |
| --- | --- |
| `NxtlAuthError` | 401, or a missing API key (`status` 0) |
| `NxtlAccessDeniedError` | 403 |
| `NxtlValidationError` | 400 |
| `NxtlInsufficientBalanceError` | 402 |
| `NxtlNotFoundError` | 404 |
| `NxtlConflictError` | 409 |
| `NxtlQuotaExceededError` | 409 `quota_exhausted` |
| `NxtlRateLimitError` | 429 (`retryAfterSeconds` when present) |
| `NxtlServerError` | 5xx |
| `NxtlConnectionError` / `NxtlTimeoutError` | no HTTP response / timeout |
| `NxtlJobFailedError` | polled job reached a failed status |
| `NxtlWebhookError` | signature or envelope rejected |

Each API error exposes `status`, `code`, `errorType`, `message`, `requestId`, `docUrl`, `details`, `headers`, and `body`. Structured envelopes and the compact `{ "error": "code" }` form are both read. Keep `requestId` for support at `support@nxtlsim.com`.

## Operations

Scopes below are the ones named in the API reference. The server enforces them.

| Method | HTTP | Scope (reference) |
| --- | --- | --- |
| `health` | `GET /health` | public |
| `partner` | `GET /partner` | `balance:read` |
| `quotas` | `GET /quotas` | `balance:read` |
| `audit` / `iterateAudit` | `GET /audit` | `audit:read` |
| `listEsims` / `iterateEsims` | `GET /esims` | `esims:read` |
| `issueEsim` | `POST /esims` | `esims:write`, idempotent |
| `listLines` / `iterateLines` | `GET /lines` | legacy alias |
| `getEsim` | `GET /esims/{iccid}` | `esims:read` |
| `updateNickname` | `PATCH /esims/{iccid}/nickname` | `esims:write` |
| `updateTier` | `PATCH /esims/{iccid}/tier` | `esims:write` |
| `updateStatus` | `PATCH /esims/{iccid}/status` | `esims:write` |
| `suspendEsim` | `POST /esims/{iccid}/suspend` | `esims:write` |
| `resumeEsim` | `POST /esims/{iccid}/resume` | `esims:write` |
| `getWallet` | `GET /esims/{iccid}/wallet` | `esims:read` |
| `getEsimUsage` | `GET /esims/{iccid}/usage` | `esims:read` |
| `getEsimEvents` | `GET /esims/{iccid}/events` | `esims:read` |
| `bulkStatus` | `POST /esims/bulk-status` | up to 100 ICCIDs |
| `bulkTier` | `POST /esims/bulk-tier` | up to 1000 ICCIDs |
| `bulkIssue` | `POST /esims/bulk-issue` | idempotent, quantity 1–1000 |
| `estimate` | `POST /esims/estimate` | no eSIM is created |
| `listJobs` | `GET /jobs` | no page parameters in the spec |
| `getJob` | `GET /jobs/{id}` | |
| `getEsimRequest` | `GET /esim-requests/{job_id}` | legacy alias |
| `getBalance` | `GET /balance` | `balance:read` |
| `listBalanceHistory` / `iterateBalanceHistory` | `GET /balance/history` | `balance:read` |
| `topup` | `POST /topup` | `balance:write`, idempotent, prepaid budget |
| `listInvoices` | `GET /invoices` | `balance:read` |
| `usageSummary` | `GET /usage/summary` | |
| `usageEsims` | `GET /usage/esims` | `limit` max 500 |
| `usageLines` | `GET /usage/lines` | legacy alias, no query params in the spec |
| `usageCdrs` / `iterateUsageCdrs` | `GET /usage/cdrs` | `per_page` max 500 |
| `usageTimeseries` | `GET /usage/timeseries` | `days` max 365 |
| `listApiKeys` | `GET /api-keys` | `keys:read` |
| `createApiKey` | `POST /api-keys` | `keys:write`, secret returned once |
| `revokeApiKey` | `DELETE /api-keys/{key_public}` | `keys:write` |
| `getWebhooks` | `GET /webhooks` | `webhooks:read` |
| `updateWebhooks` | `PUT /webhooks` | `webhooks:write` |
| `listWebhookEvents` | `GET /webhooks/events` | `webhooks:read` |
| `getWebhookSecret` | `GET /webhooks/secret` | `webhooks:read` |
| `testWebhook` | `POST /webhooks/test` | sends `test.ping` |
| `listWebhookDeliveries` / `iterateWebhookDeliveries` | `GET /webhooks/deliveries` | `page` only |
| `getWebhookDelivery` | `GET /webhooks/deliveries/{id}` | |
| `replayWebhookDelivery` | `POST /webhooks/deliveries/{id}/replay` | |
| `replayWebhookDeliveryLegacy` | `POST /webhooks/{id}/replay` | legacy alias |
| `listThresholds` | `GET /thresholds` | `thresholds:read` |
| `createThreshold` | `POST /thresholds` | `thresholds:write` |
| `updateThreshold` | `PATCH /thresholds/{id}` | `thresholds:write` |
| `deleteThreshold` | `DELETE /thresholds/{id}` | `thresholds:write` |

`API_OPERATIONS` is the same list (`id`, `method`, `path`, `summary`, `autoIdempotency`).

List iterators accept the same filters as the list call, plus `maxPages` (default 100). They follow `page` until a short page, an empty page, a repeated first row, or `has_more` / `total_pages` when the JSON contains them. The envelope itself is not in the spec.

## Webhooks

```ts
import { constructWebhookEvent, WEBHOOK_SIGNATURE_HEADER } from "@nxtlsim/esim-sdk";

const event = await constructWebhookEvent({
  payload: rawBody, // exact bytes or the raw UTF-8 string
  signatureHeader: request.headers[WEBHOOK_SIGNATURE_HEADER],
  secret: [activeSecret, rotatingSecret].filter(Boolean),
  toleranceSeconds: 300, // 0 disables the timestamp check
});
```

`verifyWebhookSignature` returns a boolean. `parseWebhookEvent` checks `id`, `event`, `timestamp`, and object `data`. `WEBHOOK_EVENT_NAMES` lists the 15 names in the human reference; `event` is a string in the schema, so unknown names still parse. Confirm the live set with `listWebhookEvents()`.

## Reseller helpers

Markup is local. It does not call NXTL and does not convert currencies. Feed rates are EUR per GB from the public pricing file. Issuance cost for the pooled balance comes from `estimate` and `quotas`, not from that file.

```ts
import { quotePrice, formatCurrency } from "@nxtlsim/esim-sdk";

const quote = quotePrice(2.5, {
  mode: "tiered", // or "percentage" or "fixed"
  percentage: 30,
  fixed: 0.5,
  rounding: "0.99", // "none" | "nearest" | "up" | "down" | "0.99" | "0.95" | "0.00"
  currency: "EUR",
  tiers: [
    { upTo: 5, percentage: 40 },
    { upTo: 20, percentage: 25 },
    { upTo: null, percentage: 15 },
  ],
  countryOverrides: { JP: { mode: "percentage", percentage: 50 } },
}, { country: "FR", locale: "en-US" });
```

`quote.fxApplied` is always `false`. Charm rounding picks the smallest amount greater than or equal to the raw retail whose cents are `.99`, `.95`, or `.00`.

```ts
import { PublicCatalog } from "@nxtlsim/esim-sdk";

const catalog = new PublicCatalog(); // origin defaults to https://nxtlsim.com
const pricing = await catalog.pricing();
const retail = catalog.quoteCountryRate(pricing, "FR", { percentage: 40, rounding: "0.99" });
```

`PublicCatalog` also loads `coverage()`, `destinations()`, `product()`, and `loadAll()`. Options: `fetch`, `origin`, `timeout` (ms), `userAgent`, `logger`, `retry`.

```ts
import { assessBalance, collectUsage, ensureBalanceThreshold, submitAndCollectBulkIssue } from "@nxtlsim/esim-sdk";

const balance = await assessBalance(nxtl, { lowUsd: 25, exhaustedUsd: 0 });
await ensureBalanceThreshold(nxtl, { threshold_value: 25, action: "notify" });
const usage = await collectUsage(nxtl, { days: 7, includeCdrs: true });
const batch = await submitAndCollectBulkIssue(nxtl, {
  quantity: 10,
  tier: "cheapest",
  client_reference: "BATCH-9",
}, { idempotencyKey: "batch-9" });
```

`assessBalance` reports `unknown` when `GET /balance` does not contain one of the candidate amount keys. `sumUsageAmounts` sets `zeroIsNotFree` when one of `amount_usd` / `amount_eur` is zero and the other is not. A zero converted field is not free usage.

`readIssuanceFee(quotas)` returns a number only when a candidate key is present.

## Reseller layer

Everything in this section is bookkeeping in your process. [NXTL eSIM](https://nxtlsim.com) sells pay-as-you-go data on a pooled balance. It does not store your customers, packages, or customer invoices. Create the API key at [NXTL for Business](https://nxtlsim.com/for-business/).

### Usage and cost

`loadUsageDetails` calls `GET /usage/cdrs` (and `GET /esims/{iccid}/usage` for one line). With `includePartnerRollups` it also calls `GET /usage/summary`, `GET /usage/esims`, and `GET /usage/timeseries`. Periods are `daily`, `monthly`, or a custom `range`.

Wholesale cost uses `amount_usd` / `amount_eur` when the row has them. A zero in the converted currency is not treated as free. If those fields are missing and the row has bytes plus a country, the public pricing feed supplies EUR per GB. Retail applies your markup. Margin is retail minus wholesale. `byLine`, `byDay`, `byMonth`, and `byCountry` group the same rows. The per-country list stays empty when no row carries a country field, which the OpenAPI schema does not define.

`snapshotUsage` plus `diffSnapshots` turns two polls into the rows and money added since the previous snapshot. `toBytes` / `formatData` normalise B, KB, MB, GB, and TB on a 1000-based scale.

### Customers

`MemoryCustomerStore` is the default. `JsonFileCustomerStore` is a single JSON file. `SqlCustomerStore` runs the statements in `CUSTOMER_STORE_SQL` through a `query(sql, params)` function you connect to a driver.

```ts
const directory = new CustomerDirectory(new MemoryCustomerStore(), nxtl);
const customer = await directory.saveCustomer({ name: "Ada", externalId: "crm-1", tags: ["vip"] });
await directory.assignLine(customer.id, iccid, "handset");
await directory.credit(customer.id, 40, "EUR", "prepaid wallet");
const low = await directory.isLowBalance(customer.id, "EUR", 10);
await directory.suspendCustomer(customer.id); // POST /esims/{iccid}/suspend on each active line
```

`flagCustomer` only changes the store. The wallet is yours: credits, debits, and low-balance checks do not call `POST /topup`.

### Packages

`definePackage({ name: "Europe 5GB 30 days", dataCapGb: 5, validityDays: 30, countries: ["FR", "DE"], price: 25, currency: "EUR" })` is a product you sell. `openAllocation` starts the clock. `applyUsageToPackages` draws bytes FIFO (earliest start) or by priority (lowest number first). `topUpAllocation` and `renewAllocation` add days or bytes in the store.

Overage `flag` marks the allocation. Overage `suspend` can call `suspendOverageLines`, which uses `POST /esims/{iccid}/suspend`. `syncPackageThreshold` creates a NXTL rule only when you set `usdCap`, using metric `line_usage_usd_today` and `notes.cap_per_line_usd`. The API has no multi-day byte-cap metric, so a GB allowance is enforced in the store, not as a network cap.

### Billing

`buildCustomerInvoice` writes usage (wholesale), markup, and package-fee lines for one customer and period. `invoicesToCsv` and `invoicesToJson` export them. `buildStatement` rolls wallet credits and debits. `marginReport` sums revenue, cost, and margin. `convertFx` uses a rate table you supply: `rates.EUR = 1.1` with base USD means 1 EUR = 1.1 USD.

### Monitoring

`ensureUsagePercentRule` posts metric `line_usage_pct`. `ensurePoolBalanceRule` posts `balance_below`. `WebhookRouter` dispatches the published event names (`esim.provisioned`, `usage.recorded`, `balance.low`, `job.completed`, `job.failed`, and the rest of `WEBHOOK_EVENT_NAMES`). `syncReseller` polls each active customer's lines, stores a snapshot, debits the wallet by the retail delta, applies package consumption, and emits low-balance and overage alerts. `scheduleSync(run, intervalMs)` is a local timer.

### Catalog, quotes, provisioning, lifecycle, audit

`searchCatalog` filters the public pricing, destination, and coverage files by country, text, and max EUR per GB. A region query matches destination rows of type `region` only. Those rows do not list member countries.

`quoteTrip({ countries, estimatedGb, pricing, markup })` prices the public per-GB feed. `split: "even"` divides the gigabytes across countries. `split: "each"` prices the full amount in every country. Pass `issuanceFee` from `estimate` or `quotas` when you want the profile fee in the same total. This is not a substitute for `POST /esims/estimate`.

`provisionCustomers` calls `POST /esims` once per customer so each row keeps its own `client_reference`. `POST /esims/bulk-issue` is one reference for the whole batch, so it is not used here. With `wait: true` the helper polls `GET /jobs/{id}` and assigns the ICCID when the job JSON contains one.

`lineLifecycle` covers issue, status, suspend, resume, terminate, wallet, events, and `poolTopup`. Terminate is permanent. There is no DELETE eSIM operation and no per-line top-up. `readAudit` walks `GET /audit` and calls your hook for each row.

## Examples

- Express checkout, WooCommerce-style fulfilment, and Shopify-style fulfilment under `/examples`.
- [`examples/reseller-dashboard/sync.mjs`](../examples/reseller-dashboard/sync.mjs) polls usage into the customer store.
- [`examples/monthly-billing/export.mjs`](../examples/monthly-billing/export.mjs) writes a CSV invoice for a pay-as-you-go period.

## Release

Push a tag `js-vX.Y.Z`. The release workflow sets the package version from the tag, tests, builds, and runs `npm publish --access public --provenance` with the `NPM_TOKEN` secret.

## License

MIT.
