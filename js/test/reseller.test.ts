import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NxtlClient } from "../src/client.js";
import {
  JsonFileCustomerStore,
  MemoryCustomerStore,
  SqlCustomerStore,
  WebhookRouter,
  applyUsageToPackages,
  buildCustomerInvoice,
  buildUsageReport,
  convertFx,
  definePackage,
  diffSnapshots,
  formatData,
  invoicesToCsv,
  marginReport,
  newCustomer,
  normalizeUsageRow,
  openAllocation,
  provisionCustomers,
  quoteTrip,
  searchCatalog,
  snapshotUsage,
  syncReseller,
  toBytes,
  topUpAllocation,
} from "../src/reseller/index.js";
import { CustomerDirectory } from "../src/reseller/customers.js";

const ICCID = "8900000000000000001";

describe("reseller usage and packages", () => {
  it("normalises data units and prices usage from API amounts and the feed", () => {
    assert.equal(toBytes(1, "GB"), 1_000_000_000);
    assert.equal(formatData(1_500_000_000), "1.50 GB");
    const apiRow = normalizeUsageRow({
      iccid: ICCID,
      timestamp: "2026-04-02T00:00:00.000Z",
      currency: "EUR",
      amount_usd: 0,
      amount_eur: -1.5,
      bytes: 500_000_000,
      country: "France",
    }, "cdr");
    assert.equal(apiRow.country, undefined);
    assert.equal(apiRow.bytes, undefined);
    assert.equal(apiRow.consumptionCharge, 1.5);
    assert.equal(apiRow.volumeTrusted, false);
    const measured = normalizeUsageRow({
      ...({
        iccid: ICCID,
        created_at: "2026-04-03 00:00:00",
        currency: "EUR",
        amount_usd: 0,
        amount_eur: -0.5,
        entry_type: "usage",
        bytes: 500_000_000,
        country: "France",
      }),
    }, "line_usage");
    assert.equal(measured.volumeTrusted, true);
    assert.equal(measured.country, "France");
    const report = buildUsageReport([apiRow, measured], { kind: "monthly", month: "2026-04" }, {
      markup: { percentage: 100, rounding: "nearest", currency: "EUR" },
      retailCurrency: "EUR",
    });
    assert.equal(report.countryBreakdownAvailable, true);
    assert.equal(report.byCountry[0]?.key, "France");
    assert.equal(report.totals.zeroIsNotFree, true);
    assert.equal(report.totals.wholesaleEur, 1.5);
    assert.ok(report.totals.retail > report.totals.wholesaleEur);
    const snap = snapshotUsage(report, { customerId: "cus_1" });
    const delta = diffSnapshots(undefined, snap);
    assert.equal(delta.added.length, 2);
    const second = diffSnapshots(snap, snap);
    assert.equal(second.added.length, 0);
    assert.equal(second.retail, 0);
  });

  it("splits usage across packages FIFO and flags overage", () => {
    const europe = definePackage({
      id: "eu",
      name: "Europe 1GB 30 days",
      dataCapGb: 1,
      validityDays: 30,
      countries: ["FR", "DE"],
      price: 20,
      currency: "EUR",
      overage: "flag",
      priority: 1,
    });
    const extra = definePackage({
      id: "extra",
      name: "Extra 1GB",
      dataCapGb: 1,
      validityDays: 30,
      countries: ["FR"],
      price: 10,
      currency: "EUR",
      priority: 2,
    });
    const first = openAllocation("cus", europe, { iccid: ICCID, startsAt: "2026-04-01T00:00:00.000Z", id: "a1" });
    const second = openAllocation("cus", extra, { iccid: ICCID, startsAt: "2026-04-02T00:00:00.000Z", id: "a2" });
    const rows = [
      normalizeUsageRow({ iccid: ICCID, at: "2026-04-03T00:00:00.000Z", iso2: "FR", bytes: 1_500_000_000 }),
    ];
    const result = applyUsageToPackages(rows, [second, first], [europe, extra], "fifo", new Date("2026-04-10T00:00:00.000Z"));
    const a1 = result.allocations.find((item) => item.id === "a1");
    const a2 = result.allocations.find((item) => item.id === "a2");
    assert.equal(a1?.consumedBytes, 1_000_000_000);
    assert.equal(a1?.status, "exhausted");
    assert.equal(a2?.consumedBytes, 500_000_000);
    assert.equal(result.overageBytes, 0);
    const topped = topUpAllocation(a2!, { extraBytes: 1000, extraDays: 7 });
    assert.equal(topped.bonusBytes, 1000);
  });

  it("builds an invoice, csv export, and margin report with reseller FX", () => {
    assert.equal(convertFx(10, "EUR", "USD", { base: "USD", rates: { EUR: 1.1 } }), 11);
    const usage = buildUsageReport([
      normalizeUsageRow({ iccid: ICCID, at: "2026-04-02T00:00:00.000Z", currency: "EUR", amount_usd: 0, amount_eur: -4, entry_type: "usage", bytes: 1_000_000_000, country: "France" }, "line_usage"),
    ], { kind: "range", since: "2026-04-01T00:00:00.000Z", until: "2026-05-01T00:00:00.000Z" }, {
      markup: { percentage: 50, rounding: "nearest", currency: "EUR" },
      retailCurrency: "EUR",
    });
    const pkg = definePackage({ name: "Europe 5GB 30 days", dataCapGb: 5, validityDays: 30, countries: ["FR"], price: 25, currency: "EUR" });
    const invoice = buildCustomerInvoice({
      id: "inv_1",
      customerId: "cus_1",
      currency: "EUR",
      periodSince: usage.since,
      periodUntil: usage.until,
      usage,
      packageFees: [{ pkg }],
    });
    assert.equal(invoice.lines.some((line) => line.kind === "markup"), true);
    assert.equal(invoice.lines.some((line) => line.kind === "package_fee"), true);
    assert.ok(invoice.margin > 0);
    const csv = invoicesToCsv([invoice]);
    assert.match(csv, /package_fee/);
    const report = marginReport([invoice], "EUR");
    assert.equal(report.invoiceCount, 1);
    assert.equal(report.byCustomer[0]?.customerId, "cus_1");
  });
});

