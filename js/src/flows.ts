import { NxtlInsufficientBalanceError, NxtlJobFailedError, NxtlTimeoutError } from "./errors.js";
import { jobIdOf, jobIsFailed, jobIsTerminal, type NxtlClient } from "./client.js";
import { defaultSleep } from "./retry.js";
import { readJsonObject } from "./http.js";
import { extractItems } from "./pagination.js";
import type {
  ActivationDetails,
  ApiResponse,
  Balance,
  BulkIssueRequest,
  CallOptions,
  CdrQuery,
  Estimate,
  ESimIssueRequest,
  Job,
  JobAccepted,
  JsonObject,
  Quotas,
  ThresholdRule,
  UsageEsimsQuery,
  UsageSummaryQuery,
} from "./types.js";

export interface PollJobOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

export interface FulfilEsimOrderParams extends PollJobOptions {
  clientReference: string;
  nickname?: string;
  tier?: ESimIssueRequest["tier"];
  idempotencyKey?: string;
  /**
   * When true (default), call POST /esims/estimate first.
   * If the body contains `affordable: false`, the helper throws.
   * TODO(spec): `affordable` is named in the human reference, not in the OpenAPI schema.
   */
  estimate?: boolean;
  /** When false, a failed terminal job is returned instead of thrown. Default true. */
  throwOnFailed?: boolean;
}

export interface FulfilEsimOrderResult {
  estimate?: ApiResponse<Estimate>;
  accepted: ApiResponse<JobAccepted>;
  job: ApiResponse<Job>;
  activation: ActivationDetails;
}

/**
 * Estimate (optional), POST /esims, then poll GET /jobs/{id}.
 * Activation strings are returned only when the job JSON already contains them.
 * A 202 response is not treated as a provisioned profile.
 */
export async function fulfilEsimOrder(
  client: NxtlClient,
  params: FulfilEsimOrderParams,
): Promise<FulfilEsimOrderResult> {
  if (!params.clientReference) throw new TypeError("clientReference is required");
  let estimate: ApiResponse<Estimate> | undefined;
  if (params.estimate !== false) {
    const body: { quantity: number; tier?: ESimIssueRequest["tier"] } = { quantity: 1 };
    if (params.tier !== undefined) body.tier = params.tier;
    estimate = await client.estimate(body);
    if (readJsonObject(estimate.data).affordable === false) {
      throw new NxtlInsufficientBalanceError(
        "POST /esims/estimate reported affordable: false",
        { status: estimate.status, body: estimate.data, headers: estimate.headers, requestId: estimate.requestId },
      );
    }
  }
  const issue: ESimIssueRequest = { client_reference: params.clientReference };
  if (params.nickname !== undefined) issue.nickname = params.nickname;
  if (params.tier !== undefined) issue.tier = params.tier;
  const call: CallOptions = {};
  if (params.idempotencyKey !== undefined) call.idempotencyKey = params.idempotencyKey;
  if (params.signal !== undefined) call.signal = params.signal;
  const accepted = await client.issueEsim(issue, call);
  const jobId = jobIdOf(accepted.data);
  if (!jobId) {
    throw new NxtlJobFailedError("POST /esims did not include job_id", accepted.data);
  }
  const job = await pollJob(client, jobId, params);
  if ((params.throwOnFailed ?? true) && jobIsFailed(job.data)) {
    throw new NxtlJobFailedError(`Job ${jobId} finished with status ${String(readJsonObject(job.data).status)}`, job.data);
  }
  const result: FulfilEsimOrderResult = {
    accepted,
    job,
    activation: extractActivation(job.data),
  };
  if (estimate) result.estimate = estimate;
  return result;
}

