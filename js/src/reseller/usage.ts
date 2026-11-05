/**
 * Usage and cost built from the published usage endpoints.
 *
 * Item schemas are not in the OpenAPI document. `amount_usd` and `amount_eur`
 * are named in the human API reference. Volume and country keys are not.
 * Those are read only when present, and the report says so.
 */

import type { NxtlClient } from "../client.js";
import type { PricingFeed } from "../catalog.js";
import { quotePrice, type MarkupConfig } from "../pricing.js";
import type { JsonObject } from "../types.js";
import { fromBytes } from "./units.js";
import { convertFx, type FxTable } from "./fx.js";

export type UsagePeriod =
  | { kind: "daily"; day: string }
  | { kind: "monthly"; month: string }
  | { kind: "range"; since: string; until: string };

export interface NormalizedUsageRow {
  iccid?: string;
  at?: string;
  amountUsd?: number;
  amountEur?: number;
  currency?: string;
  /** Present only when the row carries a byte-denominated field. */
  bytes?: number;
  /**
   * Present only when the row carries a country field.
   * TODO(spec): CDR and usage schemas do not name a country.
   */
  country?: string;
  /** `network` is mentioned for the usage.recorded webhook, not for CDR rows. */
  network?: string;
  sourceKeys: string[];
  raw: JsonObject;
}

export interface UsageCostTotals {
  rows: number;
  bytes: number;
  rowsWithVolume: number;
  wholesaleUsd: number;
  wholesaleEur: number;
  pricedFromApi: number;
  pricedFromFeed: number;
  unpricedRows: number;
  retail: number;
  retailCurrency?: string;
  margin: number;
  zeroIsNotFree: boolean;
}

export interface UsageSlice {
  key: string;
  totals: UsageCostTotals;
}

export interface UsageCostReport {
  period: UsagePeriod;
  since: string;
  until: string;
  rows: NormalizedUsageRow[];
  totals: UsageCostTotals;
  byLine: UsageSlice[];
  byCountry: UsageSlice[];
  byDay: UsageSlice[];
  byMonth: UsageSlice[];
  /** True when at least one row had a country field. */
  countryBreakdownAvailable: boolean;
  partnerSummary?: JsonObject;
  timeseries?: JsonObject;
  /**
   * TODO(spec): GET /esims/{iccid}/usage has no since/until parameters.
   * Rows from that call are filtered locally when they have a timestamp.
   */
  notes: string[];
}

export interface UsageSnapshot {
  id: string;
  takenAt: string;
  iccid?: string;
  customerId?: string;
  period: UsagePeriod;
  rows: NormalizedUsageRow[];
  totals: UsageCostTotals;
}

export interface UsageDelta {
  added: NormalizedUsageRow[];
  removed: NormalizedUsageRow[];
  wholesaleUsd: number;
  wholesaleEur: number;
  retail: number;
  margin: number;
  bytes: number;
}

const VOLUME_BYTES = ["bytes", "volume_bytes", "data_bytes", "octets"];
const VOLUME_MB = ["volume_mb", "data_mb", "usage_mb", "mb"];
const VOLUME_GB = ["volume_gb", "data_gb", "usage_gb", "gb"];
const COUNTRY_KEYS = ["iso2", "country", "country_code", "destination"];
const TIME_KEYS = ["at", "timestamp", "created_at", "recorded_at", "occurred_at", "day"];

