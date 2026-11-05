/**
 * Reseller invoices. NXTL GET /invoices lists orders for API pool top-ups.
 * These documents are the reseller's own bills to their customers.
 */

import { formatMoneyWithFx, type FxTable } from "./fx.js";
import type { SellablePackage, StoredInvoice } from "./store.js";
import type { UsageCostReport } from "./usage.js";

export type InvoiceLineKind = "usage" | "markup" | "package_fee" | "adjustment";

export interface InvoiceLine {
  kind: InvoiceLineKind;
  description: string;
  quantity?: number;
  unit?: string;
  wholesale: number;
  amount: number;
  currency: string;
  iccid?: string;
}

export interface CustomerInvoice {
  id: string;
  customerId: string;
  currency: string;
  periodSince: string;
  periodUntil: string;
  lines: InvoiceLine[];
  /** What the customer owes. */
  total: number;
  /** Wholesale usage cost in the invoice currency. */
  wholesaleTotal: number;
  margin: number;
  issuedAt: string;
}

export interface PackageFeeInput {
  pkg: SellablePackage;
  quantity?: number;
  description?: string;
}

export function buildCustomerInvoice(input: {
  id?: string;
  customerId: string;
  currency: string;
  periodSince: string;
  periodUntil: string;
  usage?: UsageCostReport;
  packageFees?: PackageFeeInput[];
  fx?: FxTable;
  adjustments?: Array<{ description: string; amount: number; currency: string }>;
  issuedAt?: string;
}): CustomerInvoice {
  const currency = input.currency;
  const lines: InvoiceLine[] = [];
  if (input.usage) {
    const wholesale = wholesaleInCurrency(input.usage, currency, input.fx);
    const retailCurrency = input.usage.totals.retailCurrency ?? currency;
    const retail = convertIfNeeded(input.usage.totals.retail, retailCurrency, currency, input.fx);
    const markup = Math.max(0, retail - wholesale);
    lines.push({
      kind: "usage",
      description: `NXTL API charge ${input.periodSince.slice(0, 10)} to ${input.periodUntil.slice(0, 10)}`,
      quantity: input.usage.totals.bytes,
      unit: "bytes",
      wholesale,
      amount: wholesale,
      currency,
    });
    lines.push({
      kind: "markup",
      description: "Reseller markup on usage",
      wholesale: 0,
      amount: markup,
      currency,
    });
  }
  for (const fee of input.packageFees ?? []) {
    const quantity = fee.quantity ?? 1;
    const amount = convertIfNeeded(fee.pkg.price * quantity, fee.pkg.currency, currency, input.fx);
    lines.push({
      kind: "package_fee",
      description: fee.description ?? `Package ${fee.pkg.name}`,
      quantity,
      wholesale: 0,
      amount,
      currency,
    });
  }
  for (const adjustment of input.adjustments ?? []) {
    lines.push({
      kind: "adjustment",
      description: adjustment.description,
      wholesale: 0,
      amount: convertIfNeeded(adjustment.amount, adjustment.currency, currency, input.fx),
      currency,
    });
  }
  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  const wholesaleTotal = lines.reduce((sum, line) => sum + line.wholesale, 0);
  return {
    id: input.id ?? `inv_${Date.now().toString(36)}`,
    customerId: input.customerId,
    currency,
    periodSince: input.periodSince,
    periodUntil: input.periodUntil,
    lines,
    total,
    wholesaleTotal,
    margin: total - wholesaleTotal,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
  };
}

export function storeInvoice(invoice: CustomerInvoice): StoredInvoice {
  return {
    id: invoice.id,
    customerId: invoice.customerId,
    currency: invoice.currency,
    periodSince: invoice.periodSince,
    periodUntil: invoice.periodUntil,
    total: invoice.total,
    wholesaleTotal: invoice.wholesaleTotal,
    margin: invoice.margin,
    issuedAt: invoice.issuedAt,
    document: { lines: invoice.lines },
  };
}

export interface Statement {
  customerId: string;
  currency: string;
  openingBalance: number;
  invoices: CustomerInvoice[];
  credits: number;
  debits: number;
  closingBalance: number;
  lines: string[];
}

