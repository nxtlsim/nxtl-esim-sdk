/**
 * Wallet posting policy shared by reports and sync.
 *
 * Debits: convert the NXTL acquisition cost into the wallet currency, then
 * apply markup. Selling charge and margin stay separate from that acquisition
 * cost. Credits and refunds (positive signed ledger amounts) convert the
 * acquisition amount only and do not add markup. A missing FX rate leaves the
 * row unresolved and unapplied.
 *
 * Amounts are rounded half away from zero to 4 decimal places, matching the
 * 4-place ledger figures in the API reference.
 */

import { quotePrice, type MarkupConfig } from "../pricing.js";
import { convertFx, type FxTable } from "./fx.js";
import type { NormalizedUsageRow } from "./usage.js";

export const CREDIT_REFUND_POLICY =
  "A positive signed ledger amount is a credit or refund. It is converted into the wallet currency and posted as a credit of the acquisition amount. Markup is not applied. A negative signed amount is a debit: FX first, then markup, posted as the reseller selling charge. Missing FX leaves that row pending.";

export function roundHalfUp(value: number, decimals = 4): number {
  if (!Number.isFinite(value)) throw new TypeError("amount must be finite");
  const negative = value < 0;
  const expanded = Math.abs(value).toFixed(decimals + 1);
  const [ints, fraction = ""] = expanded.split(".");
  const digits = `${fraction}${"0".repeat(decimals + 1)}`.slice(0, decimals + 1);
  const keep = digits.slice(0, decimals);
  let combined = BigInt(`${ints}${keep || "0"}`);
  if ((digits[decimals] ?? "0") >= "5") combined += 1n;
  const text = combined.toString().padStart(decimals + 1, "0");
  const head = text.slice(0, -decimals) || "0";
  const tail = decimals > 0 ? text.slice(-decimals) : "";
  const result = tail ? Number(`${head}.${tail}`) : Number(head);
  return negative ? -result : result;
}

export interface WalletPosting {
  status: "ready" | "unresolved" | "ignored";
  reason?: string;
  kind?: "debit" | "credit";
  /** Acquisition cost in the wallet currency. Not upstream wholesale. */
  acquisition?: number;
  /** Amount posted to the reseller wallet. */
  selling?: number;
  margin?: number;
  currency?: string;
  nativeCurrency?: string;
  nativeAmount?: number;
}

export function postingForRow(
  row: NormalizedUsageRow,
  options: { markup?: MarkupConfig; fx?: FxTable; walletCurrency?: string } = {},
): WalletPosting {
  const wallet = (options.walletCurrency ?? "EUR").toUpperCase();
  const native = (row.currency ?? "").toUpperCase();
  if (row.chargeKind === "zero" || row.chargeKind === "unspecified") {
    return { status: "ignored", reason: row.chargeKind ?? "unspecified" };
  }
  if (native !== "EUR" && native !== "USD") {
    return { status: "unresolved", reason: "currency" };
  }
  const nativeAmount = row.chargeKind === "credit"
    ? Math.abs(native === "USD" ? row.amountUsd ?? 0 : row.amountEur ?? 0)
    : row.consumptionCharge ?? 0;
  if (!(nativeAmount > 0)) return { status: "ignored", reason: "zero" };
  if (native !== wallet && !options.fx) {
    return { status: "unresolved", reason: "missing_fx", nativeCurrency: native, nativeAmount };
  }
  const acquisition = roundHalfUp(native === wallet || !options.fx ? nativeAmount : convertFx(nativeAmount, native, wallet, options.fx));
  if (row.chargeKind === "credit") {
    return {
      status: "ready",
      kind: "credit",
      acquisition,
      selling: acquisition,
      margin: 0,
      currency: wallet,
      nativeCurrency: native,
      nativeAmount,
    };
  }
  const markup = options.markup ?? { mode: "percentage" as const, percentage: 0, rounding: "nearest" as const, currency: wallet };
  const quote = quotePrice(acquisition, { ...markup, currency: wallet });
  const selling = roundHalfUp(quote.retail);
  return {
    status: "ready",
    kind: "debit",
    acquisition,
    selling,
    margin: roundHalfUp(selling - acquisition),
    currency: wallet,
    nativeCurrency: native,
    nativeAmount,
  };
}
