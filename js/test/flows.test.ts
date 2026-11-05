import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NxtlClient,
  NxtlJobFailedError,
  PublicCatalog,
  assessBalance,
  extractActivation,
  fulfilEsimOrder,
  sumUsageAmounts,
} from "../src/index.js";

describe("flows", () => {
  it("polls a job and returns an LPA string from the payload", async () => {
    const lpa = "LPA:1$smdp.example$MATCH";
    let jobs = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.pathname.endsWith("/esims/estimate")) {
        return new Response(JSON.stringify({ affordable: true }), { status: 200 });
      }
      if (method === "POST" && url.pathname.endsWith("/esims")) {
        return new Response(JSON.stringify({ job_id: 7 }), { status: 202 });
      }
      if (method === "GET" && url.pathname.endsWith("/jobs/7")) {
        jobs += 1;
        const body = jobs === 1
          ? { status: "running", id: 7 }
          : { status: "completed", id: 7, results: [{ iccid: "8900000000000000001", activation_code: lpa }] };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response(JSON.stringify({ error: true, type: "NOT_FOUND", code: "not_found", message: url.pathname }), { status: 404 });
    };
    const client = new NxtlClient({ apiKey: "k", fetch: fetchImpl, retry: false });
    const result = await fulfilEsimOrder(client, {
      clientReference: "ORDER-123",
      nickname: "Traveller 123",
      tier: "cheapest",
      idempotencyKey: "order-123-esim",
      sleep: async () => undefined,
    });
    assert.equal(result.accepted.data.job_id, 7);
    assert.equal(result.activation.lpa, lpa);
    assert.equal(result.activation.iccid, "8900000000000000001");
    assert.equal(jobs, 2);
  });

  it("throws when the polled job fails", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.pathname.endsWith("/estimate")) {
        return new Response("{}", { status: 200 });
      }
      if (method === "POST") return new Response(JSON.stringify({ job_id: 3 }), { status: 202 });
      return new Response(JSON.stringify({ status: "failed", id: 3 }), { status: 200 });
    };
    const client = new NxtlClient({ apiKey: "k", fetch: fetchImpl, retry: false });
    await assert.rejects(
      () => fulfilEsimOrder(client, { clientReference: "ORDER-9", estimate: true, sleep: async () => undefined }),
      NxtlJobFailedError,
    );
  });

  it("reads a balance candidate and flags a low pool", async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      pool: { balance_usd: 4.5, currency: "USD" },
    }), { status: 200 });
    const client = new NxtlClient({ apiKey: "k", fetch: fetchImpl, retry: false });
    const assessment = await assessBalance(client, { lowUsd: 10, exhaustedUsd: 0 });
    assert.equal(assessment.amountUsd, 4.5);
    assert.equal(assessment.candidateKey, "balance_usd");
    assert.equal(assessment.status, "low");
  });

  it("does not treat a zero converted amount as free usage", () => {
    const totals = sumUsageAmounts([
      { amount_usd: 0, amount_eur: 1.25 },
      { amount_usd: 2, amount_eur: 0 },
    ]);
    assert.equal(totals.zeroIsNotFree, true);
    assert.equal(totals.amountUsd, 2);
    assert.equal(totals.amountEur, 1.25);
  });

  it("extracts a QR string only from a qr-named field", () => {
    const details = extractActivation({
      results: [{ qr_code: "https://cdn.example/qr.png", note: "not-a-code" }],
    });
    assert.equal(details.qr, "https://cdn.example/qr.png");
    assert.equal(details.lpa, undefined);
  });
});

describe("catalog", () => {
  it("reads the public pricing feed and quotes a country rate", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/ai/pricing.json")) {
        return new Response(JSON.stringify({
          currency: "EUR",
          unit: "per_gb",
          countries: [{ iso2: "FR", name: "France", currency: "EUR", cheapest_eur_per_gb: 2 }],
        }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };
    const catalog = new PublicCatalog({ fetch: fetchImpl, retry: false });
    const feed = await catalog.pricing();
    const quote = catalog.quoteCountryRate(feed, "fr", { percentage: 50, rounding: "0.99" });
    assert.equal(quote.name, "France");
    assert.equal(quote.wholesale, 2);
    assert.equal(quote.retail, 3.99);
    assert.equal(quote.currency, "EUR");
    assert.equal(quote.fxApplied, false);
  });
});