export async function pollJob(
  client: NxtlClient,
  jobId: number | string,
  options: PollJobOptions = {},
): Promise<ApiResponse<Job>> {
  const intervalMs = options.intervalMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const sleep = options.sleep ?? defaultSleep;
  const started = Date.now();
  let latest = await client.getJob(jobId, options.signal ? { signal: options.signal } : undefined);
  while (!jobIsTerminal(latest.data)) {
    if (options.signal?.aborted) {
      throw new NxtlTimeoutError("Job poll aborted", { status: 0, code: "aborted", body: latest.data });
    }
    if (Date.now() - started >= timeoutMs) {
      throw new NxtlTimeoutError(`Job ${String(jobId)} was not terminal after ${timeoutMs}ms`, {
        status: 0,
        code: "job_timeout",
        body: latest.data,
      });
    }
    await sleep(intervalMs);
    latest = await client.getJob(jobId, options.signal ? { signal: options.signal } : undefined);
  }
  return latest;
}

export interface BulkCollectResult {
  accepted: ApiResponse<JobAccepted>;
  job: ApiResponse<Job>;
  /** TODO(spec): row schema is not published. The first object array found on the job is returned. */
  rows: JsonObject[];
}

export async function submitAndCollectBulkIssue(
  client: NxtlClient,
  body: BulkIssueRequest,
  options: PollJobOptions & { idempotencyKey?: string; throwOnFailed?: boolean } = {},
): Promise<BulkCollectResult> {
  const call: CallOptions = {};
  if (options.idempotencyKey !== undefined) call.idempotencyKey = options.idempotencyKey;
  if (options.signal !== undefined) call.signal = options.signal;
  const accepted = await client.bulkIssue(body, call);
  const jobId = jobIdOf(accepted.data);
  if (!jobId) throw new NxtlJobFailedError("POST /esims/bulk-issue did not include job_id", accepted.data);
  const job = await pollJob(client, jobId, options);
  if ((options.throwOnFailed ?? true) && jobIsFailed(job.data)) {
    throw new NxtlJobFailedError(`Bulk job ${jobId} failed`, job.data);
  }
  return { accepted, job, rows: extractJobRows(job.data) };
}

export function extractJobRows(payload: unknown): JsonObject[] {
  const body = readJsonObject(payload);
  for (const key of ["results", "rows", "items", "esims", "lines"]) {
    const value = body[key];
    if (Array.isArray(value)) return value.filter(isObject);
  }
  return extractItems(body);
}

/**
 * Walk a job or webhook `data` object for installation strings.
 * TODO(spec): no activation schema is published. An LPA is recognised only
 * by the `LPA:` prefix. QR is copied from a string property whose name
 * contains "qr".
 */
export function extractActivation(payload: unknown): ActivationDetails {
  const found: ActivationDetails = { matchedKeys: [] };
  walk(payload, "", found);
  return found;
}

function walk(value: unknown, key: string, found: ActivationDetails): void {
  if (typeof value === "string") {
    consider(key, value, found);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, key, found);
    return;
  }
  if (isObject(value)) {
    for (const [childKey, child] of Object.entries(value)) walk(child, childKey, found);
  }
}

function consider(key: string, value: string, found: ActivationDetails): void {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!found.lpa && value.startsWith("LPA:")) {
    found.lpa = value;
    found.matchedKeys.push(key || "lpa");
  }
  if (!found.qr && normalized.includes("qr") && value.length > 0) {
    found.qr = value;
    found.matchedKeys.push(key);
  }
  if (!found.iccid && (normalized === "iccid" || normalized.endsWith("iccid"))) {
    found.iccid = value;
    found.matchedKeys.push(key);
  }
  if (!found.smdpAddress && (normalized.includes("smdp") || normalized.includes("smdpaddress"))) {
    found.smdpAddress = value;
    found.matchedKeys.push(key);
  }
  if (!found.matchingId && normalized.includes("matchingid")) {
    found.matchingId = value;
    found.matchedKeys.push(key);
  }
  if (!found.activationCode && normalized.includes("activationcode") && !value.startsWith("LPA:")) {
    found.activationCode = value;
    found.matchedKeys.push(key);
  }
  if (!found.lpa && normalized.includes("activationcode") && value.startsWith("LPA:")) {
    found.lpa = value;
  }
}

