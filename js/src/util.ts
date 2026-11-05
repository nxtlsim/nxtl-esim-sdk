import type { NetworkTierInput, StatusAction, ThresholdRule } from "./types.js";

export function compactQuery(query: object | undefined): Record<string, string> | undefined {
  if (!query) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function encodePath(value: string | number): string {
  return encodeURIComponent(String(value));
}

export function assertIccid(iccid: string): string {
  if (typeof iccid !== "string" || iccid.length < 18 || iccid.length > 22) {
    throw new TypeError("iccid must be a string of 18 to 22 characters");
  }
  return iccid;
}

export function assertIccids(iccids: readonly string[], max: number): string[] {
  if (!Array.isArray(iccids) || iccids.length < 1 || iccids.length > max) {
    throw new TypeError(`iccids must contain 1 to ${max} entries`);
  }
  return iccids.map((item) => assertIccid(item));
}

export function assertQuantity(quantity: number): number {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
    throw new TypeError("quantity must be an integer from 1 to 1000");
  }
  return quantity;
}

export function assertAmountUsd(amount: number): number {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0.01) {
    throw new TypeError("amount_usd must be a finite number >= 0.01");
  }
  return amount;
}

export function assertNickname(nickname: string): string {
  if (typeof nickname !== "string" || nickname.length > 80) {
    throw new TypeError("nickname must be a string of at most 80 characters");
  }
  return nickname;
}

export function assertIdempotencyKey(key: string): string {
  if (typeof key !== "string" || key.length < 1 || key.length > 128) {
    throw new TypeError("Idempotency-Key must be 1 to 128 characters");
  }
  return key;
}

export function assertIntegerId(id: number | string, name: string): string {
  if (typeof id === "number") {
    if (!Number.isInteger(id) || id < 0) {
      throw new TypeError(`${name} must be a non-negative integer`);
    }
    return String(id);
  }
  if (typeof id !== "string" || !/^\d+$/.test(id)) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return id;
}

const TIERS: readonly NetworkTierInput[] = ["cheapest", "best_coverage", "standard"];
const ACTIONS: readonly StatusAction[] = ["suspend", "reactivate", "terminate"];

export function assertTier(tier: string): NetworkTierInput {
  if (!(TIERS as readonly string[]).includes(tier)) {
    throw new TypeError("tier must be cheapest, best_coverage, or the standard alias");
  }
  return tier as NetworkTierInput;
}

export function assertAction(action: string): StatusAction {
  if (!(ACTIONS as readonly string[]).includes(action)) {
    throw new TypeError("action must be suspend, reactivate, or terminate");
  }
  return action as StatusAction;
}

export function assertPage(page: number | undefined, perPage: number | undefined, perPageMax?: number): void {
  if (page !== undefined && (!Number.isInteger(page) || page < 1)) {
    throw new TypeError("page must be an integer >= 1");
  }
  if (perPage !== undefined) {
    const max = perPageMax ?? Number.POSITIVE_INFINITY;
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > max) {
      throw new TypeError(
        perPageMax ? `per_page must be an integer from 1 to ${perPageMax}` : "per_page must be an integer >= 1",
      );
    }
  }
}

export function assertThreshold(rule: ThresholdRule): void {
  const metrics = ["balance_below", "line_usage_pct", "line_usage_usd_today"];
  const scopes = ["balance", "esim", "line"];
  const operators = ["<", "<=", "=", ">=", ">"];
  const periods = ["instant", "daily", "weekly", "monthly"];
  const actions = ["notify", "suspend"];
  if (!metrics.includes(rule.metric)) {
    throw new TypeError(`metric must be one of ${metrics.join(", ")}`);
  }
  if (typeof rule.threshold_value !== "number" || !Number.isFinite(rule.threshold_value)) {
    throw new TypeError("threshold_value must be a finite number");
  }
  if (rule.scope !== undefined && !scopes.includes(rule.scope)) {
    throw new TypeError(`scope must be one of ${scopes.join(", ")}`);
  }
  if (rule.operator !== undefined && !operators.includes(rule.operator)) {
    throw new TypeError(`operator must be one of ${operators.join(", ")}`);
  }
  if (rule.period !== undefined && !periods.includes(rule.period)) {
    throw new TypeError(`period must be one of ${periods.join(", ")}`);
  }
  if (rule.action !== undefined && !actions.includes(rule.action)) {
    throw new TypeError(`action must be one of ${actions.join(", ")}`);
  }
}

export async function createIdempotencyKey(): Promise<string> {
  const web = globalThis.crypto;
  if (web && typeof web.randomUUID === "function") return web.randomUUID();
  try {
    const mod = await import("node:crypto");
    if (typeof mod.randomUUID === "function") return mod.randomUUID();
  } catch {
    // Edge runtimes expose global crypto and do not provide node:crypto.
  }
  throw new Error("No CSPRNG is available to generate an idempotency key");
}

export function joinUrl(baseUrl: string, path: string, query?: Record<string, string>): string {
  if (!path.startsWith("/")) {
    throw new TypeError("path must start with /");
  }
  const base = baseUrl.replace(/\/+$/, "");
  const url = new URL(base + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

export function lowerHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export function safeLogMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (/key|secret|authorization|token/i.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = value;
    }
  }
  return out;
}
