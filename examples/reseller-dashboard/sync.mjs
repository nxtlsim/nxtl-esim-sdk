/**
 * Reseller dashboard sync for NXTL eSIM.
 *
 * Polls published usage endpoints, stores the delta on a JSON customer file,
 * and debits the reseller's prepaid wallet. This is not an NXTL plan.
 *
 *   npm install @nxtlsim/esim-sdk
 *   NXTL_API_KEY=... node sync.mjs
 */
import { NxtlClient, JsonFileCustomerStore, CustomerDirectory, syncReseller } from "@nxtlsim/esim-sdk";

const nxtl = new NxtlClient({ apiKey: process.env.NXTL_API_KEY });
const directory = new CustomerDirectory(new JsonFileCustomerStore(process.env.NXTL_STORE ?? "customers.json"), nxtl);

const month = new Date().toISOString().slice(0, 7);
const result = await syncReseller(directory, {
  period: { kind: "monthly", month },
  markup: { percentage: 35, rounding: "0.99", currency: "EUR" },
  retailCurrency: "EUR",
  lowBalance: { currency: "EUR", threshold: 5 },
  packageMode: "fifo",
  suspendOverage: false,
  onAlert(alert) {
    process.stdout.write(`${alert.type} ${alert.customerId}\n`);
  },
});

process.stdout.write(`synced ${result.customers} customers, ${result.alerts.length} alerts\n`);
