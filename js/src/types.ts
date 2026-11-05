/**
 * Types published by the NXTL B2B OpenAPI document (v2.6.3) plus
 * deliberately loose shapes where that document describes a response
 * but does not publish a schema.
 *
 * Unknown JSON keys are preserved at runtime. They are not all named here.
 */

export type JsonObject = Record<string, unknown>;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Query values accepted by list endpoints. */
export type EsimStatus = "pre_service" | "ready" | "suspended" | "terminated";

/**
 * Network tier. `standard` is not in the enum; the schema description says it
 * is accepted and stored as `cheapest`.
 */
export type NetworkTier = "cheapest" | "best_coverage";
export type NetworkTierInput = NetworkTier | "standard";

export type StatusAction = "suspend" | "reactivate" | "terminate";

export type ThresholdScope = "balance" | "esim" | "line";
export type ThresholdMetric =
  | "balance_below"
  | "line_usage_pct"
  | "line_usage_usd_today"
  | "line_usage_pct_eur"
  | "line_usage_eur_today";
export type ThresholdOperator = "<" | "<=" | "=" | ">=" | ">";
export type ThresholdPeriod = "instant" | "daily" | "weekly" | "monthly";
export type ThresholdAction = "notify" | "suspend";

export type DeliveryStatus = "pending" | "delivered" | "failed";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface RetryOptions {
  /** Extra attempts after the first response. Default 2. */
  maxRetries?: number;
  /** Base delay in milliseconds before jitter. Default 200. */
  baseDelayMs?: number;
  /** Cap for the exponential component, in milliseconds. Default 8000. */
  maxDelayMs?: number;
  /**
   * Cap applied to a server-supplied Retry-After, in milliseconds.
   * Default 120000. The exponential cap does not override Retry-After
   * below this ceiling.
   */
  maxRetryAfterMs?: number;
  /**
   * When false (default), HTTP 5xx and network failures are retried only
   * for GET, HEAD, PUT, DELETE, and requests that send an idempotency key.
   * HTTP 429 is always retried.
   */
  retryUnsafe?: boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Returns a number in [0, 1). Default Math.random. */
  random?: () => number;
}

export interface NxtlClientOptions {
  /** Secret from an approved NXTL Business account. Required except for GET /health. */
  apiKey?: string;
  /** Default `https://nxtlsim.com/api/v1`. */
  baseUrl?: string;
  /** Request timeout in milliseconds. Default 30000. */
  timeout?: number;
  /** Custom fetch implementation. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Default includes the SDK name and https://nxtlsim.com. */
  userAgent?: string;
  logger?: Logger;
  /** Pass false to disable retries. */
  retry?: RetryOptions | false;
  /** Extra headers. `X-NXTL-Key` is always taken from `apiKey`. */
  headers?: Record<string, string>;
  /**
   * Default `Idempotency-Key`. `X-NXTL-Idempotency-Key` is the legacy alias
   * the API still accepts.
   */
  idempotencyHeader?: "Idempotency-Key" | "X-NXTL-Idempotency-Key";
  /**
   * When true (default), POST /esims, POST /esims/bulk-issue and POST /topup
   * send a generated key when the caller did not. The same key is reused
   * for every retry of that call.
   */
  autoIdempotencyKey?: boolean;
  /**
   * Sends `Accept-Currency` when set.
   * TODO(spec): the human API reference describes this header. The OpenAPI
   * document does not list it on any operation.
   */
  acceptCurrency?: string;
}

export interface CallOptions {
  idempotencyKey?: string;
  headers?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  retry?: RetryOptions | false;
}

export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  /**
   * Raw `X-RateLimit-Reset` value.
   * TODO(spec): the human reference names the header and does not define
   * whether the value is a delta or a Unix timestamp.
   */
  reset?: string;
  retryAfterSeconds?: number;
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  headers: Readonly<Record<string, string>>;
  requestId?: string;
  idempotentReplayed: boolean;
  rateLimit: RateLimitInfo;
  idempotencyKey?: string;
}

/** components.schemas.Error */
export interface ErrorEnvelope {
  error: true;
  type: string;
  code: string;
  message: string;
  doc_url?: string;
  request_id?: string;
  details?: JsonObject;
}

export interface ESimWallet {
  balance_usd?: number;
  currency?: string;
}