export function buildStatement(input: {
  customerId: string;
  currency: string;
  openingBalance: number;
  invoices: CustomerInvoice[];
  credits: number;
  debits: number;
}): Statement {
  const closing = input.openingBalance + input.credits - input.debits;
  const lines = [
    `Customer ${input.customerId}`,
    `Opening ${input.openingBalance.toFixed(2)} ${input.currency}`,
    ...input.invoices.map((invoice) => `Invoice ${invoice.id} ${invoice.total.toFixed(2)} ${invoice.currency} margin ${invoice.margin.toFixed(2)}`),
    `Credits ${input.credits.toFixed(2)}`,
    `Debits ${input.debits.toFixed(2)}`,
    `Closing ${closing.toFixed(2)} ${input.currency}`,
  ];
  return {
    customerId: input.customerId,
    currency: input.currency,
    openingBalance: input.openingBalance,
    invoices: input.invoices,
    credits: input.credits,
    debits: input.debits,
    closingBalance: closing,
    lines,
  };
}

export interface MarginReport {
  currency: string;
  revenue: number;
  cost: number;
  margin: number;
  invoiceCount: number;
  byCustomer: Array<{ customerId: string; revenue: number; cost: number; margin: number }>;
}

export function marginReport(invoices: readonly CustomerInvoice[], currency: string): MarginReport {
  const relevant = invoices.filter((invoice) => invoice.currency.toUpperCase() === currency.toUpperCase());
  const byCustomer = new Map<string, { revenue: number; cost: number; margin: number }>();
  for (const invoice of relevant) {
    const current = byCustomer.get(invoice.customerId) ?? { revenue: 0, cost: 0, margin: 0 };
    current.revenue += invoice.total;
    current.cost += invoice.wholesaleTotal;
    current.margin += invoice.margin;
    byCustomer.set(invoice.customerId, current);
  }
  return {
    currency,
    revenue: relevant.reduce((sum, invoice) => sum + invoice.total, 0),
    cost: relevant.reduce((sum, invoice) => sum + invoice.wholesaleTotal, 0),
    margin: relevant.reduce((sum, invoice) => sum + invoice.margin, 0),
    invoiceCount: relevant.length,
    byCustomer: [...byCustomer.entries()].map(([customerId, totals]) => ({ customerId, ...totals })),
  };
}

export function invoicesToJson(invoices: readonly CustomerInvoice[]): string {
  return JSON.stringify(invoices, null, 2);
}

export function invoicesToCsv(invoices: readonly CustomerInvoice[]): string {
  const header = ["invoice_id", "customer_id", "currency", "period_since", "period_until", "line_kind", "description", "wholesale", "amount", "invoice_total", "margin"];
  const rows = [header.join(",")];
  for (const invoice of invoices) {
    for (const line of invoice.lines) {
      rows.push([
        invoice.id,
        invoice.customerId,
        invoice.currency,
        invoice.periodSince,
        invoice.periodUntil,
        line.kind,
        csvEscape(line.description),
        line.wholesale.toFixed(4),
        line.amount.toFixed(4),
        invoice.total.toFixed(4),
        invoice.margin.toFixed(4),
      ].join(","));
    }
  }
  return `${rows.join("\n")}\n`;
}

export function formatInvoice(invoice: CustomerInvoice, locale = "en-US"): string[] {
  return invoice.lines.map((line) => {
    const money = formatMoneyWithFx(line.amount, line.currency, line.currency, undefined, locale);
    return `${line.kind}: ${line.description} ${money.formatted}`;
  });
}

function wholesaleInCurrency(report: UsageCostReport, currency: string, fx: FxTable | undefined): number {
  const code = currency.toUpperCase();
  if (code === "USD") return report.totals.wholesaleUsd + (fx ? convertIfNeeded(report.totals.wholesaleEur, "EUR", "USD", fx) : 0);
  if (code === "EUR") return report.totals.wholesaleEur + (fx ? convertIfNeeded(report.totals.wholesaleUsd, "USD", "EUR", fx) : 0);
  const usd = fx ? convertIfNeeded(report.totals.wholesaleUsd, "USD", currency, fx) : 0;
  const eur = fx ? convertIfNeeded(report.totals.wholesaleEur, "EUR", currency, fx) : 0;
  return usd + eur;
}

function convertIfNeeded(amount: number, from: string, to: string, fx: FxTable | undefined): number {
  if (from.toUpperCase() === to.toUpperCase()) return amount;
  if (!fx) throw new TypeError(`FX table required to convert ${from} to ${to}`);
  return formatMoneyWithFx(amount, from, to, fx).amount;
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
