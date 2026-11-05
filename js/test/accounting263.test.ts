import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NxtlClient } from "../src/index.js";
import { countryNameToIso2 } from "../src/reseller/countries.js";
import { classifyUsageWebhook, syncReseller } from "../src/reseller/monitoring.js";
import { postingForRow, roundHalfUp } from "../src/reseller/money.js";
import { applyUsageToPackages, definePackage, openAllocation, suspendOverageLines } from "../src/reseller/packages.js";
import { CUSTOMER_STORE_SQL, MemoryCustomerStore, SqlCustomerStore } from "../src/reseller/store.js";
import { CustomerDirectory } from "../src/reseller/customers.js";
import { normalizeUsageRow } from "../src/reseller/usage.js";

const ICCID = "8900000000000000001";
const OTHER = "8900000000000000002";

describe("OpenAPI 2.6.3 accounting", () => {
  it("distinguishes legacy empty volume, missing detail, and measured zero", () => {
    const legacy = normalizeUsageRow({ id: 1, currency: "EUR", amount_usd: 0, amount_eur: -0.42, bytes: 0, country: "" }, "cdr", { iccid: ICCID });
    assert.equal(legacy.detailAvailable, undefined);
    assert.equal(legacy.volumeTrusted, false);
    assert.equal(legacy.iccid, ICCID);
    const missing = normalizeUsageRow({ id: 2, ledger_id: 2, detail_available: false, currency: "EUR", amount_usd: 0, amount_eur: -0.42, bytes: 0, country: "" }, "cdr");
    assert.equal(missing.volumeTrusted, false);
    assert.equal(missing.bytes, undefined);
    const measured = normalizeUsageRow({ id: 3, ledger_id: 3, detail_available: true, currency: "EUR", amount_usd: 0, amount_eur: -0.42, bytes: 0, country: "Germany" }, "cdr");
    assert.equal(measured.volumeTrusted, true);
    assert.equal(measured.bytes, 0);
    assert.equal(measured.countryIso2, "DE");
    assert.equal(countryNameToIso2("Germany"), "DE");
  });

  it("prices markup and FX the same way for a wallet posting and leaves missing FX unresolved", () => {
    const debit = normalizeUsageRow({ id: 1, currency: "EUR", amount_usd: 0, amount_eur: -0.42 }, "cdr");
    const marked = postingForRow(debit, { walletCurrency: "EUR", markup: { percentage: 100, rounding: "nearest", currency: "EUR" } });
    assert.equal(marked.acquisition, 0.42);
    assert.equal(marked.selling, 0.84);
    assert.equal(marked.margin, 0.42);
    const usd = normalizeUsageRow({ id: 2, currency: "USD", amount_usd: -1, amount_eur: 0 }, "cdr");
    const unresolved = postingForRow(usd, { walletCurrency: "EUR" });
    assert.equal(unresolved.status, "unresolved");
    assert.equal(unresolved.reason, "missing_fx");
    const converted = postingForRow(usd, { walletCurrency: "EUR", fx: { base: "EUR", rates: { USD: 0.5 } } });
    assert.equal(converted.status, "ready");
    assert.equal(converted.acquisition, 0.5);
    const credit = normalizeUsageRow({ id: 3, currency: "EUR", amount_usd: 0, amount_eur: 0.42 }, "cdr");
    const refund = postingForRow(credit, { walletCurrency: "EUR", markup: { percentage: 100, rounding: "nearest", currency: "EUR" } });
    assert.equal(refund.kind, "credit");
    assert.equal(refund.selling, 0.42);
    assert.equal(roundHalfUp(1.005, 2), 1.01);
  });

  it("does not charge a webhook that has no ledger id and does not collapse distinct ledger ids", async () => {
    assert.equal(classifyUsageWebhook({ id: "evt_1", data: { ledger_id: null } }).deferred, true);
    assert.equal(classifyUsageWebhook({ id: "evt_2", data: {} }).deferred, true);
    assert.equal(classifyUsageWebhook({ id: "evt_3", data: { ledger_id: 9 } }).ledgerId, 9);
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}?${url.searchParams.toString()}`);
      if (!url.pathname.endsWith("/usage/cdrs")) return new Response("{}", { status: 200 });
      const after = Number(url.searchParams.get("after_id") ?? "0");
      const accounting = url.searchParams.get("accounting");
      assert.equal(accounting, "1");
      const rows = after >= 8 ? [] : [
        { id: 7, ledger_id: 7, currency: "EUR", amount_usd: 0, amount_eur: -0.42, created_at: "2026-07-02 00:00:00", bytes: 10, country: "Germany", detail_available: true },
        { id: 8, ledger_id: 8, currency: "EUR", amount_usd: 0, amount_eur: -0.42, created_at: "2026-07-02 00:00:00", bytes: 10, country: "Germany", detail_available: true },
      ];
      return new Response(JSON.stringify({ cdrs: rows, total: rows.length, page: 1, pages: 99, next_cursor: null }), { status: 200 });
    };
    const client = new NxtlClient({ apiKey: "k", fetch: fetchImpl, retry: false });
    const directory = new CustomerDirectory(new MemoryCustomerStore(), client);
    await directory.saveCustomer({ id: "cus", name: "Ada" });
    await directory.assignLine("cus", ICCID);
    await directory.credit("cus", 10, "EUR");
    const pkg = definePackage({ id: "de", name: "DE", dataCapGb: 1, validityDays: 30, countries: ["DE"], price: 1, currency: "EUR" });
    await directory.store.putPackage(pkg);
    await directory.store.putAllocation(openAllocation("cus", pkg, { iccid: ICCID, startsAt: "2026-07-01T00:00:00.000Z", id: "a1" }));
    await syncReseller(directory, {
      period: { kind: "range", since: "2026-07-01T00:00:00.000Z", until: "2026-08-01T00:00:00.000Z" },
      retailCurrency: "EUR",
      markup: { percentage: 0, rounding: "nearest", currency: "EUR" },
    });
    await syncReseller(directory, {
      period: { kind: "range", since: "2026-07-01T00:00:00.000Z", until: "2026-08-01T00:00:00.000Z" },
      retailCurrency: "EUR",
    });
    assert.equal(await directory.walletBalance("cus", "EUR"), 9.16);
    const allocation = (await directory.store.listAllocations({ customerId: "cus" }))[0];
    assert.equal(allocation?.consumedBytes, 20);
    assert.ok(calls.some((call) => call.includes("after_id=0")));
    assert.ok(calls.some((call) => call.includes("after_id=8")));
  });

  it("keeps missing detail pending and fills it from a page lookup, not the cursor", async () => {
    let phase = "missing";
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/usage/cdrs")) return new Response("{}", { status: 200 });
      const after = url.searchParams.get("after_id");
      if (after !== null) {
        const cursor = Number(after);
        const rows = cursor >= 5 ? [] : [{
          id: 5, ledger_id: 5, currency: "EUR", amount_usd: 0, amount_eur: -1, created_at: "2026-07-03 00:00:00",
          bytes: 0, country: "", detail_available: false,
        }];
        return new Response(JSON.stringify({ cdrs: rows, total: rows.length, page: 1, pages: 1, next_cursor: null }), { status: 200 });
      }
      const rows = phase === "ready" ? [{
        id: 5, ledger_id: 5, currency: "EUR", amount_usd: 0, amount_eur: -1, created_at: "2026-07-03 00:00:00",
        bytes: 100, country: "Germany", detail_available: true,
      }] : [];
      return new Response(JSON.stringify({ cdrs: rows, total: rows.length, page: 1, pages: 1 }), { status: 200 });
    };
    const client = new NxtlClient({ apiKey: "k", fetch: fetchImpl, retry: false });
    const directory = new CustomerDirectory(new MemoryCustomerStore(), client);
    await directory.saveCustomer({ id: "cus", name: "Ada" });
    await directory.assignLine("cus", ICCID);
    await directory.credit("cus", 5, "EUR");
    const period = { kind: "range" as const, since: "2026-07-01T00:00:00.000Z", until: "2026-08-01T00:00:00.000Z" };
    await syncReseller(directory, { period, retailCurrency: "EUR" });
    assert.equal(await directory.walletBalance("cus", "EUR"), 4);
    const pending = await directory.store.listPending(expectScope(ICCID));
    assert.equal(pending.length, 1);
    const before = (await directory.store.listAllocations({ customerId: "cus" })).reduce((sum, item) => sum + item.consumedBytes, 0);
    assert.equal(before, 0);
    phase = "ready";
    const pkg = definePackage({ id: "de", name: "DE", dataCapGb: 1, validityDays: 30, countries: ["DE"], price: 1, currency: "EUR" });
    await directory.store.putPackage(pkg);
    await directory.store.putAllocation(openAllocation("cus", pkg, { iccid: ICCID, startsAt: "2026-07-01T00:00:00.000Z", id: "a1" }));
    await syncReseller(directory, { period, retailCurrency: "EUR" });
    assert.equal(await directory.walletBalance("cus", "EUR"), 4);
    const allocation = (await directory.store.listAllocations({ customerId: "cus" })).find((item) => item.id === "a1");
    assert.equal(allocation?.consumedBytes, 100);
  });

  it("matches Germany to DE, suspends exact exhaustion, and keeps an alternate package", async () => {
    const germany = definePackage({ id: "de", name: "Germany", dataCapGb: 0.000001, validityDays: 30, countries: ["DE"], price: 1, currency: "EUR", overage: "suspend" });
    const row = normalizeUsageRow({
      id: 1, ledger_id: 1, detail_available: true, iccid: ICCID, entry_type: "usage",
      currency: "EUR", amount_usd: 0, amount_eur: -0.1, created_at: "2026-07-04 00:00:00", bytes: germany.dataCapBytes, country: "Germany",
    }, "cdr");
    const first = openAllocation("cus", germany, { iccid: ICCID, startsAt: "2026-07-01T00:00:00.000Z", id: "only" });
    const now = new Date("2026-07-10T00:00:00.000Z");
    const consumed = applyUsageToPackages([row], [first], [germany], "fifo", now);
    assert.equal(consumed.allocations[0]?.status, "exhausted");
    const calls: string[] = [];
    const client = new NxtlClient({
      apiKey: "k",
      retry: false,
      fetch: async (input) => {
        calls.push(String(input));
        return new Response("{}", { status: 200 });
      },
    });
    const suspended = await suspendOverageLines(client, consumed.allocations, [germany], { now });
    assert.equal(suspended[0]?.ok, true);
    const spare = definePackage({ id: "spare", name: "Spare", dataCapGb: 1, validityDays: 30, price: 1, currency: "EUR", overage: "suspend" });
    const second = openAllocation("cus", spare, { iccid: ICCID, startsAt: "2026-07-01T00:00:00.000Z", id: "spare" });
    const kept = await suspendOverageLines(client, [...consumed.allocations, second], [germany, spare], { now });
    assert.equal(kept.length, 0);
    assert.equal(calls.length, 1);
  });

  it("does not resume a manually paused line and stores that flag", async () => {
    const store = new MemoryCustomerStore();
    const client = new NxtlClient({ apiKey: "k", retry: false, fetch: async () => new Response("{}", { status: 200 }) });
    const directory = new CustomerDirectory(store, client);
    await directory.saveCustomer({ id: "cus", name: "Ada" });
    await directory.assignLine("cus", ICCID);
    await directory.suspendCustomer("cus");
    const line = (await store.listAssignments({ customerId: "cus" }))[0];
    assert.equal(line?.manualPause, true);
  });

  it("rolls back a SQL transaction and rejects a concurrent duplicate wallet id", async (t) => {
    let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
    try {
      DatabaseSync = (await import("node:sqlite")).DatabaseSync;
    } catch {
      t.skip("node:sqlite is unavailable");
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), "nxtl-sql-"));
    const path = join(directory, "reseller.sqlite");
    const db = new DatabaseSync(path);
    db.exec(CUSTOMER_STORE_SQL);
    db.exec("PRAGMA busy_timeout = 2000");
    const query = async (sql: string, params: readonly unknown[] = []) => {
      const statement = db.prepare(sql);
      const bound = params as never[];
      if (sql.trim().toUpperCase().startsWith("SELECT")) return statement.all(...bound) as Array<Record<string, unknown>>;
      statement.run(...bound);
      return [];
    };
    const transaction = async <T>(fn: (q: typeof query) => Promise<T>): Promise<T> => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(query);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };
    const store = new SqlCustomerStore(query, transaction);
    await store.putAssignment({ id: "line", customerId: "cus", iccid: ICCID, assignedAt: "2026-07-01T00:00:00.000Z", manualPause: true });
    const loaded = await store.listAssignments({ iccid: ICCID });
    assert.equal(loaded[0]?.manualPause, true);
    await store.commitSync({
      wallet: [{ id: "wal_1", customerId: "cus", at: "2026-07-01T00:00:00.000Z", kind: "debit", amount: 1, currency: "EUR" }],
      applied: [{ stream: "financial", key: "1" }],
    });
    await assert.rejects(() => store.commitSync({
      wallet: [{ id: "wal_1", customerId: "cus", at: "2026-07-01T00:00:00.000Z", kind: "debit", amount: 1, currency: "EUR" }],
      applied: [{ stream: "financial", key: "2" }],
    }));
    const rows = await store.listWalletEntries("cus");
    assert.equal(rows.length, 1);
    await assert.rejects(() => transaction(async (q) => {
      await q("INSERT INTO nxtl_reseller_wallet (id, customer_id, at, kind, amount, currency, memo, reference) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["wal_2", "cus", "2026-07-01T00:00:00.000Z", "debit", 3, "EUR", null, null]);
      throw new Error("crash");
    }));
    assert.equal((await store.listWalletEntries("cus")).length, 1);
    const other = new DatabaseSync(path);
    other.exec("PRAGMA busy_timeout = 100");
    db.exec("BEGIN IMMEDIATE");
    let blocked = false;
    try {
      other.exec("BEGIN IMMEDIATE");
    } catch {
      blocked = true;
    }
    db.exec("ROLLBACK");
    assert.equal(blocked, true);
    other.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
});

function expectScope(iccid: string): string {
  return `default|${iccid}|2026-07-01T00:00:00.000Z|2026-08-01T00:00:00.000Z`;
}
