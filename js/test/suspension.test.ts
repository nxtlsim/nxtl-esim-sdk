import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NxtlClient } from "../src/index.js";
import { CustomerDirectory } from "../src/reseller/customers.js";
import { syncReseller } from "../src/reseller/monitoring.js";
import { definePackage, openAllocation } from "../src/reseller/packages.js";
import { MemoryCustomerStore } from "../src/reseller/store.js";

const ICCID = "8900000000000000001";
const OTHER = "8900000000000000002";
const PERIOD = { kind: "range" as const, since: "2026-01-01T00:00:00.000Z", until: "2026-02-01T00:00:00.000Z" };

function client(suspend: (iccid: string) => Response): { client: NxtlClient; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/suspend")) {
      calls.push(url.pathname);
      return suspend(url.pathname);
    }
    if (url.pathname.endsWith("/usage/cdrs")) {
      return new Response(JSON.stringify({ cdrs: [], total: 0, page: 1, pages: 0, next_cursor: null }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
  return { client: new NxtlClient({ apiKey: "k", fetch: fetchImpl, retry: false }), calls };
}

describe("package suspension", () => {
  it("expires a package and suspends when no new usage arrives", async () => {
    const { client: api, calls } = client(() => new Response("{}", { status: 200 }));
    const directory = new CustomerDirectory(new MemoryCustomerStore(), api);
    await directory.saveCustomer({ id: "cus", name: "Ada" });
    await directory.assignLine("cus", ICCID);
    const pkg = definePackage({ id: "day", name: "Day", dataCapGb: 1, validityDays: 1, price: 1, currency: "EUR", overage: "suspend" });
    await directory.store.putPackage(pkg);
    await directory.store.putAllocation(openAllocation("cus", pkg, { iccid: ICCID, startsAt: "2026-01-01T00:00:00.000Z", id: "a1" }));
    await syncReseller(directory, { period: PERIOD, retailCurrency: "EUR", now: new Date("2026-01-03T00:00:00.000Z") });
    const stored = (await directory.store.listAllocations({ customerId: "cus" })).find((item) => item.id === "a1");
    assert.equal(stored?.status, "expired");
    assert.deepEqual(calls, [`/api/v1/esims/${ICCID}/suspend`]);
  });

  it("does not suspend after a failed attempt once the customer renews", async () => {
    const { client: api, calls } = client(() => new Response("no", { status: 500 }));
    const directory = new CustomerDirectory(new MemoryCustomerStore(), api);
    await directory.saveCustomer({ id: "cus", name: "Ada" });
    await directory.assignLine("cus", ICCID);
    const pkg = definePackage({ id: "day", name: "Day", dataCapGb: 1, validityDays: 1, price: 1, currency: "EUR", overage: "suspend" });
    await directory.store.putPackage(pkg);
    await directory.store.putAllocation(openAllocation("cus", pkg, { iccid: ICCID, startsAt: "2026-01-01T00:00:00.000Z", id: "old" }));
    await syncReseller(directory, { period: PERIOD, retailCurrency: "EUR", now: new Date("2026-01-03T00:00:00.000Z") });
    assert.equal(calls.length, 1);
    assert.equal((await directory.store.listFailedActions()).length, 1);
    const renewal = definePackage({ id: "next", name: "Next", dataCapGb: 1, validityDays: 30, price: 1, currency: "EUR", overage: "suspend" });
    await directory.store.putPackage(renewal);
    await directory.store.putAllocation(openAllocation("cus", renewal, { iccid: ICCID, startsAt: "2026-01-03T00:00:00.000Z", id: "new" }));
    await syncReseller(directory, { period: PERIOD, retailCurrency: "EUR", now: new Date("2026-01-04T00:00:00.000Z") });
    assert.equal(calls.length, 1);
    assert.deepEqual(await directory.store.listFailedActions(), []);
  });

  it("retries a still-valid failure once and leaves another customer's action alone", async () => {
    const { client: api, calls } = client(() => new Response("{}", { status: 200 }));
    const directory = new CustomerDirectory(new MemoryCustomerStore(), api);
    await directory.saveCustomer({ id: "ada", name: "Ada" });
    await directory.saveCustomer({ id: "bea", name: "Bea" });
    await directory.assignLine("ada", ICCID);
    await directory.assignLine("bea", OTHER);
    const quiet = definePackage({ id: "quiet", name: "Quiet", dataCapGb: 1, validityDays: 30, price: 1, currency: "EUR", overage: "flag" });
    const due = definePackage({ id: "due", name: "Due", dataCapGb: 1, validityDays: 1, price: 1, currency: "EUR", overage: "suspend" });
    await directory.store.putPackage(quiet);
    await directory.store.putPackage(due);
    await directory.store.putAllocation(openAllocation("ada", quiet, { iccid: ICCID, startsAt: "2026-01-01T00:00:00.000Z", id: "ada-pack" }));
    await directory.store.putAllocation(openAllocation("bea", due, { iccid: OTHER, startsAt: "2026-01-01T00:00:00.000Z", id: "bea-pack" }));
    await directory.store.commitSync({
      failedActions: [{ id: `suspend_${OTHER}`, iccid: OTHER, customerId: "bea", kind: "suspend", error: "earlier", at: "2026-01-03T00:00:00.000Z" }],
    });
    await syncReseller(directory, { period: PERIOD, retailCurrency: "EUR", now: new Date("2026-01-03T00:00:00.000Z") });
    assert.deepEqual(calls, [`/api/v1/esims/${OTHER}/suspend`]);
    assert.deepEqual(await directory.store.listFailedActions(), []);
  });
});
