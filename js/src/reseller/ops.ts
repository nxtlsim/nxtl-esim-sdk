/**
 * Catalog search, trip quotes, per-customer provisioning, line lifecycle, and audit.
 * Trip prices use the public per-GB feed. Issuance fees come from the API when
 * the caller passes one. POST /topup credits the partner pool, not a line.
 * There is no DELETE eSIM operation. Terminate is permanent.
 */

import type { CoverageFeed, DestinationsFeed, PricingFeed } from "../catalog.js";
import type { NxtlClient } from "../client.js";
import { jobIdOf } from "../client.js";
import { pollJob } from "../flows.js";
import { extractActivation } from "../flows.js";
import { quotePrice, type MarkupConfig } from "../pricing.js";
import type { CallOptions, ESimIssueRequest, JsonObject } from "../types.js";
import { convertFx, type FxTable } from "./fx.js";
import type { CustomerDirectory } from "./customers.js";
import { fromBytes } from "./units.js";

export interface CatalogQuery {
  pricing?: PricingFeed;
  destinations?: DestinationsFeed;
  coverage?: CoverageFeed;
  country?: string;
  /** Matches destination records whose type is `region`. Member ISO codes are not in the feed. */
  region?: string;
  maxEurPerGb?: number;
  text?: string;
}

export interface CatalogMatch {
  kind: "pricing" | "destination" | "coverage";
  id: string;
  name: string;
  eurPerGb?: number;
  detail: JsonObject;
}

export function searchCatalog(query: CatalogQuery): { matches: CatalogMatch[]; notes: string[] } {
  const notes: string[] = [];
  const matches: CatalogMatch[] = [];
  const text = query.text?.toLowerCase();
  if (query.region) {
    notes.push("TODO(spec): destination region records do not list member countries. Region search returns the region row only.");
  }
  for (const country of query.pricing?.countries ?? []) {
    if (query.country && country.iso2.toUpperCase() !== query.country.toUpperCase()) continue;
    if (query.maxEurPerGb !== undefined && country.cheapest_eur_per_gb > query.maxEurPerGb) continue;
    if (text && !`${country.iso2} ${country.name}`.toLowerCase().includes(text)) continue;
    matches.push({
      kind: "pricing",
      id: country.iso2,
      name: country.name,
      eurPerGb: country.cheapest_eur_per_gb,
      detail: { ...country },
    });
  }
  for (const destination of query.destinations?.destinations ?? []) {
    if (query.region && destination.type === "region") {
      const blob = `${destination.slug ?? ""} ${destination.title ?? ""} ${destination.iso2 ?? ""}`.toLowerCase();
      if (!blob.includes(query.region.toLowerCase())) continue;
    } else if (query.region) {
      continue;
    }
    if (query.country && destination.iso2?.toUpperCase() !== query.country.toUpperCase()) continue;
    if (text && !`${destination.title ?? ""} ${destination.slug ?? ""} ${destination.iso2 ?? ""}`.toLowerCase().includes(text)) continue;
    const row: CatalogMatch = {
      kind: "destination",
      id: destination.slug ?? destination.iso2 ?? destination.title ?? "destination",
      name: destination.title ?? destination.slug ?? "destination",
      detail: { ...destination },
    };
    if (destination.eur_per_gb !== undefined) row.eurPerGb = destination.eur_per_gb;
    matches.push(row);
  }
  for (const country of query.coverage?.coverage ?? []) {
    if (query.country && country.iso2.toUpperCase() !== query.country.toUpperCase()) continue;
    if (text && !`${country.iso2} ${country.name}`.toLowerCase().includes(text)) continue;
    if (!query.country && !text) continue;
    matches.push({
      kind: "coverage",
      id: country.iso2,
      name: country.name,
      detail: { networks: country.networks ?? [] },
    });
  }
  return { matches, notes };
}

export interface TripSegment {
  country: string;
  gb: number;
}

export interface TripQuote {
  segments: Array<TripSegment & { eurPerGb: number; wholesaleEur: number; retail: number }>;
  wholesaleEur: number;
  retail: number;
  currency: string;
  margin: number;
  /** Present when the caller supplied an issuance fee from estimate or quotas. */
  issuanceFee?: number;
  notes: string[];
}

/**
 * Estimate data cost for a trip from the public per-GB feed, then apply markup.
 * `split: "even"` divides `estimatedGb` across `countries`.
 * `split: "each"` applies the full `estimatedGb` to every country (an upper bound).
 */
