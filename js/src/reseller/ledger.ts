/**
 * Money on the NXTL eSIM ledger.
 *
 * For current OCS usage, currency is EUR. amount_eur is a signed retail pool
 * debit (negative). amount_usd is 0. That zero is not an FX conversion and
 * does not mean the usage was free. Upstream wholesale cost is not in the API.
 * The positive consumption charge below is the reseller's acquisition cost,
 * the NXTL API charge, not NXTL's upstream wholesale price.
 */

export type ChargeKind = "debit" | "credit" | "zero" | "unspecified";

export interface ApiCharge {
  currency: string;
  /** Signed ledger amount in `currency`. Webhook charges are stored as negative debits. */
  signed: number;
  /** Positive only for debits. Credits and zeros do not become extra usage charges. */
  consumptionCharge: number;
  kind: ChargeKind;
}

export function apiCharge(input: {
  currency?: string | null;
  amount_usd?: number | null;
  amount_eur?: number | null;
}): ApiCharge {
  const currency = (input.currency ?? "").trim().toUpperCase();
  if (currency !== "EUR" && currency !== "USD") {
    return { currency, signed: 0, consumptionCharge: 0, kind: "unspecified" };
  }
  const signed = currency === "EUR" ? input.amount_eur : input.amount_usd;
  if (typeof signed !== "number" || !Number.isFinite(signed)) {
    return { currency, signed: 0, consumptionCharge: 0, kind: "unspecified" };
  }
  if (signed < 0) {
    return { currency, signed, consumptionCharge: Math.abs(signed), kind: "debit" };
  }
  if (signed > 0) {
    return { currency, signed, consumptionCharge: 0, kind: "credit" };
  }
  return { currency, signed: 0, consumptionCharge: 0, kind: "zero" };
}

/** usage.recorded `data.amount` is already a positive retail charge in `data.currency`. */
export function webhookCharge(input: { currency?: string | null; amount?: number | null }): ApiCharge {
  const currency = (input.currency ?? "").trim().toUpperCase();
  const amount = input.amount;
  if ((currency !== "EUR" && currency !== "USD") || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return { currency, signed: 0, consumptionCharge: 0, kind: "unspecified" };
  }
  return { currency, signed: -amount, consumptionCharge: amount, kind: "debit" };
}

/**
 * Ledger and webhook timestamps documented as UTC `Y-m-d H:i:s`.
 * Also accepts an ISO string. The result is an ISO timestamp with a Z suffix.
 */
export function parseUtcTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(value.trim());
  if (match) return `${match[1]}T${match[2]}.000Z`;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toISOString();
}

/** Fleet rollups return usage_usd, usage_eur, and usage_events as JSON strings. */
export function parseRollupNumber(value: string | number | null | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export const USAGE_POLL_INTERVAL_SECONDS = 600;
export const SUPPLIER_LAG_LOOKBACK_SECONDS = 12 * 60 * 60;

export const THRESHOLD_EVALUATION_NOTE =
  "line_usage_pct is UTC month-to-date ABS(amount_usd) / notes.cap_per_line_usd, as a percentage. " +
  "line_usage_usd_today is UTC calendar-day ABS(amount_usd). The stored period is ignored by the evaluator. " +
  "action suspend pauses service and does not terminate the eSIM. " +
  "Current EUR usage has amount_usd 0, so these USD rules do not see that EUR charge. " +
  "Rules run on the minute tick after usage polling. Default polling is 600 seconds with a 12-hour supplier-lag lookback. " +
  "That is not an instantaneous cap, and usage can arrive after 12 hours.";
