/**
 * Monthly billing export for a NXTL eSIM reseller.
 *
 * The sample prices rows you already collected. Swap `rows` for
 * `loadUsageDetails` when you want a live read of GET /usage/cdrs.
 * The CSV is your invoice, not GET /invoices (that route lists pool top-ups).
 */
import { writeFileSync } from "node:fs";
import {
  buildCustomerInvoice,
  buildUsageReport,
  definePackage,
  invoicesToCsv,
  normalizeUsageRow,
} from "@nxtlsim/esim-sdk";

const rows = [
  normalizeUsageRow({
    iccid: "8900000000000000001",
    at: "2026-04-04T12:00:00.000Z",
    amount_eur: 3.2,
    bytes: 800_000_000,
    iso2: "FR",
  }),
];

const usage = buildUsageReport(rows, { kind: "monthly", month: "2026-04" }, {
  markup: { percentage: 40, rounding: "nearest", currency: "EUR" },
  retailCurrency: "EUR",
});

const invoice = buildCustomerInvoice({
  id: "inv_2026_04_cus_1",
  customerId: "cus_1",
  currency: "EUR",
  periodSince: usage.since,
  periodUntil: usage.until,
  usage,
  packageFees: [{
    pkg: definePackage({
      name: "Europe 5GB 30 days",
      dataCapGb: 5,
      validityDays: 30,
      countries: ["FR", "DE", "ES", "IT"],
      price: 29,
      currency: "EUR",
    }),
  }],
});

const csv = invoicesToCsv([invoice]);
writeFileSync(new URL("./invoice.csv", import.meta.url), csv);
process.stdout.write(csv);
