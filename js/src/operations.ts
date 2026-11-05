import type { OperationDescriptor } from "./types.js";

/**
 * The 48 operations in OpenAPI 2.6.1. Paths are relative to `/api/v1`.
 * `autoIdempotency` is set only where the document declares an Idempotency-Key parameter.
 */
export const API_OPERATIONS: readonly OperationDescriptor[] = [
  { id: "health", method: "GET", path: "/health", summary: "Public health check", autoIdempotency: false },
  { id: "partner", method: "GET", path: "/partner", summary: "Partner profile + scopes resolved by the key", autoIdempotency: false },
  { id: "quotas", method: "GET", path: "/quotas", summary: "Balance, lifetime quota, rate limit, issuance fee, subscription state", autoIdempotency: false },
  { id: "audit", method: "GET", path: "/audit", summary: "Partner-scoped audit log", autoIdempotency: false },
  { id: "listEsims", method: "GET", path: "/esims", summary: "List eSIMs in your fleet", autoIdempotency: false },
  { id: "issueEsim", method: "POST", path: "/esims", summary: "Issue a single eSIM (async)", autoIdempotency: true },
  { id: "listLines", method: "GET", path: "/lines", summary: "Legacy alias of GET /esims", autoIdempotency: false },
  { id: "getEsim", method: "GET", path: "/esims/{iccid}", summary: "Retrieve one eSIM", autoIdempotency: false },
  { id: "updateNickname", method: "PATCH", path: "/esims/{iccid}/nickname", summary: "Update nickname", autoIdempotency: false },
  { id: "updateTier", method: "PATCH", path: "/esims/{iccid}/tier", summary: "Change network tier", autoIdempotency: false },
  { id: "updateStatus", method: "PATCH", path: "/esims/{iccid}/status", summary: "Suspend / reactivate / terminate", autoIdempotency: false },
  { id: "suspendEsim", method: "POST", path: "/esims/{iccid}/suspend", summary: "Suspend alias", autoIdempotency: false },
  { id: "resumeEsim", method: "POST", path: "/esims/{iccid}/resume", summary: "Reactivate alias", autoIdempotency: false },
  { id: "getWallet", method: "GET", path: "/esims/{iccid}/wallet", summary: "Wallet snapshot", autoIdempotency: false },
  { id: "getEsimUsage", method: "GET", path: "/esims/{iccid}/usage", summary: "Per-line usage rows", autoIdempotency: false },
  { id: "getEsimEvents", method: "GET", path: "/esims/{iccid}/events", summary: "Per-line ledger events", autoIdempotency: false },
  { id: "bulkStatus", method: "POST", path: "/esims/bulk-status", summary: "Look up the status of many ICCIDs in one call", autoIdempotency: false },
  { id: "bulkTier", method: "POST", path: "/esims/bulk-tier", summary: "Change the network tier for many ICCIDs at once", autoIdempotency: false },
  { id: "bulkIssue", method: "POST", path: "/esims/bulk-issue", summary: "Async batch issuance", autoIdempotency: true },
  { id: "estimate", method: "POST", path: "/esims/estimate", summary: "Pre-flight cost estimate", autoIdempotency: false },
  { id: "listJobs", method: "GET", path: "/jobs", summary: "List your async jobs", autoIdempotency: false },
  { id: "getJob", method: "GET", path: "/jobs/{id}", summary: "Job detail with per-row results", autoIdempotency: false },
  { id: "getEsimRequest", method: "GET", path: "/esim-requests/{job_id}", summary: "Legacy alias for /jobs/{id}", autoIdempotency: false },
  { id: "getBalance", method: "GET", path: "/balance", summary: "Pool totals + per-eSIM wallet mirrors", autoIdempotency: false },
  { id: "listBalanceHistory", method: "GET", path: "/balance/history", summary: "Recent ledger entries", autoIdempotency: false },
  { id: "topup", method: "POST", path: "/topup", summary: "Credit pool from prepaid budget", autoIdempotency: true },
  { id: "listInvoices", method: "GET", path: "/invoices", summary: "WooCommerce orders for API-driven top-ups", autoIdempotency: false },
  { id: "usageSummary", method: "GET", path: "/usage/summary", summary: "Partner-wide aggregated usage", autoIdempotency: false },
  { id: "usageEsims", method: "GET", path: "/usage/esims", summary: "Per-eSIM aggregates (top-N + filter)", autoIdempotency: false },
  { id: "usageLines", method: "GET", path: "/usage/lines", summary: "Legacy alias of /usage/esims", autoIdempotency: false },
  { id: "usageCdrs", method: "GET", path: "/usage/cdrs", summary: "Itemised usage events (CDR-equivalent)", autoIdempotency: false },
  { id: "usageTimeseries", method: "GET", path: "/usage/timeseries", summary: "Daily usage + top-up totals (chart-ready)", autoIdempotency: false },
  { id: "listApiKeys", method: "GET", path: "/api-keys", summary: "List keys (no secrets)", autoIdempotency: false },
  { id: "createApiKey", method: "POST", path: "/api-keys", summary: "Create key (returns secret once)", autoIdempotency: false },
  { id: "revokeApiKey", method: "DELETE", path: "/api-keys/{key_public}", summary: "Revoke key", autoIdempotency: false },
  { id: "getWebhooks", method: "GET", path: "/webhooks", summary: "Read URL + subscriptions", autoIdempotency: false },
  { id: "updateWebhooks", method: "PUT", path: "/webhooks", summary: "Update URL + subscriptions", autoIdempotency: false },
  { id: "listWebhookEvents", method: "GET", path: "/webhooks/events", summary: "Catalog of every event we emit + subscription state", autoIdempotency: false },
  { id: "getWebhookSecret", method: "GET", path: "/webhooks/secret", summary: "Active HMAC secret + signed-payload spec", autoIdempotency: false },
  { id: "testWebhook", method: "POST", path: "/webhooks/test", summary: "Send test.ping to configured URL", autoIdempotency: false },
  { id: "listWebhookDeliveries", method: "GET", path: "/webhooks/deliveries", summary: "List webhook deliveries", autoIdempotency: false },
  { id: "getWebhookDelivery", method: "GET", path: "/webhooks/deliveries/{id}", summary: "Full delivery row (payload + response)", autoIdempotency: false },
  { id: "replayWebhookDelivery", method: "POST", path: "/webhooks/deliveries/{id}/replay", summary: "Replay a delivery to your endpoint", autoIdempotency: false },
  { id: "replayWebhookDeliveryLegacy", method: "POST", path: "/webhooks/{id}/replay", summary: "Replay a delivery (legacy alias)", autoIdempotency: false },
  { id: "listThresholds", method: "GET", path: "/thresholds", summary: "List rules", autoIdempotency: false },
  { id: "createThreshold", method: "POST", path: "/thresholds", summary: "Create rule", autoIdempotency: false },
  { id: "updateThreshold", method: "PATCH", path: "/thresholds/{id}", summary: "Update rule", autoIdempotency: false },
  { id: "deleteThreshold", method: "DELETE", path: "/thresholds/{id}", summary: "Delete rule", autoIdempotency: false },
] as const;

export function operationById(id: string): OperationDescriptor {
  const found = API_OPERATIONS.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown NXTL operation ${id}`);
  return found;
}
