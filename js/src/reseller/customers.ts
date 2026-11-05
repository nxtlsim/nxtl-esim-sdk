/**
 * Maps reseller customers to NXTL eSIM lines.
 * Customer records, tags, and the prepaid wallet live in the reseller store.
 * Suspend and resume call the eSIM status operations. There is no customer
 * resource on the API.
 */

import { createIdempotencyKey } from "../util.js";
import type { NxtlClient } from "../client.js";
import type { MarkupConfig } from "../pricing.js";
import type { PricingFeed } from "../catalog.js";
import type { FxTable } from "./fx.js";
import { applyUsageToPackages } from "./packages.js";
import type {
  Customer,
  CustomerStatus,
  CustomerStore,
  LineAssignment,
  WalletEntry,
} from "./store.js";
import {
  buildUsageReport,
  diffSnapshots,
  loadUsageDetails,
  snapshotUsage,
  type UsageCostReport,
  type UsageDelta,
  type UsagePeriod,
} from "./usage.js";

export interface CustomerDraft {
  id?: string;
  externalId?: string;
  name?: string;
  email?: string;
  tags?: string[];
  notes?: string;
  metadata?: Record<string, unknown>;
}

export function newCustomer(draft: CustomerDraft, now = new Date()): Customer {
  const stamp = now.toISOString();
  const customer: Customer = {
    id: draft.id ?? `cus_${now.getTime().toString(36)}`,
    tags: draft.tags ?? [],
    metadata: draft.metadata ?? {},
    status: "active",
    createdAt: stamp,
    updatedAt: stamp,
  };
  if (draft.externalId) customer.externalId = draft.externalId;
  if (draft.name) customer.name = draft.name;
  if (draft.email) customer.email = draft.email;
  if (draft.notes) customer.notes = draft.notes;
  return customer;
}

export class CustomerDirectory {
  constructor(readonly store: CustomerStore, readonly client: NxtlClient) {}

  async saveCustomer(draft: CustomerDraft): Promise<Customer> {
    const customer = newCustomer(draft);
    await this.store.putCustomer(customer);
    return customer;
  }

  async assignLine(customerId: string, iccid: string, label?: string): Promise<LineAssignment> {
    const customer = await this.requireCustomer(customerId);
    const existing = await this.store.listAssignments({ iccid, activeOnly: true });
    if (existing.some((item) => item.customerId !== customer.id)) {
      throw new Error(`ICCID ${iccid} is already assigned to another customer`);
    }
    const assignment: LineAssignment = {
      id: `line_${customerId}_${iccid}`,
      customerId,
      iccid,
      assignedAt: new Date().toISOString(),
    };
    if (label) assignment.label = label;
    await this.store.putAssignment(assignment);
    return assignment;
  }

  async unassignLine(customerId: string, iccid: string): Promise<LineAssignment> {
    const rows = await this.store.listAssignments({ customerId, iccid, activeOnly: true });
    const current = rows[0];
    if (!current) throw new Error(`No active assignment for ${iccid}`);
    const next = { ...current, unassignedAt: new Date().toISOString() };
    await this.store.putAssignment(next);
    return next;
  }

  async listCustomerLines(customerId: string, options: { refresh?: boolean } = {}): Promise<Array<LineAssignment & { esim?: unknown }>> {
    const lines = await this.store.listAssignments({ customerId, activeOnly: true });
    if (!options.refresh) return lines;
    const detailed = [];
    for (const line of lines) {
      const esim = await this.client.getEsim(line.iccid);
      detailed.push({ ...line, esim: esim.data });
    }
    return detailed;
  }

  async customerUsage(
    customerId: string,
    period: UsagePeriod,
    options: { markup?: MarkupConfig; pricing?: PricingFeed; fx?: FxTable; retailCurrency?: string } = {},
  ): Promise<UsageCostReport> {
    const lines = await this.store.listAssignments({ customerId, activeOnly: true });
    const rows = [];
    const notes: string[] = [];
    let volumeComplete = lines.length > 0;
    for (const line of lines) {
      const report = await loadUsageDetails(this.client, { ...options, period, iccid: line.iccid });
      rows.push(...report.rows);
      notes.push(...report.notes);
      if (!report.volumeComplete) volumeComplete = false;
    }
    const combined = buildUsageReport(rows, period, options);
    combined.volumeComplete = volumeComplete;
    combined.notes.push(...notes);
    return combined;
  }

  async credit(customerId: string, amount: number, currency: string, memo?: string): Promise<WalletEntry> {
    return this.ledger(customerId, "credit", amount, currency, memo);
  }

