/**
 * Threshold helpers, a webhook router for the published event names, and a
 * poll loop the reseller runs. The API does not schedule work for you.
 */

import type { NxtlClient } from "../client.js";
import { WEBHOOK_EVENT_NAMES, type WebhookEnvelope } from "../types.js";
import type { MarkupConfig } from "../pricing.js";
import type { PricingFeed } from "../catalog.js";
import type { FxTable } from "./fx.js";
import { suspendOverageLines } from "./packages.js";
import type { CustomerDirectory } from "./customers.js";
import type { NormalizedUsageRow, UsagePeriod } from "./usage.js";
import { createIdempotencyKey } from "../util.js";
import type { WalletEntry } from "./store.js";

export type AlertHandler = (alert: ResellerAlert) => void | Promise<void>;

export type ResellerAlert =
  | { type: "low_balance"; customerId: string; balance: number; currency: string }
  | { type: "package_overage"; customerId: string; allocationId: string; iccid?: string }
  | { type: "usage_delta"; customerId: string; retail: number; margin: number; bytes: number }
  | { type: "webhook"; event: string; id: string };

export async function ensureUsagePercentRule(
  client: NxtlClient,
  input: { percent: number; action?: "notify" | "suspend"; period?: "instant" | "daily" | "weekly" | "monthly" },
) {
  if (input.percent <= 0 || input.percent > 100) throw new TypeError("percent must be between 0 and 100");
  return client.createThreshold({
    scope: "esim",
    metric: "line_usage_pct",
    operator: ">=",
    threshold_value: input.percent,
    period: input.period ?? "daily",
    action: input.action ?? "notify",
    enabled: true,
  });
}

export async function ensurePoolBalanceRule(
  client: NxtlClient,
  input: { thresholdUsd: number; action?: "notify" | "suspend" },
) {
  return client.createThreshold({
    scope: "balance",
    metric: "balance_below",
    operator: "<=",
    threshold_value: input.thresholdUsd,
    period: "instant",
    action: input.action ?? "notify",
    enabled: true,
  });
}

export type WebhookHandler = (event: WebhookEnvelope, context: { client: NxtlClient }) => void | Promise<void>;

export class WebhookRouter {
  private readonly handlers = new Map<string, WebhookHandler[]>();

  constructor(private readonly client: NxtlClient) {}

