import type { RetryOptions } from "./types.js";

export interface ResolvedRetry {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetryAfterMs: number;
  retryUnsafe: boolean;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export function resolveRetry(options: RetryOptions | false | undefined): ResolvedRetry | null {
  if (options === false) return null;
  return {
    maxRetries: options?.maxRetries ?? 2,
    baseDelayMs: options?.baseDelayMs ?? 200,
    maxDelayMs: options?.maxDelayMs ?? 8_000,
    maxRetryAfterMs: options?.maxRetryAfterMs ?? 120_000,
    retryUnsafe: options?.retryUnsafe ?? false,
    sleep: options?.sleep ?? defaultSleep,
    random: options?.random ?? Math.random,
  };
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isReplaySafe(method: string, idempotencyKey: string | undefined, retryUnsafe: boolean): boolean {
  if (retryUnsafe) return true;
  if (method === "GET" || method === "HEAD" || method === "PUT" || method === "DELETE" || method === "OPTIONS") {
    return true;
  }
  return Boolean(idempotencyKey);
}

/**
 * Full jitter: a random delay in [0, min(maxDelay, base * 2^attempt)].
 * A parsed Retry-After is a minimum and is itself capped by maxRetryAfterMs.
 */
export function computeDelayMs(
  retry: ResolvedRetry,
  attempt: number,
  retryAfterMs: number | undefined,
): number {
  const expo = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt);
  const jitter = Math.floor(retry.random() * Math.max(expo, 0));
  if (retryAfterMs == null) return jitter;
  const hinted = Math.min(Math.max(0, retryAfterMs), retry.maxRetryAfterMs);
  const extra = Math.floor(retry.random() * Math.min(250, retry.maxDelayMs));
  return hinted + extra;
}

export function parseRetryAfterMs(headers: Readonly<Record<string, string>>, now = Date.now()): number | undefined {
  const raw = headers["retry-after"];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && raw.trim() !== "") {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

/**
 * TODO(spec): `X-RateLimit-Reset` is named in the human reference and its
 * unit is not defined. Used only when Retry-After is absent.
 * Integers <= 86400 are treated as delta seconds.
 * Integers >= 1_000_000_000 are treated as Unix seconds.
 */
export function parseRateLimitResetDelayMs(
  headers: Readonly<Record<string, string>>,
  now = Date.now(),
): number | undefined {
  const raw = headers["x-ratelimit-reset"];
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw.trim())) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  if (value <= 86_400) return value * 1000;
  if (value >= 1_000_000_000) return Math.max(0, value * 1000 - now);
  return undefined;
}