export function quoteTrip(input: {
  pricing: PricingFeed;
  markup: MarkupConfig;
  countries?: string[];
  estimatedGb?: number;
  segments?: TripSegment[];
  split?: "even" | "each";
  fx?: FxTable;
  presentCurrency?: string;
  issuanceFee?: number;
  issuanceCurrency?: string;
}): TripQuote {
  const notes = [
    "This quote prices published per-GB rates. It is not POST /esims/estimate. Pass issuanceFee from that call or from GET /quotas if you want the profile fee included.",
  ];
  let segments: TripSegment[];
  if (input.segments && input.segments.length > 0) {
    segments = input.segments;
  } else if (input.countries && input.estimatedGb !== undefined) {
    const split = input.split ?? "even";
    const gb = split === "each" ? input.estimatedGb : input.estimatedGb / input.countries.length;
    segments = input.countries.map((country) => ({ country, gb }));
  } else {
    throw new TypeError("Provide segments or countries plus estimatedGb");
  }
  const currency = input.presentCurrency ?? input.markup.currency ?? "EUR";
  const priced = segments.map((segment) => {
    const row = input.pricing.countries.find((item) => item.iso2.toUpperCase() === segment.country.toUpperCase());
    if (!row) throw new Error(`No public pricing row for ${segment.country}`);
    const wholesaleEur = segment.gb * row.cheapest_eur_per_gb;
    const wholesale = currency.toUpperCase() === "EUR" || !input.fx
      ? wholesaleEur
      : convertFx(wholesaleEur, "EUR", currency, input.fx);
    if (currency.toUpperCase() !== "EUR" && !input.fx) {
      throw new TypeError("FX table required when the present currency is not EUR");
    }
    const retail = quotePrice(wholesale, { ...input.markup, currency }, { country: segment.country }).retail;
    return { ...segment, eurPerGb: row.cheapest_eur_per_gb, wholesaleEur, retail };
  });
  const wholesaleEur = priced.reduce((sum, segment) => sum + segment.wholesaleEur, 0);
  let retail = priced.reduce((sum, segment) => sum + segment.retail, 0);
  let issuanceFee: number | undefined;
  if (input.issuanceFee !== undefined) {
    const feeCurrency = input.issuanceCurrency ?? "USD";
    issuanceFee = feeCurrency.toUpperCase() === currency.toUpperCase() || !input.fx
      ? input.issuanceFee
      : convertFx(input.issuanceFee, feeCurrency, currency, input.fx);
    retail += quotePrice(issuanceFee, { percentage: 0, rounding: input.markup.rounding ?? "nearest", currency }).retail;
  }
  const wholesalePresent = currency.toUpperCase() === "EUR" || !input.fx
    ? wholesaleEur
    : convertFx(wholesaleEur, "EUR", currency, input.fx);
  return {
    segments: priced,
    wholesaleEur,
    retail,
    currency,
    margin: retail - wholesalePresent - (issuanceFee ?? 0),
    ...(issuanceFee !== undefined ? { issuanceFee } : {}),
    notes,
  };
}

export interface ProvisionRow {
  customerId: string;
  nickname?: string;
  tier?: ESimIssueRequest["tier"];
  idempotencyKey?: string;
  clientReference?: string;
}

export interface ProvisionResult {
  customerId: string;
  ok: boolean;
  jobId?: string;
  iccid?: string;
  error?: string;
}

/**
 * Issues one eSIM per customer with POST /esims.
 * Bulk issue is a single client_reference for the whole batch, so it is not
 * used when each row belongs to a different customer.
 */
export async function provisionCustomers(
  client: NxtlClient,
  directory: CustomerDirectory,
  rows: readonly ProvisionRow[],
  options: { wait?: boolean; pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<ProvisionResult[]> {
  const results: ProvisionResult[] = [];
  for (const row of rows) {
    try {
      const body: ESimIssueRequest = { client_reference: row.clientReference ?? row.customerId };
      if (row.nickname) body.nickname = row.nickname;
      if (row.tier) body.tier = row.tier;
      const call: CallOptions = {};
      if (row.idempotencyKey) call.idempotencyKey = row.idempotencyKey;
      const accepted = await client.issueEsim(body, call);
      const jobId = jobIdOf(accepted.data);
      let iccid: string | undefined;
      if (options.wait && jobId) {
        const job = await pollJob(client, jobId, {
          ...(options.pollIntervalMs ? { intervalMs: options.pollIntervalMs } : {}),
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        });
        iccid = extractActivation(job.data).iccid;
        if (iccid) await directory.assignLine(row.customerId, iccid);
      }
      const result: ProvisionResult = { customerId: row.customerId, ok: true };
      if (jobId) result.jobId = jobId;
      if (iccid) result.iccid = iccid;
      results.push(result);
    } catch (error) {
      results.push({
        customerId: row.customerId,
        ok: false,
        error: error instanceof Error ? error.message : "provision failed",
      });
    }
  }
  return results;
}

/** Line operations that exist on the API. There is no per-line top-up and no DELETE. */
export const lineLifecycle = {
  issue: (client: NxtlClient, body?: ESimIssueRequest, options?: CallOptions) => client.issueEsim(body, options),
  status: (client: NxtlClient, iccid: string) => client.getEsim(iccid),
  suspend: (client: NxtlClient, iccid: string) => client.suspendEsim(iccid),
  resume: (client: NxtlClient, iccid: string) => client.resumeEsim(iccid),
  terminate: (client: NxtlClient, iccid: string) => client.updateStatus(iccid, { action: "terminate" }),
  wallet: (client: NxtlClient, iccid: string) => client.getWallet(iccid),
  events: (client: NxtlClient, iccid: string) => client.getEsimEvents(iccid),
  /** Credits the partner pooled balance from prepaid budget. */
  poolTopup: (client: NxtlClient, amountUsd: number, idempotencyKey?: string) =>
    client.topup({ amount_usd: amountUsd }, idempotencyKey ? { idempotencyKey } : undefined),
};

export async function readAudit(
  client: NxtlClient,
  onEntry: (entry: JsonObject) => void | Promise<void>,
  filter: { action?: string; since?: string; until?: string } = {},
): Promise<number> {
  let count = 0;
  for await (const entry of client.iterateAudit(filter)) {
    await onEntry(entry);
    count += 1;
  }
  return count;
}

export function gb(bytes: number): number {
  return fromBytes(bytes).gb;
}