export function periodBounds(period: UsagePeriod): { since: string; until: string } {
  if (period.kind === "daily") {
    const start = new Date(`${period.day}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime())) throw new TypeError("daily period requires YYYY-MM-DD");
    const end = new Date(start.getTime() + 86_400_000);
    return { since: start.toISOString(), until: end.toISOString() };
  }
  if (period.kind === "monthly") {
    const match = /^(\d{4})-(\d{2})$/.exec(period.month);
    if (!match) throw new TypeError("monthly period requires YYYY-MM");
    const year = Number(match[1]);
    const month = Number(match[2]);
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));
    return { since: start.toISOString(), until: end.toISOString() };
  }
  return { since: period.since, until: period.until };
}

export function normalizeUsageRow(raw: JsonObject): NormalizedUsageRow {
  const sourceKeys: string[] = [];
  const iccid = readString(raw, ["iccid"], sourceKeys);
  const at = readTime(raw, sourceKeys);
  const amountUsd = readNumber(raw, ["amount_usd", "usage_usd", "cost_usd"], sourceKeys);
  const amountEur = readNumber(raw, ["amount_eur", "usage_eur", "cost_eur"], sourceKeys);
  const currency = readString(raw, ["currency"], sourceKeys);
  const bytes = readBytes(raw, sourceKeys);
  const country = readCountry(raw, sourceKeys);
  const network = readString(raw, ["network", "operator"], sourceKeys);
  const row: NormalizedUsageRow = { sourceKeys, raw };
  if (iccid) row.iccid = iccid;
  if (at) row.at = at;
  if (amountUsd !== undefined) row.amountUsd = amountUsd;
  if (amountEur !== undefined) row.amountEur = amountEur;
  if (currency) row.currency = currency;
  if (bytes !== undefined) row.bytes = bytes;
  if (country) row.country = country;
  if (network) row.network = network;
  return row;
}

export function rowInPeriod(row: NormalizedUsageRow, since: string, until: string): boolean {
  if (!row.at) return true;
  const time = Date.parse(row.at);
  if (Number.isNaN(time)) return true;
  const start = Date.parse(since);
  const end = Date.parse(until);
  return time >= start && time < end;
}

export interface CostOptions {
  markup?: MarkupConfig;
  pricing?: PricingFeed;
  fx?: FxTable;
  /** Currency used for retail and margin. Defaults to markup.currency or EUR. */
  retailCurrency?: string;
}

export function costUsage(rows: readonly NormalizedUsageRow[], options: CostOptions = {}): UsageCostTotals {
  const retailCurrency = options.retailCurrency ?? options.markup?.currency ?? "EUR";
  const totals: UsageCostTotals = {
    rows: rows.length,
    bytes: 0,
    rowsWithVolume: 0,
    wholesaleUsd: 0,
    wholesaleEur: 0,
    pricedFromApi: 0,
    pricedFromFeed: 0,
    unpricedRows: 0,
    retail: 0,
    retailCurrency,
    margin: 0,
    zeroIsNotFree: false,
  };
  for (const row of rows) {
    if (row.bytes !== undefined) {
      totals.bytes += row.bytes;
      totals.rowsWithVolume += 1;
    }
    const priced = priceRow(row, options, retailCurrency);
    if ((row.amountUsd === 0 && row.amountEur !== undefined && row.amountEur !== 0) || (row.amountEur === 0 && row.amountUsd !== undefined && row.amountUsd !== 0)) {
      totals.zeroIsNotFree = true;
    }
    if (!priced) {
      totals.unpricedRows += 1;
      continue;
    }
    if (priced.source === "api") totals.pricedFromApi += 1;
    else totals.pricedFromFeed += 1;
    if (priced.native === "USD") totals.wholesaleUsd += priced.nativeAmount;
    if (priced.native === "EUR") totals.wholesaleEur += priced.nativeAmount;
    totals.retail += priced.retail;
    totals.margin += priced.retail - priced.wholesaleInRetail;
  }
  return totals;
}

export function buildUsageReport(
  rows: readonly NormalizedUsageRow[],
  period: UsagePeriod,
  options: CostOptions = {},
): UsageCostReport {
  const bounds = periodBounds(period);
  const filtered = rows.filter((row) => rowInPeriod(row, bounds.since, bounds.until));
  const notes: string[] = [];
  if (filtered.some((row) => !row.at)) {
    notes.push("Some usage rows had no timestamp and were kept inside the requested period.");
  }
  if (filtered.some((row) => row.bytes === undefined)) {
    notes.push("TODO(spec): usage rows do not publish a byte field. Volume is set only when a byte, MB, or GB key is present.");
  }
  const countryRows = filtered.filter((row) => row.country);
  if (countryRows.length === 0) {
    notes.push("TODO(spec): the usage and CDR schemas do not name a country, so the per-country breakdown is empty unless a row already includes one.");
  }
  return {
    period,
    since: bounds.since,
    until: bounds.until,
    rows: filtered,
    totals: costUsage(filtered, options),
    byLine: groupCost(filtered, (row) => row.iccid ?? "unknown", options),
    byCountry: groupCost(countryRows, (row) => row.country ?? "unknown", options),
    byDay: groupCost(filtered.filter((row) => row.at), (row) => (row.at ?? "").slice(0, 10), options),
    byMonth: groupCost(filtered.filter((row) => row.at), (row) => (row.at ?? "").slice(0, 7), options),
    countryBreakdownAvailable: countryRows.length > 0,
    notes,
  };
}

export async function loadUsageDetails(
  client: NxtlClient,
  input: CostOptions & {
    period: UsagePeriod;
    iccid?: string;
    includePartnerRollups?: boolean;
  },
): Promise<UsageCostReport> {
  const bounds = periodBounds(input.period);
  const notes: string[] = [];
  const cdrs: NormalizedUsageRow[] = [];
  const query: { iccid?: string; since: string; until: string; per_page: number } = {
    since: bounds.since,
    until: bounds.until,
    per_page: 100,
  };
  if (input.iccid) query.iccid = input.iccid;
  for await (const row of client.iterateUsageCdrs(query)) {
    cdrs.push(normalizeUsageRow(row));
  }
  let lineRows: NormalizedUsageRow[] = [];
  if (input.iccid) {
    const line = await client.getEsimUsage(input.iccid);
    lineRows = extractRawRows(line.data).map(normalizeUsageRow);
    notes.push("GET /esims/{iccid}/usage has no time filters in the spec. Rows with a timestamp are filtered to the period locally.");
  }
  const rows = cdrs.length > 0 ? cdrs : lineRows;
  if (cdrs.length === 0 && lineRows.length > 0) {
    notes.push("CDR list was empty. Per-line usage rows were used instead.");
  }
  const report = buildUsageReport(rows, input.period, input);
  report.notes.push(...notes);
  if (input.includePartnerRollups) {
    const days = Math.min(365, Math.max(1, Math.ceil((Date.parse(bounds.until) - Date.parse(bounds.since)) / 86_400_000)));
    const [summary, series, perEsim] = await Promise.all([
      client.usageSummary({ days }),
      client.usageTimeseries({ days }),
      client.usageEsims({
        since: bounds.since,
        until: bounds.until,
        ...(input.iccid ? { iccid: input.iccid } : {}),
      }),
    ]);
    report.partnerSummary = {
      summary: summary.data,
      perEsim: perEsim.data,
    };
    report.timeseries = series.data as JsonObject;
    report.notes.push("GET /usage/summary and GET /usage/timeseries accept `days`, not an arbitrary since/until. The day count is derived from the period and capped at 365.");
  }
  return report;
}

export function snapshotUsage(report: UsageCostReport, extra: { id?: string; iccid?: string; customerId?: string } = {}): UsageSnapshot {
  const snap: UsageSnapshot = {
    id: extra.id ?? `snap_${Date.now().toString(36)}`,
    takenAt: new Date().toISOString(),
    period: report.period,
    rows: report.rows,
    totals: report.totals,
  };
  if (extra.iccid) snap.iccid = extra.iccid;
  if (extra.customerId) snap.customerId = extra.customerId;
  return snap;
}

export function diffSnapshots(previous: UsageSnapshot | undefined, next: UsageSnapshot): UsageDelta {
  const before = new Set((previous?.rows ?? []).map(fingerprint));
  const after = new Set(next.rows.map(fingerprint));
  const added = next.rows.filter((row) => !before.has(fingerprint(row)));
  const removed = (previous?.rows ?? []).filter((row) => !after.has(fingerprint(row)));
  const prev = previous?.totals;
  return {
    added,
    removed,
    wholesaleUsd: next.totals.wholesaleUsd - (prev?.wholesaleUsd ?? 0),
    wholesaleEur: next.totals.wholesaleEur - (prev?.wholesaleEur ?? 0),
    retail: next.totals.retail - (prev?.retail ?? 0),
    margin: next.totals.margin - (prev?.margin ?? 0),
    bytes: next.totals.bytes - (prev?.bytes ?? 0),
  };
}

export function fingerprint(row: NormalizedUsageRow): string {
  return [row.iccid ?? "", row.at ?? "", row.amountUsd ?? "", row.amountEur ?? "", row.bytes ?? "", row.country ?? ""].join("|");
}

function priceRow(
  row: NormalizedUsageRow,
  options: CostOptions,
  retailCurrency: string,
): { source: "api" | "feed"; native: "USD" | "EUR"; nativeAmount: number; wholesaleInRetail: number; retail: number } | undefined {
  let native: "USD" | "EUR" | undefined;
  let nativeAmount: number | undefined;
  let source: "api" | "feed" = "api";
  if (row.amountUsd !== undefined && !(row.amountUsd === 0 && row.amountEur)) {
    native = "USD";
    nativeAmount = row.amountUsd;
  } else if (row.amountEur !== undefined) {
    native = "EUR";
    nativeAmount = row.amountEur;
  } else if (row.bytes !== undefined && row.country && options.pricing) {
    const country = options.pricing.countries.find((item) => item.iso2.toUpperCase() === row.country?.toUpperCase());
    if (country) {
      native = "EUR";
      nativeAmount = fromBytes(row.bytes).gb * country.cheapest_eur_per_gb;
      source = "feed";
    }
  }
  if (native === undefined || nativeAmount === undefined) return undefined;
  const wholesaleInRetail = options.fx && native !== retailCurrency.toUpperCase()
    ? convertFx(nativeAmount, native, retailCurrency, options.fx)
    : native === retailCurrency.toUpperCase() || !options.fx
      ? nativeAmount
      : nativeAmount;
  if (!options.fx && native !== retailCurrency.toUpperCase()) {
    return undefined;
  }
  const markup = options.markup ?? { mode: "percentage", percentage: 0, rounding: "nearest", currency: retailCurrency };
  const quote = quotePrice(wholesaleInRetail, { ...markup, currency: retailCurrency }, { country: row.country });
  return { source, native, nativeAmount, wholesaleInRetail, retail: quote.retail };
}

function groupCost(
  rows: readonly NormalizedUsageRow[],
  keyOf: (row: NormalizedUsageRow) => string,
  options: CostOptions,
): UsageSlice[] {
  const groups = new Map<string, NormalizedUsageRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, group]) => ({ key, totals: costUsage(group, options) }));
}

function extractRawRows(payload: unknown): JsonObject[] {
  if (Array.isArray(payload)) return payload.filter(isObject);
  if (!isObject(payload)) return [];
  for (const key of ["usage", "rows", "events", "cdrs", "items", "data"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isObject);
  }
  return [];
}

function readBytes(raw: JsonObject, keys: string[]): number | undefined {
  const bytes = readNumber(raw, VOLUME_BYTES, keys);
  if (bytes !== undefined) return bytes;
  const mb = readNumber(raw, VOLUME_MB, keys);
  if (mb !== undefined) return mb * 1_000_000;
  const gb = readNumber(raw, VOLUME_GB, keys);
  if (gb !== undefined) return gb * 1_000_000_000;
  return undefined;
}

function readCountry(raw: JsonObject, keys: string[]): string | undefined {
  const value = readString(raw, COUNTRY_KEYS, keys);
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^[a-z]{2}$/i.test(trimmed)) return trimmed.toUpperCase();
  return trimmed;
}

function readTime(raw: JsonObject, keys: string[]): string | undefined {
  const value = readString(raw, TIME_KEYS, keys);
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toISOString();
}

function readNumber(raw: JsonObject, names: string[], used: string[]): number | undefined {
  for (const name of names) {
    const value = raw[name];
    if (typeof value === "number" && Number.isFinite(value)) {
      used.push(name);
      return value;
    }
  }
  return undefined;
}

function readString(raw: JsonObject, names: string[], used: string[]): string | undefined {
  for (const name of names) {
    const value = raw[name];
    if (typeof value === "string" && value.length > 0) {
      used.push(name);
      return value;
    }
  }
  return undefined;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