/**
 * Candidate property names for a pooled USD balance.
 * TODO(spec): GET /balance has no schema. `available_usd` appears in the
 * insufficient-balance error example in the human reference, not as a
 * balance-response field. The first finite number wins.
 */
export const BALANCE_AMOUNT_CANDIDATE_KEYS = [
  "balance_usd",
  "available_usd",
  "available_balance_usd",
  "pooled_balance_usd",
  "pool_balance_usd",
  "balance",
] as const;

export interface BalanceAssessment {
  response: ApiResponse<Balance>;
  amountUsd?: number;
  currency?: string;
  candidateKey?: string;
  status: "unknown" | "ok" | "low" | "exhausted";
  lowUsd?: number;
  exhaustedUsd?: number;
}

export async function assessBalance(
  client: NxtlClient,
  thresholds: { lowUsd?: number; exhaustedUsd?: number } = {},
  options?: CallOptions,
): Promise<BalanceAssessment> {
  const response = await client.getBalance(options);
  const located = findNumber(response.data, BALANCE_AMOUNT_CANDIDATE_KEYS);
  const currency = findString(response.data, ["currency"]);
  const exhaustedAt = thresholds.exhaustedUsd ?? 0;
  let status: BalanceAssessment["status"] = "unknown";
  if (located) {
    if (located.value <= exhaustedAt) status = "exhausted";
    else if (thresholds.lowUsd !== undefined && located.value <= thresholds.lowUsd) status = "low";
    else status = "ok";
  }
  const assessment: BalanceAssessment = { response, status };
  if (located) {
    assessment.amountUsd = located.value;
    assessment.candidateKey = located.key;
  }
  if (currency) assessment.currency = currency;
  if (thresholds.lowUsd !== undefined) assessment.lowUsd = thresholds.lowUsd;
  if (thresholds.exhaustedUsd !== undefined) assessment.exhaustedUsd = thresholds.exhaustedUsd;
  return assessment;
}

export async function ensureBalanceThreshold(
  client: NxtlClient,
  rule: Pick<ThresholdRule, "threshold_value"> & Partial<Omit<ThresholdRule, "metric" | "threshold_value">> & {
    metric?: ThresholdRule["metric"];
  },
  options?: CallOptions,
): Promise<ApiResponse<{ id?: number | string }>> {
  const body: ThresholdRule = {
    metric: rule.metric ?? "balance_below",
    threshold_value: rule.threshold_value,
    scope: rule.scope ?? "balance",
    operator: rule.operator ?? "<=",
    period: rule.period ?? "instant",
    action: rule.action ?? "notify",
    enabled: rule.enabled ?? true,
  };
  if (rule.notes !== undefined) body.notes = rule.notes;
  return client.createThreshold(body, options);
}

export interface UsageReport {
  summary: ApiResponse<JsonObject>;
  timeseries: ApiResponse<JsonObject>;
  esims: ApiResponse<JsonObject>;
  cdrs?: JsonObject[];
  /**
   * Sum of `amount_usd` / `amount_eur` when those properties exist on CDR rows.
   * TODO(spec): CDR items are not schematized. The human reference says a
   * zero converted amount must not be read as free usage.
   */
  totals?: UsageTotals;
}

export interface UsageTotals {
  rows: number;
  amountUsd: number;
  amountEur: number;
  rowsWithUsd: number;
  rowsWithEur: number;
  zeroIsNotFree: boolean;
}