describe("reseller customers and ops", () => {
  it("assigns lines, credits a wallet, and suspends through the API", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname.endsWith("/usage/cdrs")) {
        return new Response(JSON.stringify({ cdrs: [{ iccid: ICCID, amount_eur: 2, bytes: 1000, at: "2026-04-02T00:00:00.000Z", iso2: "FR" }] }), { status: 200 });
      }
      if (url.pathname.endsWith("/usage")) {
        return new Response(JSON.stringify({ usage: [] }), { status: 200 });
      }
      if (url.pathname.endsWith("/suspend")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.pathname.endsWith("/esims") && (init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ job_id: 4 }), { status: 202 });
      }
      if (url.pathname.endsWith("/jobs/4")) {
        return new Response(JSON.stringify({ status: "completed", results: [{ iccid: ICCID }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ iccid: ICCID, status: "ready" }), { status: 200 });
    };
    const client = new NxtlClient({ apiKey: "k", fetch: fetchImpl, retry: false });
    const directory = new CustomerDirectory(new MemoryCustomerStore(), client);
    const customer = await directory.saveCustomer(newCustomer({ id: "cus_1", name: "Ada", tags: ["vip"], externalId: "crm-1" }));
    await directory.assignLine(customer.id, ICCID, "phone");
    const lines = await directory.listCustomerLines(customer.id, { refresh: true });
    assert.equal(lines.length, 1);
    await directory.credit(customer.id, 30, "EUR", "prepaid");
    assert.equal(await directory.walletBalance(customer.id, "EUR"), 30);
    assert.equal(await directory.isLowBalance(customer.id, "EUR", 10), false);
    const suspended = await directory.suspendCustomer(customer.id);
    assert.equal(suspended.customer.status, "suspended");
    assert.equal(suspended.results[0]?.ok, true);
    assert.ok(calls.some((call) => call.includes("/suspend")));
    const provisioned = await provisionCustomers(client, directory, [{ customerId: "cus_1", idempotencyKey: "row-1" }], {
      wait: true,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });
    assert.equal(provisioned[0]?.ok, true);
    assert.equal(provisioned[0]?.iccid, ICCID);
  });

  it("syncs usage into the wallet and routes a webhook", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/usage/cdrs")) {
        return new Response(JSON.stringify({
          cdrs: [{ id: 7, iccid: ICCID, currency: "EUR", amount_eur: -3, amount_usd: 0, bytes: 0, country: "", created_at: "2026-04-02 00:00:00" }],
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    const client = new NxtlClient({ apiKey: "k", fetch: fetchImpl, retry: false });
    const directory = new CustomerDirectory(new MemoryCustomerStore(), client);
    await directory.saveCustomer({ id: "cus_9", name: "Bea" });
    await directory.assignLine("cus_9", ICCID);
    await directory.credit("cus_9", 10, "EUR");
    const alerts: string[] = [];
    const synced = await syncReseller(directory, {
      period: { kind: "monthly", month: "2026-04" },
      markup: { percentage: 0, rounding: "nearest", currency: "EUR" },
      retailCurrency: "EUR",
      lowBalance: { currency: "EUR", threshold: 20 },
      onAlert: (alert) => { alerts.push(alert.type); },
    });
    assert.equal(synced.customers, 1);
    assert.ok(alerts.includes("low_balance"));
    assert.ok((await directory.walletBalance("cus_9", "EUR")) < 10);
    const router = new WebhookRouter(client);
    const seen: string[] = [];
    router.on("esim.provisioned", (event) => { seen.push(event.event); });
    router.on("balance.low", (event) => { seen.push(event.event); });
    await router.dispatch({ id: "evt_1", event: "esim.provisioned", timestamp: 1, data: { iccid: ICCID } });
    await router.dispatch({ id: "evt_2", event: "balance.low", timestamp: 1, data: {} });
    assert.deepEqual(seen, ["esim.provisioned", "balance.low"]);
  });

  it("searches the catalog and quotes a trip", () => {
    const pricing = { countries: [
      { iso2: "FR", name: "France", cheapest_eur_per_gb: 2 },
      { iso2: "DE", name: "Germany", cheapest_eur_per_gb: 4 },
    ] };
    const found = searchCatalog({ pricing, country: "FR", maxEurPerGb: 3 });
    assert.equal(found.matches.length, 1);
    const quote = quoteTrip({
      pricing,
      countries: ["FR", "DE"],
      estimatedGb: 2,
      split: "even",
      markup: { percentage: 0, rounding: "nearest", currency: "EUR" },
    });
    assert.equal(quote.segments.length, 2);
    assert.equal(quote.wholesaleEur, 1 * 2 + 1 * 4);
    assert.equal(quote.retail, quote.wholesaleEur);
  });

  it("round-trips a JSON file store and records SQL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nxtl-reseller-"));
    const store = new JsonFileCustomerStore(join(dir, "store.json"));
    await store.putCustomer(newCustomer({ id: "cus_file", name: "File" }));
    const text = await readFile(join(dir, "store.json"), "utf8");
    assert.match(text, /cus_file/);
    const again = new JsonFileCustomerStore(join(dir, "store.json"));
    assert.equal((await again.getCustomer("cus_file"))?.name, "File");

    const sql: string[] = [];
    const rows: Array<Record<string, unknown>> = [];
    const sqlStore = new SqlCustomerStore(async (statement, params = []) => {
      sql.push(statement);
      if (statement.startsWith("INSERT INTO nxtl_reseller_customers")) {
        rows.push({
          id: params[0],
          external_id: params[1],
          name: params[2],
          email: params[3],
          tags_json: params[4],
          notes: params[5],
          metadata_json: params[6],
          status: params[7],
          created_at: params[8],
          updated_at: params[9],
        });
      }
      if (statement.startsWith("SELECT * FROM nxtl_reseller_customers WHERE")) {
        return rows.filter((row) => row.id === params[0]);
      }
      return [];
    });
    await sqlStore.putCustomer(newCustomer({ id: "cus_sql", name: "Sql" }));
    const loaded = await sqlStore.getCustomer("cus_sql");
    assert.equal(loaded?.name, "Sql");
    assert.ok(sql[0]?.includes("nxtl_reseller_customers"));
  });
});