/** components.schemas.ESim */
export interface ESim {
  iccid?: string;
  nickname?: string;
  tier?: string;
  status?: string;
  client_reference?: string;
  created_at?: string;
  wallet?: ESimWallet;
}

/** components.schemas.ESimIssueRequest */
export interface ESimIssueRequest {
  nickname?: string;
  tier?: NetworkTierInput;
  client_reference?: string;
}

/** components.schemas.BulkIssueRequest */
export interface BulkIssueRequest {
  quantity: number;
  tier?: NetworkTierInput;
  client_reference?: string;
  metadata?: JsonObject;
}

/** components.schemas.EstimateRequest */
export interface EstimateRequest {
  quantity: number;
  tier?: NetworkTierInput;
}

export interface ThresholdNotes {
  cap_per_line_usd?: number;
  /** Read only by line_usage_pct_eur. Not converted from USD. */
  cap_per_line_eur?: number;
  min_renotify_seconds?: number;
  [key: string]: unknown;
}

/** components.schemas.ThresholdRule */
export interface ThresholdRule {
  scope?: ThresholdScope;
  metric: ThresholdMetric;
  operator?: ThresholdOperator;
  threshold_value: number;
  period?: ThresholdPeriod;
  action?: ThresholdAction;
  enabled?: boolean;
  notes?: ThresholdNotes;
}

/**
 * components.schemas.WebhookEnvelope.
 * `data` is an open object. Per-event properties are not published.
 */
export interface WebhookEnvelope<TData extends JsonObject = JsonObject> {
  id: string;
  event: string;
  /** Unix seconds UTC. */
  timestamp: number;
  data: TData;
}

export interface NicknameBody {
  nickname: string;
}

export interface TierBody {
  tier: NetworkTierInput;
}

export interface StatusBody {
  action: StatusAction;
}

export interface TopupRequest {
  /** USD credited from the partner prepaid budget. Minimum 0.01. Does not charge a card. */
  amount_usd: number;
}

export interface IccidListBody {
  iccids: string[];
}

export interface BulkTierBody {
  iccids: string[];
  tier: NetworkTierInput;
}

export interface ApiKeyCreateRequest {
  label?: string;
}

export interface WebhookConfigRequest {
  webhook_url?: string;
  events?: string[];
}

export interface AuditQuery {
  action?: string;
  target_type?: string;
  target_id?: string;
  since?: string;
  until?: string;
  page?: number;
  per_page?: number;
}

export interface EsimListQuery {
  iccid?: string;
  status?: EsimStatus;
  tier?: string;
  client_reference?: string;
  page?: number;
  per_page?: number;
}

export interface PageQuery {
  page?: number;
  per_page?: number;
}

export interface UsageSummaryQuery {
  days?: number;
}

export interface UsageEsimsQuery {
  since?: string;
  until?: string;
  iccid?: string;
  limit?: number;
}

export interface CdrQuery {
  iccid?: string;
  since?: string;
  until?: string;
  page?: number;
  per_page?: number;
  /**
   * `1` joins usage detail and adds `detail_available` and `ledger_id`.
   * Omit it to keep the legacy empty volume payload.
   */
  accounting?: 0 | 1;
  /** Exclusive cursor. `id > after_id`, ascending. Do not combine with page iteration. */
  after_id?: number;
}

export interface TimeseriesQuery {
  days?: number;
}

export interface DeliveryQuery {
  status?: DeliveryStatus;
  event?: string;
  since?: string;
  until?: string;
  page?: number;
}

/**
 * TODO(spec): components.responses.Health has no schema.
 */
export type HealthResponse = JsonObject;

/**
 * TODO(spec): components.responses.Partner has no schema.
 * The operation summary says the payload identifies the partner and the
 * scopes resolved by the key.
 */
export type Partner = JsonObject;

/**
 * TODO(spec): components.responses.Quotas has no schema.
 * The summary names balance, lifetime quota, rate limit, issuance fee
 * and subscription state, without property names.
 */
export type Quotas = JsonObject;

/** TODO(spec): components.responses.AuditPage has no schema. */
export type AuditPage = JsonObject;

/** TODO(spec): components.responses.ESimsPage has no schema. */
export type ESimsPage = JsonObject;

/**
 * Named by the JobAccepted response description ("202 Accepted with job_id").
 * TODO(spec): no schema is published for the rest of the object.
 */
export type JobAccepted = JsonObject & {
  job_id?: number | string;
};