  async debit(customerId: string, amount: number, currency: string, memo?: string, reference?: string): Promise<WalletEntry> {
    return this.ledger(customerId, "debit", amount, currency, memo, reference);
  }

  /** Debit the resale total from the latest usage report. Does not call POST /topup. */
  async debitUsage(customerId: string, report: UsageCostReport): Promise<WalletEntry | undefined> {
    if (report.totals.retail <= 0) return undefined;
    const currency = report.totals.retailCurrency ?? "EUR";
    return this.debit(customerId, report.totals.retail, currency, "Usage resale", report.since);
  }

  async walletBalance(customerId: string, currency: string): Promise<number> {
    const entries = await this.store.listWalletEntries(customerId);
    return entries
      .filter((entry) => entry.currency.toUpperCase() === currency.toUpperCase())
      .reduce((sum, entry) => sum + signedAmount(entry), 0);
  }

  async isLowBalance(customerId: string, currency: string, threshold: number): Promise<boolean> {
    const balance = await this.walletBalance(customerId, currency);
    return balance <= threshold;
  }

  /**
   * Marks the customer suspended in the store and suspends each active line
   * with POST /esims/{iccid}/suspend.
   */
  async suspendCustomer(customerId: string): Promise<{ customer: Customer; results: Array<{ iccid: string; ok: boolean; error?: string }> }> {
    return this.setLineState(customerId, "suspended", "suspend");
  }

  async resumeCustomer(customerId: string): Promise<{ customer: Customer; results: Array<{ iccid: string; ok: boolean; error?: string }> }> {
    return this.setLineState(customerId, "active", "resume");
  }

  /** Store-only flag. No API call. */
  async flagCustomer(customerId: string, notes?: string): Promise<Customer> {
    const customer = await this.requireCustomer(customerId);
    customer.status = "flagged";
    customer.updatedAt = new Date().toISOString();
    if (notes) customer.notes = notes;
    await this.store.putCustomer(customer);
    return customer;
  }

  async recordSnapshot(customerId: string, report: UsageCostReport) {
    const previous = (await this.store.listSnapshots({ customerId })).at(-1);
    const snapshot = snapshotUsage(report, { customerId, id: `snap_${customerId}_${report.until}` });
    await this.store.putSnapshot(snapshot);
    const delta = diffSnapshots(previous, snapshot);
    return { snapshot, delta };
  }

  async applyPackages(customerId: string, report: UsageCostReport, mode: "fifo" | "priority" = "fifo") {
    const allocations = await this.store.listAllocations({ customerId });
    const packages = await this.store.listPackages();
    const result = applyUsageToPackages(report.rows, allocations, packages, mode);
    for (const allocation of result.allocations) await this.store.putAllocation(allocation);
    return result;
  }

  private async setLineState(customerId: string, status: CustomerStatus, action: "suspend" | "resume") {
    const customer = await this.requireCustomer(customerId);
    const lines = await this.store.listAssignments({ customerId, activeOnly: true });
    const results: Array<{ iccid: string; ok: boolean; error?: string }> = [];
    for (const line of lines) {
      try {
        if (action === "suspend") await this.client.suspendEsim(line.iccid);
        else await this.client.resumeEsim(line.iccid);
        await this.store.putAssignment({ ...line, manualPause: action === "suspend" });
        results.push({ iccid: line.iccid, ok: true });
      } catch (error) {
        results.push({ iccid: line.iccid, ok: false, error: error instanceof Error ? error.message : action });
      }
    }
    customer.status = status;
    customer.updatedAt = new Date().toISOString();
    await this.store.putCustomer(customer);
    return { customer, results };
  }

  private async ledger(customerId: string, kind: WalletEntry["kind"], amount: number, currency: string, memo?: string, reference?: string): Promise<WalletEntry> {
    await this.requireCustomer(customerId);
    if (!Number.isFinite(amount) || amount < 0) throw new TypeError("amount must be >= 0");
    const entry: WalletEntry = {
      id: `wal_${(await createIdempotencyKey()).slice(0, 8)}_${Date.now().toString(36)}`,
      customerId,
      at: new Date().toISOString(),
      kind,
      amount,
      currency,
    };
    if (memo) entry.memo = memo;
    if (reference) entry.reference = reference;
    await this.store.putWalletEntry(entry);
    return entry;
  }

  private async requireCustomer(id: string): Promise<Customer> {
    const customer = await this.store.getCustomer(id);
    if (!customer) throw new Error(`Unknown customer ${id}`);
    return customer;
  }
}

export function signedAmount(entry: WalletEntry): number {
  if (entry.kind === "debit") return -entry.amount;
  return entry.amount;
}

export type { UsageDelta };