export async function collectUsage(
  client: NxtlClient,
  query: {
    iccid?: string;
    days?: number;
    since?: string;
    until?: string;
    includeCdrs?: boolean;
    cdrPerPage?: number;
    maxCdrPages?: number;
  } = {},
): Promise<UsageReport> {
  const summaryQuery: UsageSummaryQuery = {};
  if (query.days !== undefined) summaryQuery.days = query.days;
  const esimQuery: UsageEsimsQuery = {};
  if (query.since !== undefined) esimQuery.since = query.since;
  if (query.until !== undefined) esimQuery.until = query.until;
  if (query.iccid !== undefined) esimQuery.iccid = query.iccid;
  const [summary, timeseries, esims] = await Promise.all([
    client.usageSummary(summaryQuery),
    client.usageTimeseries(query.days !== undefined ? { days: query.days } : undefined),
    client.usageEsims(esimQuery),
  ]);
  const report: UsageReport = { summary, timeseries, esims };
  if (query.includeCdrs) {
    const cdrQuery: Omit<CdrQuery, "page"> = { per_page: query.cdrPerPage ?? 100 };
    if (query.iccid !== undefined) cdrQuery.iccid = query.iccid;
    if (query.since !== undefined) cdrQuery.since = query.since;
    if (query.until !== undefined) cdrQuery.until = query.until;
    const rows: JsonObject[] = [];
    let pages = 0;
    const maxPages = query.maxCdrPages ?? 20;
    for await (const row of client.iterateUsageCdrs(cdrQuery, { maxPages })) {
      rows.push(row);
      if (pages > maxPages * (cdrQuery.per_page ?? 100)) break;
      pages += 1;
    }
    report.cdrs = rows;
    report.totals = sumUsageAmounts(rows);
  }
  return report;
}

export function sumUsageAmounts(rows: readonly JsonObject[]): UsageTotals {
  const totals: UsageTotals = {
    rows: rows.length,
    amountUsd: 0,
    amountEur: 0,
    rowsWithUsd: 0,
    rowsWithEur: 0,
    zeroIsNotFree: false,
  };
  for (const row of rows) {
    const usd = typeof row.amount_usd === "number" ? row.amount_usd : undefined;
    const eur = typeof row.amount_eur === "number" ? row.amount_eur : undefined;
    if (usd !== undefined) {
      totals.amountUsd += usd;
      totals.rowsWithUsd += 1;
    }
    if (eur !== undefined) {
      totals.amountEur += eur;
      totals.rowsWithEur += 1;
    }
    if ((usd === 0 && eur !== undefined && eur !== 0) || (eur === 0 && usd !== undefined && usd !== 0)) {
      totals.zeroIsNotFree = true;
    }
  }
  return totals;
}

/**
 * Read issuance-fee-like numbers from GET /quotas.
 * TODO(spec): the quotas response has no schema. Candidate keys are guesses
 * from the operation summary ("issuance fee") and are returned only when present.
 */
export const ISSUANCE_FEE_CANDIDATE_KEYS = [
  "issuance_fee_usd",
  "issuance_fee",
  "fee_usd",
] as const;

export function readIssuanceFee(quotas: Quotas): { value: number; key: string } | undefined {
  return findNumber(quotas, ISSUANCE_FEE_CANDIDATE_KEYS);
}

function findNumber(
  payload: unknown,
  keys: readonly string[],
): { value: number; key: string } | undefined {
  const wanted = new Set(keys);
  let found: { value: number; key: string } | undefined;
  const visit = (value: unknown): void => {
    if (found || !isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(key) && typeof child === "number" && Number.isFinite(child)) {
        found = { value: child, key };
        return;
      }
    }
    for (const child of Object.values(value)) {
      if (isObject(child)) visit(child);
      if (found) return;
    }
  };
  visit(payload);
  return found;
}

function findString(payload: unknown, keys: readonly string[]): string | undefined {
  if (!isObject(payload)) return undefined;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  for (const value of Object.values(payload)) {
    if (isObject(value)) {
      const nested = findString(value, keys);
      if (nested) return nested;
    }
  }
  return undefined;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
