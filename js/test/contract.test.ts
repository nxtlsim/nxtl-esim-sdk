import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NxtlAlreadyTerminatedError,
  NxtlClient,
  NxtlResumeBlockedError,
} from "../src/index.js";
import { MemoryCustomerStore } from "../src/reseller/store.js";
import { CustomerDirectory } from "../src/reseller/customers.js";
import {
  apiCharge,
  parseRollupNumber,
  parseUtcTimestamp,
  webhookCharge,
} from "../src/reseller/ledger.js";
import { buildUsageReport, loadUsageDetails, normalizeUsageRow } from "../src/reseller/usage.js";
import { syncReseller } from "../src/reseller/monitoring.js";

const ICCID = "8900000000000000001";

describe("OpenAPI 2.6.2 usage contract", () => {
  it("treats a EUR debit with USD zero as a 0.42 API charge and ignores CDR placeholder volume", () => {
    const charge = apiCharge({ currency: "EUR", amount_usd: 0, amount_eur: -0.42 });
    assert.equal(charge.consumptionCharge, 0.42);
    assert.equal(charge.kind, "debit");
    const credit = apiCharge({ currency: "EUR", amount_usd: 0, amount_eur: 0.42 });
    assert.equal(credit.kind, "credit");
    assert.equal(credit.consumptionCharge, 0);
    const cdr = normalizeUsageRow({
      id: 1001,
      iccid: ICCID,
      currency: "EUR",
      amount_usd: 0,
      amount_eur: -0.42,
      created_at: "2026-07-31 12:00:05",
      bytes: 0,
      mb: 0,
      country: "",
      operator: "",
    }, "cdr");
    assert.equal(cdr.ledgerId, 1001);
    assert.equal(cdr.volumeTrusted, false);
    assert.equal(cdr.bytes, undefined);
    assert.equal(cdr.country, undefined);
    assert.equal(parseUtcTimestamp("2026-07-31 12:00:05"), "2026-07-31T12:00:05.000Z");
    const detail = normalizeUsageRow({
      entry_type: "usage",
      currency: "EUR",
      amount_usd: 0,
      amount_eur: -0.42,
      created_at: "2026-07-31 12:00:05",
      bytes: 1048576,
      country: "Germany",
      operator: "Telekom",
    }, "line_usage");
    const topup = normalizeUsageRow({
      entry_type: "topup",
      currency: "EUR",
      amount_usd: 0,
      amount_eur: 10,
      created_at: "2026-07-31 12:00:06",
      bytes: 999,
      country: "Germany",
    }, "line_usage");
    assert.equal(detail.country, "Germany");
    assert.equal(detail.bytes, 1048576);
    assert.equal(topup.volumeTrusted, false);
    assert.equal(topup.bytes, undefined);
    const report = buildUsageReport([cdr, detail, topup], {
      kind: "range",
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-08-01T00:00:00.000Z",
    }, { markup: { percentage: 0, rounding: "nearest", currency: "EUR" }, retailCurrency: "EUR" });
    assert.equal(report.totals.wholesaleEur, 0.42);
    assert.equal(report.totals.bytes, 1048576);
    assert.equal(report.byCountry[0]?.key, "Germany");
    assert.equal(parseRollupNumber("0.4200"), 0.42);
    const hook = webhookCharge({ currency: "EUR", amount: 0.42 });
    assert.equal(hook.consumptionCharge, 0.42);
  });

  it("requests accounting CDRs, keeps one charge, and does not double-bill", async () => {
    const queries: string[] = [];
    const bodies: Array<{ method: string; path: string; body?: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      let body: unknown;
      if (typeof init?.body === "string" && init.body) body = JSON.parse(init.body);
      bodies.push({ method, path: url.pathname, ...(body !== undefined ? { body } : {}) });
      if (url.pathname.endsWith("/usage/cdrs")) {
        queries.push(url.search);
        const after = Number(url.searchParams.get("after_id") ?? "0");
        const row = after >= 1001 ? [] : [{
          id: 1001,
          ledger_id: 1001,
          iccid: ICCID,
          currency: "EUR",
          amount_usd: 0,
          amount_eur: -0.42,
          created_at: "2026-07-31 12:00:05",
          bytes: 1048576,
          country: "Germany",
          detail_available: true,
        }];
        return new Response(JSON.stringify({
          cdrs: row,
          total: row.length,
          page: 1,
          pages: 1,
          next_cursor: null,
        }), { status: 200 });
      }
      if (method === "POST" && url.pathname.endsWith("/suspend")) return new Response("{}", { status: 200 });
      if (method === "POST" && url.pathname.endsWith("/resume")) return new Response("{}", { status: 200 });
      if (method === "PATCH" && url.pathname.endsWith("/status")) {
        return new Response(JSON.stringify({ error: "already_terminated" }), { status: 409 });
      }
      return new Response("{}", { status: 200 });
    };
    const client = new NxtlClient({ apiKey: "k", fetch: fetchImpl, retry: false });
    const report = await loadUsageDetails(client, {
      iccid: ICCID,
      period: { kind: "monthly", month: "2026-07" },
      markup: { percentage: 0, rounding: "nearest", currency: "EUR" },
      retailCurrency: "EUR",
    });
    assert.match(queries[0] ?? "", /accounting=1/);
    assert.match(queries[0] ?? "", /after_id=0/);
    assert.match(queries[0] ?? "", /page=1/);
    assert.equal(report.totals.wholesaleEur, 0.42);
    assert.equal(report.totals.bytes, 1048576);
    assert.equal(report.volumeComplete, true);
    const directory = new CustomerDirectory(new MemoryCustomerStore(), client);
    await directory.saveCustomer({ id: "cus", name: "Ada" });
    await directory.assignLine("cus", ICCID);
    await directory.credit("cus", 10, "EUR");
    await syncReseller(directory, { period: { kind: "monthly", month: "2026-07" }, retailCurrency: "EUR" });
    await syncReseller(directory, { period: { kind: "monthly", month: "2026-07" }, retailCurrency: "EUR" });
    assert.equal(await directory.walletBalance("cus", "EUR"), 9.58);
    await directory.client.suspendEsim(ICCID);
    await directory.client.resumeEsim(ICCID);
    await assert.rejects(() => directory.client.updateStatus(ICCID, { action: "terminate" }), NxtlAlreadyTerminatedError);
    const suspend = bodies.find((call) => call.path.endsWith("/suspend"));
    const resume = bodies.find((call) => call.path.endsWith("/resume"));
    const terminate = bodies.find((call) => call.path.endsWith("/status"));
    assert.equal(suspend?.method, "POST");
    assert.equal(suspend?.body, undefined);
    assert.equal(resume?.method, "POST");
    assert.equal(terminate?.method, "PATCH");
    assert.deepEqual(terminate?.body, { action: "terminate" });
  });

  it("maps resume_blocked separately from insufficient balance", async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ error: "resume_blocked" }), { status: 402 });
    const client = new NxtlClient({ apiKey: "k", fetch: fetchImpl, retry: false });
    await assert.rejects(() => client.resumeEsim(ICCID), NxtlResumeBlockedError);
  });
});