/** TODO(spec): components.responses.Ack has no schema. */
export type Ack = JsonObject;

/**
 * Live carrier wallet from GET /esims/{iccid}/wallet.
 * The operation description names wallet_id, wallet_balance_usd, and raw_balance.
 * This is not a per-line top-up.
 */
export interface Wallet {
  wallet_id?: string | number;
  wallet_balance_usd?: number;
  raw_balance?: number;
}

/**
 * Stored mirror item inside GET /balance `wallets[]`.
 * The human reference names iccid, nickname, wallet_balance_usd, and last_sync.
 * This is not the live carrier read.
 */
export interface StoredWalletMirror {
  iccid?: string;
  nickname?: string;
  wallet_balance_usd?: number;
  last_sync?: string;
}

/** GET /esims/{iccid}/usage. Page size is fixed at 50. No total or pages count. */
export interface EsimUsageRow {
  /** Present when `accounting=1` was requested. Same primary key as a CDR `id`. */
  ledger_id?: number;
  entry_type: string;
  amount_usd: number;
  amount_eur: number;
  currency: string;
  customer_total_after: number | null;
  /** Ledger write time, `Y-m-d H:i:s`. */
  created_at: string;
  note: string;
  /** Present only when entry_type is `usage`. Octets. */
  bytes?: number;
  /** bytes / 1048576. Present only on usage rows. */
  mb?: number;
  /** Country name, not an ISO code. Present only on usage rows. */
  country?: string;
  operator?: string;
  rat?: string;
  mcc?: string;
  mnc?: string;
  tadig?: string;
}

export interface EsimUsageList {
  iccid: string;
  provider: string;
  page: number;
  usage: EsimUsageRow[];
}

export type UsageList = EsimUsageList;

/** TODO(spec): components.responses.EventList has no schema. */
export type EventList = JsonObject;

/**
 * POST /esims/bulk-status describes an array of these rows.
 * TODO(spec): `lifecycle` is named only in that description.
 */
export interface BulkStatusRow {
  iccid?: string;
  status?: string;
  tier?: string;
  lifecycle?: string;
  [key: string]: unknown;
}

/** TODO(spec): components.responses.Estimate has no schema. */
export type Estimate = JsonObject;

/** TODO(spec): GET /jobs is described as a paginated list and has no schema or page parameters. */
export type JobList = JsonObject;

/**
 * TODO(spec): components.responses.Job has no schema.
 * The description says the payload includes per-row results.
 */
export type Job = JsonObject;

/**
 * Pool totals plus stored per-eSIM wallet mirrors.
 * The item shape of `wallets` is not a published schema. The live read is GET /esims/{iccid}/wallet.
 */
export type Balance = JsonObject & {
  wallets?: StoredWalletMirror[];
};

/** TODO(spec): GET /balance/history 200 is "Ledger entries" with no schema. */
export type LedgerPage = JsonObject;

/** TODO(spec): GET /invoices 200 is "List of orders + invoice hints" with no schema. */
export type InvoiceList = JsonObject;

/** TODO(spec): GET /usage/summary 200 is "Totals for days, MTD, today" with no schema. */
export type UsageSummary = JsonObject;

/** JSON strings on the wire. Helpers parse them with parseRollupNumber. */
export interface UsageEsimRollup {
  iccid: string;
  provider: string;
  tier: string;
  provision_status: string;
  usage_usd: string;
  usage_eur: string;
  usage_events: string;
  first_event: string | null;
  last_event: string | null;
}

/** GET /usage/esims and GET /usage/lines. The array key is `lines`, not `esims`. */
export interface UsageEsims {
  window: { since: string; until: string | null };
  lines: UsageEsimRollup[];
}

/**
 * GET /usage/cdrs row. Without `accounting=1`, bytes and network text stay empty.
 * That empty payload is not measured zero. With `accounting=1`, `detail_available`
 * false means the detail join missed; true with bytes 0 is measured zero.
 * `ledger_id` equals `id` when accounting is on.
 */
export interface Cdr {
  id: number;
  ledger_id?: number;
  detail_available?: boolean;
  iccid: string;
  provider: string;
  amount_usd: number;
  amount_eur: number;
  currency: string;
  customer_total_after: number | null;
  /** Ledger write time, `Y-m-d H:i:s`. Not the supplier session time. */
  created_at: string;
  note: string;
  bytes: number;
  mb: number;
  country: string;
  operator: string;
  rat: string;
  mcc: string;
  mnc: string;
  tadig: string;
}

