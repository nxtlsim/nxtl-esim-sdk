/**
 * Threshold helpers, a webhook router for the published event names, and a
 * poll loop the reseller runs. The API does not schedule work for you.
 */

import type { NxtlClient } from "../client.js";
import { WEBHOOK_EVENT_NAMES, type WebhookEnvelope } from "../types.js";
import type { MarkupConfig } from "../pricing.js";
import type { PricingFeed } from "../catalog.js";
import type { FxTable } from "./fx.js";
import { applyUsageToPackages, suspendOverageLines } from "./packages.js";
import type { CustomerDirectory } from "./customers.js";
import { normalizeUsageRow, periodBounds, type UsagePeriod } from "./usage.js";
import { postingForRow } from "./money.js";
import type { FailedAction, SyncCheckpoint, WalletEntry } from "./store.js";

export type AlertHandler = (alert: ResellerAlert) => void | Promise<void>;

export type ResellerAlert =
  | { type: "low_balance"; customerId: string; balance: number; currency: string }
  | { type: "package_overage"; customerId: string; allocationId: string; iccid?: string }
  | { type: "usage_delta"; customerId: string; retail: number; margin: number; bytes: number }
  | { type: "webhook"; event: string; id: string };

/**
 * Opt-in EUR day rule. Existing USD rules are not converted.
 * `period` is stored and ignored. Evaluation waits for the minute tick after
 * usage polling (default 600 seconds, 12-hour supplier lag).
 */
export async function ensureEurUsageTodayRule(
  client: NxtlClient,
  input: { amountEur: number; action?: "notify" | "suspend" },
) {
  if (!(input.amountEur > 0)) throw new TypeError("amountEur must be > 0");
  return client.createThreshold({
    scope: "esim",
    metric: "line_usage_eur_today",
    operator: ">=",
    threshold_value: input.amountEur,
    period: "daily",
    action: input.action ?? "notify",
    enabled: true,
    notes: { cap_per_line_eur: input.amountEur },
  });
}

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
  /** Distinguishes cursor checkpoints. Defaults to `default`. Not shared across ICCIDs or date filters. */
  accountId?: string;
  onAlert?: AlertHandler;
}

export interface SyncResult {
  customers: number;
  alerts: ResellerAlert[];
  unresolved: Array<{ customerId: string; ledgerId: number; reason?: string }>;
  capabilityUnavailable: boolean;
}

/**
 * Poll accounting CDRs and post the reseller wallet.
 * Charges and volume are applied separately. A missing FX rate or missing
 * usage detail stays pending. Checkpoints advance only for a committed prefix.
 * Webhook deliveries are not debited here.
 */
