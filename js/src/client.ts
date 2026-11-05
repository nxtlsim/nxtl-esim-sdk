import { executeRequest, readJsonObject, resolveConfig, type ResolvedConfig } from "./http.js";
import { iteratePages } from "./pagination.js";
import type {
  Ack,
  ApiKeyCreateRequest,
  ApiKeyCreated,
  ApiKeyList,
  ApiResponse,
  AuditPage,
  AuditQuery,
  Balance,
  BulkIssueRequest,
  BulkStatusRow,
  BulkTierBody,
  CallOptions,
  CdrQuery,
  DeliveryPage,
  DeliveryQuery,
  ESim,
  ESimIssueRequest,
  ESimsPage,
  Estimate,
  EstimateRequest,
  EsimListQuery,
  HealthResponse,
  HttpMethod,
  InvoiceList,
  IterateOptions,
  Job,
  JobAccepted,
  JobList,
  JsonObject,
  LedgerPage,
  NicknameBody,
  NxtlClientOptions,
  PageQuery,
  Partner,
  Quotas,
  StatusBody,
  ThresholdCreated,
  ThresholdList,
  ThresholdRule,
  TierBody,
  TimeseriesQuery,
  TopupRequest,
  UsageEsims,
  UsageEsimsQuery,
  UsageList,
  UsageSummary,
  UsageSummaryQuery,
  UsageTimeseries,
  Wallet,
  WebhookConfigRequest,
  WebhookConfigResponse,
  WebhookDelivery,
  WebhookEventCatalog,
  WebhookSecret,
  EventList,
  IccidListBody,
} from "./types.js";
import {
  assertAction,
  assertAmountUsd,
  assertIccid,
  assertIccids,
  assertIntegerId,
  assertNickname,
  assertPage,
  assertQuantity,
  assertThreshold,
  assertTier,
  compactQuery,
  encodePath,
} from "./util.js";

/**
 * Client for the NXTL eSIM B2B API (`https://nxtlsim.com/api/v1`).
 * Every method maps to one OpenAPI operation. Pass `request` for a path
 * the document does not list yet.
 */
export class NxtlClient {
  readonly config: ResolvedConfig;

  constructor(options: NxtlClientOptions = {}) {
    this.config = resolveConfig(options);
  }

