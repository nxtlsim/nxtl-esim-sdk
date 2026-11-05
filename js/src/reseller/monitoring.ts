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
import type { UsagePeriod } from "./usage.js";

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
    const { delta } = await directory.recordSnapshot(customer.id, report);
    if (delta.retail > 0 || delta.bytes > 0) {
      const alert: ResellerAlert = { type: "usage_delta", customerId: customer.id, retail: delta.retail, margin: delta.margin, bytes: delta.bytes };
      alerts.push(alert);
      await options.onAlert?.(alert);
      const currency = report.totals.retailCurrency ?? "EUR";
      if (delta.retail > 0) await directory.debit(customer.id, delta.retail, currency, "Usage since last snapshot", report.until);
    }
    const consumption = await directory.applyPackages(
      customer.id,
      { ...report, rows: delta.added },
      options.packageMode ?? "fifo",
    );
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
export function scheduleSync(run: () => Promise<void>, intervalMs: number): { stop: () => void } {
  if (intervalMs < 1000) throw new TypeError("intervalMs must be >= 1000");
  const timer = setInterval(() => {
    void run();
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
