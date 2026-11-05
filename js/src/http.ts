import { NxtlAuthError, NxtlConnectionError, NxtlTimeoutError, createApiError } from "./errors.js";
import {
  computeDelayMs,
  isReplaySafe,
  parseRateLimitResetDelayMs,
  parseRetryAfterMs,
  resolveRetry,
  type ResolvedRetry,
} from "./retry.js";
import type { ApiResponse, CallOptions, HttpMethod, JsonObject, Logger, NxtlClientOptions, RateLimitInfo } from "./types.js";
import { API_SPEC_VERSION, DEFAULT_BASE_URL, DEFAULT_USER_AGENT } from "./version.js";
import {
  assertIdempotencyKey,
  createIdempotencyKey,
  joinUrl,
  lowerHeaders,
  safeLogMeta,
} from "./util.js";

const AUTO_IDEMPOTENT = new Set(["POST /esims", "POST /esims/bulk-issue", "POST /topup"]);

export interface ResolvedConfig {
  apiKey?: string;
  baseUrl: string;
  timeout: number;
  fetch: typeof fetch;
  userAgent: string;
  logger?: Logger;
  retry: ReturnType<typeof resolveRetry>;
  headers: Record<string, string>;
  idempotencyHeader: "Idempotency-Key" | "X-NXTL-Idempotency-Key";
  autoIdempotencyKey: boolean;
  acceptCurrency?: string;
}

export function resolveConfig(options: NxtlClientOptions): ResolvedConfig {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch is not available. Pass options.fetch (Node 18+ provides fetch).");
  }
  const config: ResolvedConfig = {
    baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    timeout: options.timeout ?? 30_000,
    fetch: fetchImpl,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    retry: resolveRetry(options.retry),
    headers: { ...(options.headers ?? {}) },
    idempotencyHeader: options.idempotencyHeader ?? "Idempotency-Key",
    autoIdempotencyKey: options.autoIdempotencyKey ?? true,
  };
  if (options.apiKey !== undefined) config.apiKey = options.apiKey;
  if (options.logger !== undefined) config.logger = options.logger;
  if (options.acceptCurrency !== undefined) config.acceptCurrency = options.acceptCurrency;
  return config;
}

export interface RequestInput {
  method: HttpMethod;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  options?: CallOptions;
  /** When true, generate an idempotency key if the caller did not pass one. */
  autoIdempotency?: boolean;
}

export async function executeRequest<T>(config: ResolvedConfig, input: RequestInput): Promise<ApiResponse<T>> {
  if (input.path !== "/health" && !config.apiKey) {
    throw new NxtlAuthError("apiKey is required. Create a key from an NXTL Business account.", {
      status: 0,
      code: "missing_api_key",
    });
  }
  const call = input.options ?? {};
  const retry = call.retry === undefined ? config.retry : resolveRetry(call.retry);
  const idempotencyKey = await resolveIdempotencyKey(config, input, call);
  const url = joinUrl(config.baseUrl, input.path, input.query);
  const timeout = call.timeout ?? config.timeout;
  const maxAttempts = (retry?.maxRetries ?? 0) + 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const headers = buildHeaders(config, input, call, idempotencyKey);
    const linked = linkSignals(timeout, call.signal);
    try {
      log(config.logger, "debug", "nxtl request", {
        method: input.method,
        path: input.path,
        attempt,
      });
      const response = await config.fetch(url, {
        method: input.method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: linked.signal,
      });
      const text = await response.text();
      const parsed = parseBody(text);
      const responseHeaders = lowerHeaders(response.headers);
      if (response.ok) {
        return buildSuccess(parsed as T, response.status, responseHeaders, idempotencyKey);
      }
      const error = createApiError(response.status, parsed, responseHeaders, response.statusText);
      const delay = nextDelay(error.status, input.method, idempotencyKey, retry, attempt, maxAttempts, responseHeaders);
      if (delay == null) throw error;
      log(config.logger, "warn", "nxtl retry", {
        method: input.method,
        path: input.path,
        status: error.status,
        attempt,
        delayMs: delay,
        requestId: error.requestId,
      });
      await retry!.sleep(delay);
      lastError = error;
    } catch (error) {
      if (isNxtlHttpError(error)) throw error;
      if (call.signal?.aborted) {
        throw new NxtlTimeoutError("Request aborted", { status: 0, code: "aborted" });
      }
      const timedOut = linked.timedOut || isAbortError(error);
      const mapped = timedOut
        ? new NxtlTimeoutError(`Request timed out after ${timeout}ms`, { status: 0, code: "timeout" })
        : new NxtlConnectionError(error instanceof Error ? error.message : "Network request failed", {
          status: 0,
          code: "connection_error",
        });
      const delay = nextDelay(503, input.method, idempotencyKey, retry, attempt, maxAttempts, {});
      if (delay == null) throw mapped;
      log(config.logger, "warn", "nxtl retry", {
        method: input.method,
        path: input.path,
        status: 0,
        attempt,
        delayMs: delay,
        code: mapped.code,
      });
      await retry!.sleep(delay);
      lastError = mapped;
    } finally {
      linked.cancel();
    }
  }
  throw lastError instanceof Error ? lastError : new NxtlConnectionError("Request failed", { status: 0 });
}