export interface CdrList {
  cdrs: Cdr[];
  total: number;
  page: number;
  pages: number;
  /** Present in `after_id` mode. Last returned id, or null when the cursor is exhausted. */
  next_cursor?: number | null;
}

/** data object of usage.recorded. Amounts are absolute. occurred_at is UTC `Y-m-d H:i:s`. */
export interface UsageRecordedData {
  iccid: string;
  esim_id: number;
  client_reference: string;
  idempotency_key: string;
  occurred_at: string;
  currency: "USD" | "EUR";
  amount: number;
  amount_usd: number;
  amount_eur: number;
  bytes: number;
  mb: number;
  country: string;
  operator: string;
  network: string;
  rat: string;
  mcc: string;
  mnc: string;
  tadig: string;
  balance_after: number | null;
  /** Ledger row id when the debit insert returned one. Null on older events. Not the envelope id. */
  ledger_id?: number | null;
}

/**
 * GET /usage/timeseries describes a series of these points.
 * TODO(spec): the parent envelope is not published.
 */
export interface UsageTimeseriesPoint {
  day?: string;
  usage_usd?: number;
  topup_usd?: number;
  events?: number;
  [key: string]: unknown;
}

export type UsageTimeseries = JsonObject & {
  series?: UsageTimeseriesPoint[];
  points?: UsageTimeseriesPoint[];
  data?: UsageTimeseriesPoint[];
};

/** GET /api-keys 200 is described only as "List." */
export type ApiKeyList = JsonObject;

/** POST /api-keys 201 describes these properties. */
export type ApiKeyCreated = JsonObject & {
  public_id?: string;
  secret?: string;
  scopes?: string[];
  warning?: string;
};

/** GET /webhooks 200 is "Configured webhook URL and event list." */
export type WebhookConfigResponse = JsonObject;

/** GET /webhooks/events describes this catalog. */
export interface WebhookEventCatalogItem {
  event?: string;
  description?: string;
  subscribed?: boolean;
  [key: string]: unknown;
}

export type WebhookEventCatalog = JsonObject & {
  events?: WebhookEventCatalogItem[];
};

/** GET /webhooks/secret describes these properties. */
export type WebhookSecret = JsonObject & {
  algorithm?: string;
  header_v1?: string;
  signed_payload?: string;
  active_secret?: string;
  rotating_secret?: string | null;
};

/** TODO(spec): delivery list and detail responses have no schema. */
export type DeliveryPage = JsonObject;
export type WebhookDelivery = JsonObject;

/** GET /thresholds 200 is `{ rules: [...] }`. Rule items match ThresholdRule plus an id when returned. */
export type ThresholdList = JsonObject & {
  rules?: Array<ThresholdRule & { id?: number | string }>;
};

/** POST /thresholds 201 is `{ id }`. */
export type ThresholdCreated = JsonObject & {
  id?: number | string;
};

export interface IterateOptions {
  /** Default 100. Stops the helper if the API ignores `page`. */
  maxPages?: number;
  signal?: AbortSignal;
}

/**
 * Events named in the human API reference.
 * The OpenAPI schema types `event` as a string. Confirm the live set with
 * GET /webhooks/events.
 */
export const WEBHOOK_EVENT_NAMES = [
  "esim.provisioned",
  "esim.provision_failed",
  "esim.tier_changed",
  "esim.suspended",
  "esim.reactivated",
  "esim.terminated",
  "esim.exchanged",
  "esim.usage_threshold",
  "balance.topup",
  "balance.low",
  "balance.exhausted",
  "usage.recorded",
  "job.completed",
  "job.failed",
  "test.ping",
] as const;

export type KnownWebhookEvent = (typeof WEBHOOK_EVENT_NAMES)[number];

export interface ActivationDetails {
  /**
   * TODO(spec): Job and esim.provisioned `data` do not name activation
   * properties. Strings are copied only when present in the JSON.
   */
  lpa?: string;
  qr?: string;
  iccid?: string;
  smdpAddress?: string;
  matchingId?: string;
  activationCode?: string;
  matchedKeys: string[];
}

export interface OperationDescriptor {
  id: string;
  method: HttpMethod;
  path: string;
  summary: string;
  /** Sends Idempotency-Key when autoIdempotencyKey is enabled. */
  autoIdempotency: boolean;
}
