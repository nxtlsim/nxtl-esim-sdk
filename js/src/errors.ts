import type { ErrorEnvelope, JsonObject } from "./types.js";

export interface NxtlErrorOptions {
  status: number;
  code?: string;
  errorType?: string;
  requestId?: string;
  docUrl?: string;
  details?: JsonObject;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
  retryAfterSeconds?: number;
}

/**
 * Base class for responses from the NXTL eSIM API.
 * `status` 0 means the SDK rejected the call before sending it.
 */
export class NxtlError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly errorType?: string;
  readonly requestId?: string;
  readonly docUrl?: string;
  readonly details?: JsonObject;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly retryAfterSeconds?: number;

  constructor(message: string, options: NxtlErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.code;
    this.errorType = options.errorType;
    this.requestId = options.requestId;
    this.docUrl = options.docUrl;
    this.details = options.details;
    this.headers = options.headers ?? {};
    this.body = options.body;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** HTTP 401, or a missing API key before the request is sent. */
export class NxtlAuthError extends NxtlError {}

/** HTTP 403. The key is valid and lacks the scope for the operation. */
export class NxtlAccessDeniedError extends NxtlAuthError {}

/** HTTP 400. */
export class NxtlValidationError extends NxtlError {}

/** HTTP 429. `retryAfterSeconds` is set when Retry-After was sent. */
export class NxtlRateLimitError extends NxtlError {}

/** HTTP 404. */
export class NxtlNotFoundError extends NxtlError {}

/** HTTP 5xx, including 502 upstream_error. */
export class NxtlServerError extends NxtlError {}

/** Network failure or a request that produced no HTTP response. */
export class NxtlConnectionError extends NxtlServerError {}

/** The SDK timeout elapsed. */
export class NxtlTimeoutError extends NxtlConnectionError {}

/** HTTP 402. Pooled balance or prepaid budget cannot cover the call. */
export class NxtlInsufficientBalanceError extends NxtlError {}

/** HTTP 409. */
export class NxtlConflictError extends NxtlError {}

/** HTTP 409 `already_terminated`. Reactivate cannot undo terminate. */
export class NxtlAlreadyTerminatedError extends NxtlConflictError {}

/** HTTP 402 `resume_blocked`. A usage guard blocked reactivate. */
export class NxtlResumeBlockedError extends NxtlError {}

/** HTTP 409 when the code is `quota_exhausted` (lifetime issuance quota). */
export class NxtlQuotaExceededError extends NxtlConflictError {}

/** Webhook signature or envelope checks. */
export class NxtlWebhookError extends NxtlError {
  constructor(message: string, options: Partial<NxtlErrorOptions> = {}) {
    super(message, {
      status: options.status ?? 0,
      headers: options.headers ?? {},
      ...options,
    });
  }
}

/** A polled job reached a failed terminal status. `body` is the job payload. */
export class NxtlJobFailedError extends NxtlError {
  constructor(message: string, body: unknown) {
    super(message, { status: 0, body });
  }
}

interface ParsedError {
  code?: string;
  errorType?: string;
  message: string;
  requestId?: string;
  docUrl?: string;
  details?: JsonObject;
}

export function parseErrorBody(body: unknown, statusText: string): ParsedError {
  if (isErrorEnvelope(body)) {
    return {
      code: body.code,
      errorType: body.type,
      message: body.message,
      requestId: body.request_id,
      docUrl: body.doc_url,
      details: body.details,
    };
  }
  // Human reference: some earlier operations return `{ "error": "code" }`.
  if (isCompactError(body)) {
    return { code: body.error, message: body.error };
  }
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") {
    return { message: body.message };
  }
  return { message: statusText || "NXTL API request failed" };
}

function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  return (
    record.error === true &&
    typeof record.type === "string" &&
    typeof record.code === "string" &&
    typeof record.message === "string"
  );
}

function isCompactError(body: unknown): body is { error: string } {
  if (!body || typeof body !== "object") return false;
  return typeof (body as { error?: unknown }).error === "string";
}

export function createApiError(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>>,
  statusText: string,
): NxtlError {
  const parsed = parseErrorBody(body, statusText);
  const requestId = headers["x-request-id"] ?? parsed.requestId;
  const retryAfterRaw = headers["retry-after"];
  const retryAfterSeconds = retryAfterRaw != null && Number.isFinite(Number(retryAfterRaw))
    ? Number(retryAfterRaw)
    : undefined;
  const parts = [`NXTL eSIM API ${status}`];
  if (parsed.code) parts.push(parsed.code);
  parts.push(parsed.message);
  if (requestId) parts.push(`(request ${requestId})`);
  const options: NxtlErrorOptions = {
    status,
    headers,
    body,
    ...(parsed.code !== undefined ? { code: parsed.code } : {}),
    ...(parsed.errorType !== undefined ? { errorType: parsed.errorType } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(parsed.docUrl !== undefined ? { docUrl: parsed.docUrl } : {}),
    ...(parsed.details !== undefined ? { details: parsed.details } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
  const message = parts.join(": ").replace(": :", ":");
  const code = (parsed.code ?? "").toLowerCase();

  if (status === 400) return new NxtlValidationError(message, options);
  if (status === 401) return new NxtlAuthError(message, options);
  if (status === 403) return new NxtlAccessDeniedError(message, options);
  if (status === 404) return new NxtlNotFoundError(message, options);
  if (status === 402) {
    if (code === "resume_blocked") return new NxtlResumeBlockedError(message, options);
    return new NxtlInsufficientBalanceError(message, options);
  }
  if (status === 409) {
    if (code === "quota_exhausted" || code === "quota_exceeded") {
      return new NxtlQuotaExceededError(message, options);
    }
    if (code === "already_terminated") return new NxtlAlreadyTerminatedError(message, options);
    return new NxtlConflictError(message, options);
  }
  if (status === 429) return new NxtlRateLimitError(message, options);
  if (status >= 500) return new NxtlServerError(message, options);
  return new NxtlError(message, options);
}
