import type { ApiResponse, IterateOptions, JsonObject } from "./types.js";

/**
 * Best-effort item extractor.
 *
 * CDR pages publish `{ cdrs, total, page, pages }`. Per-line usage publishes
 * `{ usage, page }` with a fixed page size of 50 and no page count.
 * Other list envelopes are still undescribed. The helper reads a bare array
 * or the first array under known keys, and stops on an empty page, a short
 * page when `perPage` is known, a repeated first item, or `pages`.
 */
const ITEM_KEYS = [
  "data",
  "esims",
  "items",
  "results",
  "entries",
  "rows",
  "rules",
  "events",
  "cdrs",
  "usage",
  "lines",
  "jobs",
  "deliveries",
  "audit",
  "history",
  "invoices",
  "ledger",
] as const;

export function extractItems(payload: unknown): JsonObject[] {
  if (Array.isArray(payload)) {
    return payload.filter(isObject);
  }
  if (!isObject(payload)) return [];
  for (const key of ITEM_KEYS) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isObject);
  }
  for (const value of Object.values(payload)) {
    if (Array.isArray(value) && value.every(isObject)) return value;
  }
  return [];
}

export async function* iteratePages<T>(
  fetchPage: (page: number) => Promise<ApiResponse<T>>,
  options: IterateOptions & { perPage?: number; startPage?: number } = {},
): AsyncGenerator<JsonObject, void, void> {
  const maxPages = options.maxPages ?? 100;
  const start = options.startPage ?? 1;
  let previous: string | undefined;
  for (let index = 0; index < maxPages; index += 1) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("Aborted");
    }
    const page = start + index;
    const response = await fetchPage(page);
    const items = extractItems(response.data);
    if (items.length === 0) return;
    const fingerprint = JSON.stringify(items[0]);
    if (fingerprint === previous) return;
    previous = fingerprint;
    for (const item of items) yield item;
    if (options.perPage != null && items.length < options.perPage) return;
    const totalPages = readTotalPages(response.data);
    if (totalPages != null && page >= totalPages) return;
    if (readHasMore(response.data) === false) return;
  }
}

function readTotalPages(payload: unknown): number | undefined {
  const value = readNumberField(payload, ["total_pages", "pages"]);
  if (value != null) return value;
  if (!isObject(payload)) return undefined;
  for (const key of ["meta", "pagination"]) {
    const nested = readNumberField(payload[key], ["total_pages", "pages"]);
    if (nested != null) return nested;
  }
  return undefined;
}

function readHasMore(payload: unknown): boolean | undefined {
  if (!isObject(payload)) return undefined;
  if (typeof payload.has_more === "boolean") return payload.has_more;
  for (const key of ["meta", "pagination"]) {
    const nested = payload[key];
    if (isObject(nested) && typeof nested.has_more === "boolean") return nested.has_more;
  }
  return undefined;
}

function readNumberField(payload: unknown, keys: string[]): number | undefined {
  if (!isObject(payload)) return undefined;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