  on(event: (typeof WEBHOOK_EVENT_NAMES)[number] | "*", handler: WebhookHandler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  async dispatch(event: WebhookEnvelope): Promise<void> {
    const specific = this.handlers.get(event.event) ?? [];
    const any = this.handlers.get("*") ?? [];
    for (const handler of [...specific, ...any]) {
      await handler(event, { client: this.client });
    }
  }
}

export interface SyncOptions {
  period: UsagePeriod;
  markup?: MarkupConfig;
  pricing?: PricingFeed;
  fx?: FxTable;
  retailCurrency?: string;
  lowBalance?: { currency: string; threshold: number };
  packageMode?: "fifo" | "priority";
  suspendOverage?: boolean;
  onAlert?: AlertHandler;
}

/** One poll of every active line. Updates snapshots, packages, and the wallet. */
export async function syncReseller(directory: CustomerDirectory, options: SyncOptions): Promise<{ customers: number; alerts: ResellerAlert[] }> {
  const customers = await directory.store.listCustomers({ status: "active" });
  const alerts: ResellerAlert[] = [];
  for (const customer of customers) {
    const lines = await directory.store.listAssignments({ customerId: customer.id, activeOnly: true });
    if (lines.length === 0) continue;
    const report = await directory.customerUsage(customer.id, options.period, options);
    const freshMoney = [];
    for (const row of report.rows) {
      if (row.source !== "cdr" || row.ledgerId === undefined) continue;
      if (await directory.store.hasApplied("cdr", String(row.ledgerId))) continue;
      freshMoney.push(row);
    }
    const freshDetail = [];
    for (const row of report.rows) {
      if (!row.volumeTrusted || row.source !== "line_usage") continue;
      const key = lineDetailKey(row);
      if (await directory.store.hasApplied("line_usage", key)) continue;
      freshDetail.push(row);
    }
    const moneyReport = { ...report, rows: freshMoney };
    const charge = moneyReport.rows.reduce((sum, row) => sum + (row.chargeKind === "debit" ? row.consumptionCharge ?? 0 : 0), 0);
    const credit = moneyReport.rows.reduce((sum, row) => {
      if (row.chargeKind !== "credit") return sum;
      const signed = row.currency === "USD" ? row.amountUsd ?? 0 : row.amountEur ?? 0;
      return sum + Math.abs(signed);
    }, 0);
    const currency = report.totals.retailCurrency ?? "EUR";
    const wallet = [];
    const applied = [];
    if (charge > 0) {
      wallet.push(await unsavedEntry(customer.id, "debit", charge, currency, "NXTL API charge"));
      const alert: ResellerAlert = { type: "usage_delta", customerId: customer.id, retail: charge, margin: 0, bytes: 0 };
      alerts.push(alert);
      await options.onAlert?.(alert);
    }
    if (credit > 0) wallet.push(await unsavedEntry(customer.id, "credit", credit, currency, "NXTL API credit"));
    for (const row of freshMoney) {
      if (row.ledgerId !== undefined) applied.push({ stream: "cdr" as const, key: String(row.ledgerId) });
    }
    let consumption = { allocations: [] as Awaited<ReturnType<CustomerDirectory["applyPackages"]>>["allocations"], overageBytes: 0 };
    if (report.volumeComplete) {
      consumption = await directory.applyPackages(customer.id, { ...report, rows: freshDetail }, options.packageMode ?? "fifo");
      for (const row of freshDetail) applied.push({ stream: "line_usage" as const, key: lineDetailKey(row) });
    }
    if (wallet.length > 0 || applied.length > 0) await directory.store.commitSync({ wallet, applied });
    if (options.suspendOverage) {
      const packages = await directory.store.listPackages();
      await suspendOverageLines(directory.client, consumption.allocations, packages);
    }
    for (const allocation of consumption.allocations) {
      if (allocation.status !== "overage") continue;
      const alert: ResellerAlert = { type: "package_overage", customerId: customer.id, allocationId: allocation.id };
      if (allocation.iccid) alert.iccid = allocation.iccid;
      alerts.push(alert);
      await options.onAlert?.(alert);
    }
    if (options.lowBalance) {
      const balance = await directory.walletBalance(customer.id, options.lowBalance.currency);
      if (balance <= options.lowBalance.threshold) {
        const alert: ResellerAlert = {
          type: "low_balance",
          customerId: customer.id,
          balance,
          currency: options.lowBalance.currency,
        };
        alerts.push(alert);
        await options.onAlert?.(alert);
      }
    }
  }
  return { customers: customers.length, alerts };
}

/** Local timer. Call `stop` to clear it. This is not an API scheduler. */
function lineDetailKey(row: NormalizedUsageRow): string {
  return [row.iccid ?? "", row.entryType ?? "", row.at ?? "", row.amountEur ?? "", row.amountUsd ?? "", row.bytes ?? "", row.country ?? ""].join("|");
}

async function unsavedEntry(customerId: string, kind: WalletEntry["kind"], amount: number, currency: string, memo: string): Promise<WalletEntry> {
  return {
    id: `wal_${(await createIdempotencyKey()).slice(0, 8)}`,
    customerId,
    at: new Date().toISOString(),
    kind,
    amount,
    currency,
    memo,
  };
}

export function scheduleSync(run: () => Promise<void>, intervalMs: number): { stop: () => void } {
  if (intervalMs < 1000) throw new TypeError("intervalMs must be >= 1000");
  const timer = setInterval(() => {
    void run();
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