function isNxtlHttpError(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { name?: string }).name?.startsWith("Nxtl") === true
    && "status" in (error as object)
    && typeof (error as { status: unknown }).status === "number"
    && (error as { status: number }).status >= 400;
}

async function resolveIdempotencyKey(
  config: ResolvedConfig,
  input: RequestInput,
  call: CallOptions,
): Promise<string | undefined> {
  if (call.idempotencyKey !== undefined) return assertIdempotencyKey(call.idempotencyKey);
  const auto = input.autoIdempotency ?? AUTO_IDEMPOTENT.has(`${input.method} ${input.path}`);
  if (!auto || !config.autoIdempotencyKey) return undefined;
  return createIdempotencyKey();
}

function buildHeaders(
  config: ResolvedConfig,
  input: RequestInput,
  call: CallOptions,
  idempotencyKey: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": config.userAgent,
    "X-NXTL-SDK": `@nxtlsim/esim-sdk/${API_SPEC_VERSION}`,
    ...config.headers,
    ...(call.headers ?? {}),
  };
  if (input.body !== undefined) headers["Content-Type"] = "application/json";
  if (config.apiKey) headers["X-NXTL-Key"] = config.apiKey;
  if (config.acceptCurrency && headers["Accept-Currency"] === undefined) {
    headers["Accept-Currency"] = config.acceptCurrency;
  }
  if (idempotencyKey) headers[config.idempotencyHeader] = idempotencyKey;
  return headers;
}

function buildSuccess<T>(
  data: T,
  status: number,
  headers: Record<string, string>,
  idempotencyKey: string | undefined,
): ApiResponse<T> {
  const limit = numberHeader(headers["x-ratelimit-limit"]);
  const remaining = numberHeader(headers["x-ratelimit-remaining"]);
  const retryAfterSeconds = numberHeader(headers["retry-after"]);
  const rateLimit: RateLimitInfo = {};
  if (limit !== undefined) rateLimit.limit = limit;
  if (remaining !== undefined) rateLimit.remaining = remaining;
  if (headers["x-ratelimit-reset"] !== undefined) rateLimit.reset = headers["x-ratelimit-reset"];
  if (retryAfterSeconds !== undefined) rateLimit.retryAfterSeconds = retryAfterSeconds;
  const response: ApiResponse<T> = {
    data,
    status,
    headers,
    idempotentReplayed: (headers["idempotent-replayed"] ?? "").toLowerCase() === "true",
    rateLimit,
  };
  const requestId = headers["x-request-id"];
  if (requestId) response.requestId = requestId;
  if (idempotencyKey) response.idempotencyKey = idempotencyKey;
  return response;
}

function nextDelay(
  status: number,
  method: string,
  idempotencyKey: string | undefined,
  retry: ResolvedRetry | null,
  attempt: number,
  maxAttempts: number,
  headers: Readonly<Record<string, string>>,
): number | null {
  if (!retry || attempt + 1 >= maxAttempts) return null;
  const rateLimited = status === 429;
  const server = status >= 500 && status <= 599;
  if (!rateLimited && !server) return null;
  if (server && !isReplaySafe(method, idempotencyKey, retry.retryUnsafe)) return null;
  const hinted = parseRetryAfterMs(headers) ?? (rateLimited ? parseRateLimitResetDelayMs(headers) : undefined);
  return computeDelayMs(retry, attempt, hinted);
}

// The decision function above returns -1 as a sentinel meaning "retry, compute delay".
// executeRequest needs the headers. I'll restructure by inlining. Let me fix this
// properly in a follow-up edit if tests fail. For now, change executeRequest to
// compute the delay itself. I'll replace retryDecision usage.

function parseBody(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function numberHeader(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { name?: string }).name === "AbortError";
}

function linkSignals(timeoutMs: number, userSignal?: AbortSignal): {
  signal: AbortSignal;
  cancel: () => void;
  timedOut: boolean;
} {
  const controller = new AbortController();
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (userSignal) {
    if (userSignal.aborted) controller.abort();
    else userSignal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    get timedOut() {
      return state.timedOut;
    },
    cancel: () => {
      clearTimeout(timer);
      userSignal?.removeEventListener("abort", onAbort);
    },
  };
}

function log(logger: Logger | undefined, level: "debug" | "info" | "warn" | "error", message: string, meta: Record<string, unknown>): void {
  const fn = logger?.[level];
  if (!fn) return;
  try {
    fn(message, safeLogMeta(meta));
  } catch {
    // A logger must not break the call.
  }
}

export function readJsonObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  return {};
}