  /** Low-level call. `path` is relative to the configured base URL and must start with `/`. */
  request<T = JsonObject>(
    method: HttpMethod,
    path: string,
    init: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      options?: CallOptions;
      autoIdempotency?: boolean;
    } = {},
  ): Promise<ApiResponse<T>> {
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value === undefined) continue;
      query[key] = String(value);
    }
    return executeRequest<T>(this.config, {
      method,
      path,
      ...(Object.keys(query).length > 0 ? { query } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.options !== undefined ? { options: init.options } : {}),
      ...(init.autoIdempotency !== undefined ? { autoIdempotency: init.autoIdempotency } : {}),
    });
  }

  /** GET /health — public, no API key. */
  health(options?: CallOptions): Promise<ApiResponse<HealthResponse>> {
    return this.call("GET", "/health", { options });
  }

  /** GET /partner — profile and scopes resolved by the key. */
  partner(options?: CallOptions): Promise<ApiResponse<Partner>> {
    return this.call("GET", "/partner", { options });
  }

  /** GET /quotas — balance, quota, rate limit, issuance fee, subscription state. */
  quotas(options?: CallOptions): Promise<ApiResponse<Quotas>> {
    return this.call("GET", "/quotas", { options });
  }

  /** GET /audit — partner-scoped audit log. */
  audit(query?: AuditQuery, options?: CallOptions): Promise<ApiResponse<AuditPage>> {
    assertPage(query?.page, query?.per_page, 200);
    return this.call("GET", "/audit", { query: compactQuery(query), options });
  }

  iterateAudit(query?: Omit<AuditQuery, "page">, options?: IterateOptions): AsyncIterable<JsonObject> {
    const perPage = query?.per_page ?? 50;
    assertPage(undefined, perPage, 200);
    return iteratePages((page) => this.audit({ ...query, page, per_page: perPage }, signalOptions(options)), {
      ...options,
      perPage,
    });
  }

  /** GET /esims — list the fleet. */
  listEsims(query?: EsimListQuery, options?: CallOptions): Promise<ApiResponse<ESimsPage>> {
    assertPage(query?.page, query?.per_page, 200);
    return this.call("GET", "/esims", { query: compactQuery(query), options });
  }

  iterateEsims(query?: Omit<EsimListQuery, "page">, options?: IterateOptions): AsyncIterable<JsonObject> {
    const perPage = query?.per_page ?? 50;
    assertPage(undefined, perPage, 200);
    return iteratePages((page) => this.listEsims({ ...query, page, per_page: perPage }, signalOptions(options)), {
      ...options,
      perPage,
    });
  }

  /**
   * POST /esims — queue one eSIM. Returns 202 and a job id.
   * The profile is not ready until the job completes or `esim.provisioned` arrives.
   */
  issueEsim(body?: ESimIssueRequest, options?: CallOptions): Promise<ApiResponse<JobAccepted>> {
    if (body?.nickname !== undefined) assertNickname(body.nickname);
    if (body?.tier !== undefined) assertTier(body.tier);
    return this.call("POST", "/esims", { body: body ?? {}, options, autoIdempotency: true });
  }

  /** GET /lines — legacy alias of GET /esims. */
  listLines(query?: EsimListQuery, options?: CallOptions): Promise<ApiResponse<ESimsPage>> {
    assertPage(query?.page, query?.per_page, 200);
    return this.call("GET", "/lines", { query: compactQuery(query), options });
  }

  iterateLines(query?: Omit<EsimListQuery, "page">, options?: IterateOptions): AsyncIterable<JsonObject> {
    const perPage = query?.per_page ?? 50;
    assertPage(undefined, perPage, 200);
    return iteratePages((page) => this.listLines({ ...query, page, per_page: perPage }, signalOptions(options)), {
      ...options,
      perPage,
    });
  }

  /** GET /esims/{iccid}. */
  getEsim(iccid: string, options?: CallOptions): Promise<ApiResponse<ESim>> {
    return this.call("GET", `/esims/${encodePath(assertIccid(iccid))}`, { options });
  }

  /** PATCH /esims/{iccid}/nickname. */
  updateNickname(iccid: string, body: NicknameBody, options?: CallOptions): Promise<ApiResponse<ESim>> {
    assertNickname(body.nickname);
    return this.call("PATCH", `/esims/${encodePath(assertIccid(iccid))}/nickname`, { body, options });
  }

  /** PATCH /esims/{iccid}/tier. */
  updateTier(iccid: string, body: TierBody, options?: CallOptions): Promise<ApiResponse<ESim>> {
    assertTier(body.tier);
    return this.call("PATCH", `/esims/${encodePath(assertIccid(iccid))}/tier`, { body, options });
  }

  /** PATCH /esims/{iccid}/status — suspend, reactivate, or terminate. */
  updateStatus(iccid: string, body: StatusBody, options?: CallOptions): Promise<ApiResponse<Ack>> {
    assertAction(body.action);
    return this.call("PATCH", `/esims/${encodePath(assertIccid(iccid))}/status`, { body, options });
  }

  /** POST /esims/{iccid}/suspend. */
  suspendEsim(iccid: string, options?: CallOptions): Promise<ApiResponse<Ack>> {
    return this.call("POST", `/esims/${encodePath(assertIccid(iccid))}/suspend`, { options });
  }

  /** POST /esims/{iccid}/resume. */
  resumeEsim(iccid: string, options?: CallOptions): Promise<ApiResponse<Ack>> {
    return this.call("POST", `/esims/${encodePath(assertIccid(iccid))}/resume`, { options });
  }

  /** GET /esims/{iccid}/wallet. */
  getWallet(iccid: string, options?: CallOptions): Promise<ApiResponse<Wallet>> {
    return this.call("GET", `/esims/${encodePath(assertIccid(iccid))}/wallet`, { options });
  }

  /** GET /esims/{iccid}/usage. */
  getEsimUsage(iccid: string, options?: CallOptions): Promise<ApiResponse<UsageList>> {
    return this.call("GET", `/esims/${encodePath(assertIccid(iccid))}/usage`, { options });
  }

  /** GET /esims/{iccid}/events. */
  getEsimEvents(iccid: string, options?: CallOptions): Promise<ApiResponse<EventList>> {
    return this.call("GET", `/esims/${encodePath(assertIccid(iccid))}/events`, { options });
  }

  /** POST /esims/bulk-status — up to 100 ICCIDs. */
  bulkStatus(body: IccidListBody, options?: CallOptions): Promise<ApiResponse<BulkStatusRow[] | JsonObject>> {
    return this.call("POST", "/esims/bulk-status", {
      body: { iccids: assertIccids(body.iccids, 100) },
      options,
    });
  }

  /** POST /esims/bulk-tier — up to 1000 ICCIDs. */
  bulkTier(body: BulkTierBody, options?: CallOptions): Promise<ApiResponse<Ack>> {
    assertTier(body.tier);
    return this.call("POST", "/esims/bulk-tier", {
      body: { iccids: assertIccids(body.iccids, 1000), tier: body.tier },
      options,
    });
  }

  /** POST /esims/bulk-issue — async, quantity 1 to 1000. Returns 202 and a job id. */
  bulkIssue(body: BulkIssueRequest, options?: CallOptions): Promise<ApiResponse<JobAccepted>> {
    assertQuantity(body.quantity);
    if (body.tier !== undefined) assertTier(body.tier);
    return this.call("POST", "/esims/bulk-issue", { body, options, autoIdempotency: true });
  }

  /** POST /esims/estimate — cost check. Does not create eSIMs. */
  estimate(body: EstimateRequest, options?: CallOptions): Promise<ApiResponse<Estimate>> {
    assertQuantity(body.quantity);
    if (body.tier !== undefined) assertTier(body.tier);
    return this.call("POST", "/esims/estimate", { body, options });
  }

  /**
   * GET /jobs.
   * TODO(spec): described as paginated, with no page or per_page parameters.
   */
  listJobs(options?: CallOptions): Promise<ApiResponse<JobList>> {
    return this.call("GET", "/jobs", { options });
  }

  /** GET /jobs/{id} — detail and per-row results. */
  getJob(id: number | string, options?: CallOptions): Promise<ApiResponse<Job>> {
    return this.call("GET", `/jobs/${encodePath(assertIntegerId(id, "id"))}`, { options });
  }

  /** GET /esim-requests/{job_id} — legacy alias of GET /jobs/{id}. */
  getEsimRequest(jobId: number | string, options?: CallOptions): Promise<ApiResponse<Job>> {
    return this.call("GET", `/esim-requests/${encodePath(assertIntegerId(jobId, "job_id"))}`, { options });
  }

  /** GET /balance — pool totals and per-eSIM wallet mirrors. */
  getBalance(options?: CallOptions): Promise<ApiResponse<Balance>> {
    return this.call("GET", "/balance", { options });
  }

  /** GET /balance/history. */
  listBalanceHistory(query?: PageQuery, options?: CallOptions): Promise<ApiResponse<LedgerPage>> {
    assertPage(query?.page, query?.per_page);
    return this.call("GET", "/balance/history", { query: compactQuery(query), options });
  }

  iterateBalanceHistory(query?: Omit<PageQuery, "page">, options?: IterateOptions): AsyncIterable<JsonObject> {
    const perPage = query?.per_page ?? 50;
    assertPage(undefined, perPage);
    return iteratePages(
      (page) => this.listBalanceHistory({ ...query, page, per_page: perPage }, signalOptions(options)),
      { ...options, perPage },
    );
  }

  /**
   * POST /topup — credit the pooled balance from the partner prepaid budget.
   * This does not charge a saved card. Send an idempotency key (generated when omitted).
   */
  topup(body: TopupRequest, options?: CallOptions): Promise<ApiResponse<Ack>> {
    assertAmountUsd(body.amount_usd);
    return this.call("POST", "/topup", { body, options, autoIdempotency: true });
  }

  /** GET /invoices — orders associated with API-driven top-ups. */
  listInvoices(options?: CallOptions): Promise<ApiResponse<InvoiceList>> {
    return this.call("GET", "/invoices", { options });
  }

  /** GET /usage/summary. */
  usageSummary(query?: UsageSummaryQuery, options?: CallOptions): Promise<ApiResponse<UsageSummary>> {
    if (query?.days !== undefined && (!Number.isInteger(query.days) || query.days < 1)) {
      throw new TypeError("days must be an integer >= 1");
    }
    return this.call("GET", "/usage/summary", { query: compactQuery(query), options });
  }

  /** GET /usage/esims. */
  usageEsims(query?: UsageEsimsQuery, options?: CallOptions): Promise<ApiResponse<UsageEsims>> {
    if (query?.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 500)) {
      throw new TypeError("limit must be an integer from 1 to 500");
    }
    return this.call("GET", "/usage/esims", { query: compactQuery(query), options });
  }

  /**
   * GET /usage/lines — legacy alias of GET /usage/esims.
   * TODO(spec): this operation publishes no query parameters, unlike GET /usage/esims.
   */
  usageLines(options?: CallOptions): Promise<ApiResponse<UsageEsims>> {
    return this.call("GET", "/usage/lines", { options });
  }

  /** GET /usage/cdrs. */
  usageCdrs(query?: CdrQuery, options?: CallOptions): Promise<ApiResponse<JsonObject>> {
    assertPage(query?.page, query?.per_page, 500);
    return this.call("GET", "/usage/cdrs", { query: compactQuery(query), options });
  }

  iterateUsageCdrs(query?: Omit<CdrQuery, "page">, options?: IterateOptions): AsyncIterable<JsonObject> {
    const perPage = query?.per_page ?? 100;
    assertPage(undefined, perPage, 500);
    return iteratePages((page) => this.usageCdrs({ ...query, page, per_page: perPage }, signalOptions(options)), {
      ...options,
      perPage,
    });
  }

  /** GET /usage/timeseries. `days` maximum 365. */
  usageTimeseries(query?: TimeseriesQuery, options?: CallOptions): Promise<ApiResponse<UsageTimeseries>> {
    if (query?.days !== undefined && (!Number.isInteger(query.days) || query.days < 1 || query.days > 365)) {
      throw new TypeError("days must be an integer from 1 to 365");
    }
    return this.call("GET", "/usage/timeseries", { query: compactQuery(query), options });
  }

  /** GET /api-keys — public identifiers only. */
  listApiKeys(options?: CallOptions): Promise<ApiResponse<ApiKeyList>> {
    return this.call("GET", "/api-keys", { options });
  }

  /** POST /api-keys — the secret is returned once. */
  createApiKey(body?: ApiKeyCreateRequest, options?: CallOptions): Promise<ApiResponse<ApiKeyCreated>> {
    return this.call("POST", "/api-keys", { ...(body !== undefined ? { body } : {}), options });
  }

  /** DELETE /api-keys/{key_public}. */
  revokeApiKey(keyPublic: string, options?: CallOptions): Promise<ApiResponse<Ack>> {
    if (typeof keyPublic !== "string" || keyPublic.length === 0) {
      throw new TypeError("key_public is required");
    }
    return this.call("DELETE", `/api-keys/${encodePath(keyPublic)}`, { options });
  }

  /** GET /webhooks. */
  getWebhooks(options?: CallOptions): Promise<ApiResponse<WebhookConfigResponse>> {
    return this.call("GET", "/webhooks", { options });
  }

  /** PUT /webhooks. */
  updateWebhooks(body?: WebhookConfigRequest, options?: CallOptions): Promise<ApiResponse<Ack>> {
    return this.call("PUT", "/webhooks", { body: body ?? {}, options });
  }

  /** GET /webhooks/events. */
  listWebhookEvents(options?: CallOptions): Promise<ApiResponse<WebhookEventCatalog>> {
    return this.call("GET", "/webhooks/events", { options });
  }

  /** GET /webhooks/secret. */
  getWebhookSecret(options?: CallOptions): Promise<ApiResponse<WebhookSecret>> {
    return this.call("GET", "/webhooks/secret", { options });
  }

  /** POST /webhooks/test — sends `test.ping`. */
  testWebhook(options?: CallOptions): Promise<ApiResponse<Ack>> {
    return this.call("POST", "/webhooks/test", { options });
  }

  /**
   * GET /webhooks/deliveries.
   * TODO(spec): `page` is published; `per_page` is not.
   */
  listWebhookDeliveries(query?: DeliveryQuery, options?: CallOptions): Promise<ApiResponse<DeliveryPage>> {
    assertPage(query?.page, undefined);
    return this.call("GET", "/webhooks/deliveries", { query: compactQuery(query), options });
  }

  iterateWebhookDeliveries(
    query?: Omit<DeliveryQuery, "page">,
    options?: IterateOptions,
  ): AsyncIterable<JsonObject> {
    return iteratePages((page) => this.listWebhookDeliveries({ ...query, page }, signalOptions(options)), options);
  }

  /** GET /webhooks/deliveries/{id}. */
  getWebhookDelivery(id: number | string, options?: CallOptions): Promise<ApiResponse<WebhookDelivery>> {
    return this.call("GET", `/webhooks/deliveries/${encodePath(assertIntegerId(id, "id"))}`, { options });
  }

  /** POST /webhooks/deliveries/{id}/replay. */
  replayWebhookDelivery(id: number | string, options?: CallOptions): Promise<ApiResponse<Ack>> {
    return this.call("POST", `/webhooks/deliveries/${encodePath(assertIntegerId(id, "id"))}/replay`, { options });
  }

  /** POST /webhooks/{id}/replay — legacy alias. */
  replayWebhookDeliveryLegacy(id: number | string, options?: CallOptions): Promise<ApiResponse<Ack>> {
    return this.call("POST", `/webhooks/${encodePath(assertIntegerId(id, "id"))}/replay`, { options });
  }

  /** GET /thresholds. */
  listThresholds(options?: CallOptions): Promise<ApiResponse<ThresholdList>> {
    return this.call("GET", "/thresholds", { options });
  }

  /** POST /thresholds. */
  createThreshold(body: ThresholdRule, options?: CallOptions): Promise<ApiResponse<ThresholdCreated>> {
    assertThreshold(body);
    return this.call("POST", "/thresholds", { body, options });
  }

  /** PATCH /thresholds/{id}. */
  updateThreshold(id: number | string, body: ThresholdRule, options?: CallOptions): Promise<ApiResponse<Ack>> {
    assertThreshold(body);
    return this.call("PATCH", `/thresholds/${encodePath(assertIntegerId(id, "id"))}`, { body, options });
  }

  /** DELETE /thresholds/{id}. */
  deleteThreshold(id: number | string, options?: CallOptions): Promise<ApiResponse<Ack>> {
    return this.call("DELETE", `/thresholds/${encodePath(assertIntegerId(id, "id"))}`, { options });
  }

  private call<T>(
    method: HttpMethod,
    path: string,
    init: {
      query?: Record<string, string>;
      body?: unknown;
      options?: CallOptions;
      autoIdempotency?: boolean;
    },
  ): Promise<ApiResponse<T>> {
    return executeRequest<T>(this.config, {
      method,
      path,
      ...(init.query ? { query: init.query } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.options ? { options: init.options } : {}),
      ...(init.autoIdempotency ? { autoIdempotency: true } : {}),
    });
  }
}

function signalOptions(options?: IterateOptions): CallOptions | undefined {
  if (!options?.signal) return undefined;
  return { signal: options.signal };
}

export function jobIdOf(payload: unknown): string | undefined {
  const body = readJsonObject(payload);
  const value = body.job_id ?? body.jobId ?? body.id;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

/**
 * TODO(spec): job status strings are not enumerated. The reference describes
 * pending or running, then complete or failed.
 */
const TERMINAL_JOB_STATUSES = new Set([
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
]);

export function jobStatusOf(payload: unknown): string | undefined {
  const body = readJsonObject(payload);
  const value = body.status ?? body.state;
  return typeof value === "string" ? value : undefined;
}

export function jobIsTerminal(payload: unknown): boolean {
  const status = jobStatusOf(payload);
  if (!status) return false;
  return TERMINAL_JOB_STATUSES.has(status.toLowerCase());
}

export function jobIsFailed(payload: unknown): boolean {
  const status = jobStatusOf(payload)?.toLowerCase() ?? "";
  return status.includes("fail") || status === "error" || status === "cancelled" || status === "canceled";
}