export async function syncReseller(directory: CustomerDirectory, options: SyncOptions): Promise<SyncResult> {
  const customers = await directory.store.listCustomers({ status: "active" });
  const alerts: ResellerAlert[] = [];
  const unresolved: SyncResult["unresolved"] = [];
  let capabilityUnavailable = false;
  const walletCurrency = options.retailCurrency ?? "EUR";
  const bounds = periodBounds(options.period);
  const accountId = options.accountId ?? "default";
  for (const customer of customers) {
    const lines = await directory.store.listAssignments({ customerId: customer.id, activeOnly: true });
    if (lines.length === 0) continue;
    const manualPause = new Set(lines.filter((line) => line.manualPause).map((line) => line.iccid));
    const wallet: WalletEntry[] = [];
    const applied: Array<{ stream: "financial" | "volume"; key: string }> = [];
    const pending = [];
    const clearPending = [];
    const checkpoints: SyncCheckpoint[] = [];
    const volumeRows = [];
    for (const line of lines) {
      const scope = checkpointScope(accountId, line.iccid, bounds.since, bounds.until);
      const after = await directory.store.getCheckpoint(scope);
      const seen = new Set<number>();
      const fresh = [];
      for await (const raw of directory.client.iterateAccountingCdrs({
        iccid: line.iccid,
        since: bounds.since,
        until: bounds.until,
        after_id: after,
        per_page: 100,
      })) {
        const row = normalizeUsageRow(raw, "cdr", { iccid: line.iccid });
        if (row.ledgerId === undefined || seen.has(row.ledgerId)) continue;
        seen.add(row.ledgerId);
        fresh.push(row);
      }
      const waiting = await directory.store.listPending(scope);
      if (waiting.length > 0) {
        const want = new Set(waiting.map((item) => item.ledgerId));
        for await (const raw of directory.client.iterateUsageCdrs({
          iccid: line.iccid,
          since: bounds.since,
          until: bounds.until,
          per_page: 100,
          accounting: 1,
        })) {
          const row = normalizeUsageRow(raw, "cdr", { iccid: line.iccid });
          if (row.ledgerId === undefined || !want.has(row.ledgerId) || seen.has(row.ledgerId)) continue;
          seen.add(row.ledgerId);
          fresh.push(row);
        }
      }
      fresh.sort((a, b) => (a.ledgerId ?? 0) - (b.ledgerId ?? 0));
      let cursor = after;
      let blocked = false;
      for (const row of fresh) {
        const ledgerId = row.ledgerId;
        if (ledgerId === undefined) continue;
        if (row.detailAvailable === undefined) capabilityUnavailable = true;
        const key = String(ledgerId);
        const financialDone = await directory.store.hasApplied("financial", key) || applied.some((item) => item.stream === "financial" && item.key === key);
        if (!financialDone && ledgerId > after) {
          if (blocked) continue;
          const posting = postingForRow(row, { markup: options.markup, fx: options.fx, walletCurrency });
          if (posting.status === "unresolved") {
            unresolved.push({ customerId: customer.id, ledgerId, ...(posting.reason ? { reason: posting.reason } : {}) });
            blocked = true;
            continue;
          }
          if (posting.status === "ready" && posting.kind && posting.selling !== undefined && posting.currency) {
            wallet.push({
              id: `wal_${customer.id}_${posting.kind}_${ledgerId}`,
              customerId: customer.id,
              at: row.at ?? new Date().toISOString(),
              kind: posting.kind,
              amount: posting.selling,
              currency: posting.currency,
              memo: posting.kind === "credit" ? "NXTL API credit" : "Reseller selling charge",
              reference: key,
            });
            const alert: ResellerAlert = {
              type: "usage_delta",
              customerId: customer.id,
              retail: posting.selling,
              margin: posting.margin ?? 0,
              bytes: row.volumeTrusted ? row.bytes ?? 0 : 0,
            };
            alerts.push(alert);
            await options.onAlert?.(alert);
          }
          applied.push({ stream: "financial", key });
          cursor = ledgerId;
        } else if (ledgerId > cursor && !blocked) {
          cursor = ledgerId;
        }
        const volumeDone = await directory.store.hasApplied("volume", key) || applied.some((item) => item.stream === "volume" && item.key === key);
        if (volumeDone) {
          clearPending.push({ scope, ledgerId });
          continue;
        }
        if (row.detailAvailable === true) {
          volumeRows.push(row);
          applied.push({ stream: "volume", key });
          clearPending.push({ scope, ledgerId });
        } else if (row.detailAvailable === false) {
          pending.push({ scope, ledgerId, iccid: row.iccid ?? line.iccid, ...(row.at ? { createdAt: row.at } : {}) });
        }
      }
      if (cursor > after) checkpoints.push({ scope, afterId: cursor });
    }
    let allocations = await directory.store.listAllocations({ customerId: customer.id });
    if (volumeRows.length > 0 && !capabilityUnavailable) {
      const packages = await directory.store.listPackages();
      const consumption = applyUsageToPackages(volumeRows, allocations, packages, options.packageMode ?? "fifo");
      allocations = consumption.allocations;
      for (const allocation of allocations) {
        if (allocation.status !== "overage" && allocation.status !== "exhausted") continue;
        const alert: ResellerAlert = { type: "package_overage", customerId: customer.id, allocationId: allocation.id };
        if (allocation.iccid) alert.iccid = allocation.iccid;
        alerts.push(alert);
        await options.onAlert?.(alert);
      }
    }
    await directory.store.commitSync({
      wallet,
      applied,
      allocations: volumeRows.length > 0 && !capabilityUnavailable ? allocations : [],
      checkpoints,
      pending,
      clearPending,
    });
    if (options.suspendOverage !== false) {
      const packages = await directory.store.listPackages();
      const results = await suspendOverageLines(directory.client, allocations, packages, { manualPauseIccids: manualPause });
      const failed: FailedAction[] = results.filter((item) => !item.ok).map((item) => ({
        id: `suspend_${item.iccid}`,
        iccid: item.iccid,
        kind: "suspend",
        error: item.error ?? "suspend failed",
        at: new Date().toISOString(),
      }));
      const clearFailed = results.filter((item) => item.ok).map((item) => `suspend_${item.iccid}`);
      const prior = await directory.store.listFailedActions();
      for (const action of prior) {
        if (manualPause.has(action.iccid) || clearFailed.includes(action.id)) continue;
        try {
          await directory.client.suspendEsim(action.iccid);
          clearFailed.push(action.id);
        } catch (error) {
          failed.push({ ...action, error: error instanceof Error ? error.message : action.error, at: new Date().toISOString() });
        }
      }
      if (failed.length > 0 || clearFailed.length > 0) {
        await directory.store.commitSync({ failedActions: failed, clearFailed });
      }
    }
    if (options.lowBalance) {
      const balance = await directory.walletBalance(customer.id, options.lowBalance.currency);
      if (balance <= options.lowBalance.threshold) {
        const alert: ResellerAlert = { type: "low_balance", customerId: customer.id, balance, currency: options.lowBalance.currency };
        alerts.push(alert);
        await options.onAlert?.(alert);
      }
    }
  }
  return { customers: customers.length, alerts, unresolved, capabilityUnavailable };
}

export function checkpointScope(accountId: string, iccid: string, since: string, until: string): string {
  return `${accountId}|${iccid}|${since}|${until}`;
}

/** A webhook with no ledger id is not charged. Envelope id is the delivery id. */
export function classifyUsageWebhook(envelope: { id: string; data?: { ledger_id?: number | null } }): { deliveryId: string; ledgerId?: number; deferred: boolean } {
  const ledger = envelope.data?.ledger_id;
  if (typeof ledger === "number") return { deliveryId: envelope.id, ledgerId: ledger, deferred: false };
  return { deliveryId: envelope.id, deferred: true };
}

/**
 * Local timer. Overlapping runs are rejected instead of stacked.
 * This is not an API scheduler. One process only.
 */
export function scheduleSync(
  run: () => Promise<void>,
  intervalMs: number,
  hooks: { onRejected?: () => void } = {},
): { stop: () => void } {
  if (intervalMs < 1000) throw new TypeError("intervalMs must be >= 1000");
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      hooks.onRejected?.();
      return;
    }
    running = true;
    void run().finally(() => {
      running = false;
    });
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
