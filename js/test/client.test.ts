import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  API_OPERATIONS,
  NxtlAccessDeniedError,
  NxtlAuthError,
  NxtlClient,
  NxtlInsufficientBalanceError,
  NxtlNotFoundError,
  NxtlQuotaExceededError,
  NxtlRateLimitError,
  NxtlServerError,
  NxtlTimeoutError,
  NxtlValidationError,
} from "../src/index.js";
import { mockFetch } from "./helpers.js";

const KEY = "test-key";
const ICCID = "8900000000000000001";

describe("operations", () => {
  it("lists the 48 OpenAPI operations once", () => {
    assert.equal(API_OPERATIONS.length, 48);
    const ids = new Set(API_OPERATIONS.map((item) => item.id));
    assert.equal(ids.size, 48);
    const routes = new Set(API_OPERATIONS.map((item) => `${item.method} ${item.path}`));
    assert.equal(routes.size, 48);
  });
});

describe("client", () => {
  it("sends the API key, user agent and base URL", async () => {
    const { fetchImpl, calls } = mockFetch({ "GET /partner": { body: { name: "Acme" } } });
    const client = new NxtlClient({
      apiKey: KEY,
      fetch: fetchImpl,
      userAgent: "sdk-test",
      retry: false,
    });
    const response = await client.partner();
    assert.equal(response.data.name, "Acme");
    assert.equal(calls[0]?.method, "GET");
    assert.equal(calls[0]?.url, "https://nxtlsim.com/api/v1/partner");
    assert.equal(calls[0]?.headers["x-nxtl-key"], KEY);
    assert.equal(calls[0]?.headers["user-agent"], "sdk-test");
    assert.equal(calls[0]?.headers.accept, "application/json");
  });

  it("allows GET /health without a key", async () => {
    const { fetchImpl, calls } = mockFetch({ "GET /health": { body: { ok: true } } });
    const client = new NxtlClient({ fetch: fetchImpl, retry: false });
    const response = await client.health();
    assert.equal(response.status, 200);
    assert.equal(calls[0]?.headers["x-nxtl-key"], undefined);
  });

  it("refuses authenticated calls without a key", async () => {
    const client = new NxtlClient({ retry: false, fetch: async () => { throw new Error("should not send"); } });
    await assert.rejects(() => client.partner(), NxtlAuthError);
  });

  it("reuses one idempotency key across a 500 retry on POST /esims", async () => {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = mockFetch({
      "POST /esims": {
        sequence: [
          { status: 500, body: { error: true, type: "UPSTREAM_ERROR", code: "upstream_error", message: "again" } },
          { status: 202, body: { job_id: 9 } },
        ],
      },
    });
    const client = new NxtlClient({
      apiKey: KEY,
      fetch: fetchImpl,
      retry: { maxRetries: 2, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0 },
    });
    const response = await client.issueEsim(
      { nickname: "Traveller 123", tier: "cheapest", client_reference: "ORDER-123" },
      { idempotencyKey: "order-123-esim" },
    );
    assert.equal(response.data.job_id, 9);
    assert.equal(response.idempotencyKey, "order-123-esim");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.headers["idempotency-key"], "order-123-esim");
    assert.equal(calls[1]?.headers["idempotency-key"], "order-123-esim");
    assert.equal(sleeps.length, 1);
  });

  it("does not retry an unsafe POST on 500", async () => {
    const { fetchImpl, calls } = mockFetch({
      [`POST /esims/${ICCID}/suspend`]: { status: 502, body: { error: true, type: "UPSTREAM_ERROR", code: "upstream_error", message: "down" } },
    });
    const client = new NxtlClient({
      apiKey: KEY,
      fetch: fetchImpl,
      retry: { maxRetries: 3, sleep: async () => undefined },
    });
    await assert.rejects(() => client.suspendEsim(ICCID), NxtlServerError);
    assert.equal(calls.length, 1);
  });

  it("retries 429 and waits at least Retry-After", async () => {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = mockFetch({
      [`POST /esims/${ICCID}/suspend`]: {
        sequence: [
          { status: 429, body: { error: true, type: "RATE_LIMIT_EXCEEDED", code: "rate_limit_exceeded", message: "slow" }, headers: { "retry-after": "2" } },
          { status: 200, body: { ok: true } },
        ],
      },
    });
    const client = new NxtlClient({
      apiKey: KEY,
      fetch: fetchImpl,
      retry: { maxRetries: 2, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0 },
    });
    const response = await client.suspendEsim(ICCID);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.ok((sleeps[0] ?? 0) >= 2000);
  });

  it("maps status codes onto typed errors", async () => {
    const cases: Array<[number, unknown, new (...args: never[]) => Error]> = [
      [400, { error: true, type: "BAD_REQUEST", code: "bad_request", message: "no" }, NxtlValidationError],
      [401, { error: true, type: "UNAUTHORIZED", code: "unauthorized", message: "no" }, NxtlAuthError],
      [403, { error: true, type: "ACCESS_DENIED", code: "access_denied", message: "no" }, NxtlAccessDeniedError],
      [404, { error: true, type: "NOT_FOUND", code: "not_found", message: "no" }, NxtlNotFoundError],
      [402, { error: "insufficient_balance" }, NxtlInsufficientBalanceError],
      [409, { error: true, type: "QUOTA_EXCEEDED", code: "quota_exhausted", message: "full" }, NxtlQuotaExceededError],
      [429, { error: true, type: "RATE_LIMIT_EXCEEDED", code: "rate_limit_exceeded", message: "slow" }, NxtlRateLimitError],
    ];
    for (const [status, body, ctor] of cases) {
      const { fetchImpl } = mockFetch({ "GET /partner": { status, body } });
      const client = new NxtlClient({ apiKey: KEY, fetch: fetchImpl, retry: false });
      await assert.rejects(() => client.partner(), ctor);
    }
  });

  it("records the replay header and request id", async () => {
    const { fetchImpl } = mockFetch({
      "POST /topup": {
        status: 200,
        body: { ok: true },
        headers: { "idempotent-replayed": "true", "x-request-id": "req_1", "x-ratelimit-limit": "100", "x-ratelimit-remaining": "99" },
      },
    });
    const client = new NxtlClient({ apiKey: KEY, fetch: fetchImpl, retry: false });
    const response = await client.topup({ amount_usd: 25 }, { idempotencyKey: "topup-1" });
    assert.equal(response.idempotentReplayed, true);
    assert.equal(response.requestId, "req_1");
    assert.equal(response.rateLimit.limit, 100);
    assert.equal(response.rateLimit.remaining, 99);
  });

  it("times out a stalled fetch", async () => {
    const fetchImpl: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
    const client = new NxtlClient({ apiKey: KEY, fetch: fetchImpl, timeout: 20, retry: false });
    await assert.rejects(() => client.partner(), NxtlTimeoutError);
  });

  it("paginates fleet pages until a short page", async () => {
    let page = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      page = Number(url.searchParams.get("page"));
      const esims = page === 1
        ? [{ iccid: "8900000000000000001" }, { iccid: "8900000000000000002" }]
        : [{ iccid: "8900000000000000003" }];
      return new Response(JSON.stringify({ esims }), { status: 200 });
    };
    const client = new NxtlClient({ apiKey: KEY, fetch: fetchImpl, retry: false });
    const rows = [];
    for await (const row of client.iterateEsims({ per_page: 2 })) rows.push(row.iccid);
    assert.deepEqual(rows, ["8900000000000000001", "8900000000000000002", "8900000000000000003"]);
  });

  it("covers every operation method and path", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname.replace("/api/v1", "")}`);
      const status = (init?.method ?? "GET").toUpperCase() === "POST" && url.pathname.endsWith("/api-keys") ? 201 : 200;
      return new Response(JSON.stringify({ job_id: 1, id: 1, public_id: "pk", secret: "once", rules: [] }), {
        status: status === 201 ? 201 : 200,
      });
    };
    const client = new NxtlClient({ apiKey: KEY, fetch: fetchImpl, retry: false });
    const rule = { metric: "balance_below" as const, threshold_value: 5 };
    await client.health();
    await client.partner();
    await client.quotas();
    await client.audit({ page: 1, per_page: 10 });
    await client.listEsims({ status: "ready", page: 1 });
    await client.issueEsim({ tier: "cheapest" }, { idempotencyKey: "k" });
    await client.listLines();
    await client.getEsim(ICCID);
    await client.updateNickname(ICCID, { nickname: "A" });
    await client.updateTier(ICCID, { tier: "best_coverage" });
    await client.updateStatus(ICCID, { action: "suspend" });
    await client.suspendEsim(ICCID);
    await client.resumeEsim(ICCID);
    await client.getWallet(ICCID);
    await client.getEsimUsage(ICCID);
    await client.getEsimEvents(ICCID);
    await client.bulkStatus({ iccids: [ICCID] });
    await client.bulkTier({ iccids: [ICCID], tier: "cheapest" });
    await client.bulkIssue({ quantity: 1, tier: "standard" }, { idempotencyKey: "b" });
    await client.estimate({ quantity: 2 });
    await client.listJobs();
    await client.getJob(4);
    await client.getEsimRequest(4);
    await client.getBalance();
    await client.listBalanceHistory({ page: 1, per_page: 5 });
    await client.topup({ amount_usd: 1 }, { idempotencyKey: "t" });
    await client.listInvoices();
    await client.usageSummary({ days: 7 });
    await client.usageEsims({ limit: 10 });
    await client.usageLines();
    await client.usageCdrs({ page: 1, per_page: 20 });
    await client.usageTimeseries({ days: 30 });
    await client.listApiKeys();
    await client.createApiKey({ label: "ci" });
    await client.revokeApiKey("pk_123");
    await client.getWebhooks();
    await client.updateWebhooks({ webhook_url: "https://example.com/hook", events: ["test.ping"] });
    await client.listWebhookEvents();
    await client.getWebhookSecret();
    await client.testWebhook();
    await client.listWebhookDeliveries({ status: "failed", page: 1 });
    await client.getWebhookDelivery(3);
    await client.replayWebhookDelivery(3);
    await client.replayWebhookDeliveryLegacy(3);
    await client.listThresholds();
    await client.createThreshold(rule);
    await client.updateThreshold(8, rule);
    await client.deleteThreshold(8);

    assert.equal(calls.length, 48);
    const expected = [
      "GET /health",
      "GET /partner",
      "GET /quotas",
      "GET /audit",
      "GET /esims",
      "POST /esims",
      "GET /lines",
      `GET /esims/${ICCID}`,
      `PATCH /esims/${ICCID}/nickname`,
      `PATCH /esims/${ICCID}/tier`,
      `PATCH /esims/${ICCID}/status`,
      `POST /esims/${ICCID}/suspend`,
      `POST /esims/${ICCID}/resume`,
      `GET /esims/${ICCID}/wallet`,
      `GET /esims/${ICCID}/usage`,
      `GET /esims/${ICCID}/events`,
      "POST /esims/bulk-status",
      "POST /esims/bulk-tier",
      "POST /esims/bulk-issue",
      "POST /esims/estimate",
      "GET /jobs",
      "GET /jobs/4",
      "GET /esim-requests/4",
      "GET /balance",
      "GET /balance/history",
      "POST /topup",
      "GET /invoices",
      "GET /usage/summary",
      "GET /usage/esims",
      "GET /usage/lines",
      "GET /usage/cdrs",
      "GET /usage/timeseries",
      "GET /api-keys",
      "POST /api-keys",
      "DELETE /api-keys/pk_123",
      "GET /webhooks",
      "PUT /webhooks",
      "GET /webhooks/events",
      "GET /webhooks/secret",
      "POST /webhooks/test",
      "GET /webhooks/deliveries",
      "GET /webhooks/deliveries/3",
      "POST /webhooks/deliveries/3/replay",
      "POST /webhooks/3/replay",
      "GET /thresholds",
      "POST /thresholds",
      "PATCH /thresholds/8",
      "DELETE /thresholds/8",
    ];
    assert.deepEqual(calls, expected);
    const documented = API_OPERATIONS.map((item) => item.path.split("{")[0] ?? item.path);
    for (const call of calls) {
      const path = call.slice(call.indexOf(" ") + 1);
      const prefix = documented.find((item) => path === item || path.startsWith(item));
      assert.ok(prefix, path);
    }
  });
});
