/**
 * Reseller-defined allowances on top of NXTL eSIM pay-as-you-go.
 * These records are not NXTL plans and are not returned by the API.
 */

import type { NxtlClient } from "../client.js";
import type { NormalizedUsageRow } from "./usage.js";
import type { PackageAllocation, SellablePackage } from "./store.js";
import { toBytes } from "./units.js";

export type ConsumptionMode = "fifo" | "priority";

export interface PackageDraft {
  id?: string;
  name: string;
  dataCapGb: number;
  validityDays: number;
  countries?: string[];
  price: number;
  currency: string;
  overage?: "flag" | "suspend";
  priority?: number;
  usdCap?: number;
}

export function definePackage(draft: PackageDraft, now = new Date()): SellablePackage {
  if (!draft.name) throw new TypeError("package name is required");
  if (!Number.isFinite(draft.dataCapGb) || draft.dataCapGb <= 0) throw new TypeError("dataCapGb must be > 0");
  if (!Number.isInteger(draft.validityDays) || draft.validityDays < 1) throw new TypeError("validityDays must be an integer >= 1");
  const pkg: SellablePackage = {
    id: draft.id ?? `pkg_${now.getTime().toString(36)}`,
    name: draft.name,
    dataCapBytes: toBytes(draft.dataCapGb, "GB"),
    validityDays: draft.validityDays,
    countries: (draft.countries ?? []).map((code) => code.toUpperCase()),
    price: draft.price,
    currency: draft.currency,
    overage: draft.overage ?? "flag",
    priority: draft.priority ?? 100,
  };
  if (draft.usdCap !== undefined) pkg.usdCap = draft.usdCap;
  return pkg;
}

export function openAllocation(
  customerId: string,
  pkg: SellablePackage,
  options: { iccid?: string; startsAt?: string; id?: string } = {},
): PackageAllocation {
  const starts = options.startsAt ? new Date(options.startsAt) : new Date();
  const expires = new Date(starts.getTime() + pkg.validityDays * 86_400_000);
  const allocation: PackageAllocation = {
    id: options.id ?? `alloc_${starts.getTime().toString(36)}_${pkg.id}`,
    customerId,
    packageId: pkg.id,
    startsAt: starts.toISOString(),
    expiresAt: expires.toISOString(),
    consumedBytes: 0,
    status: "active",
  };
  if (options.iccid) allocation.iccid = options.iccid;
  return allocation;
}

export interface ConsumptionResult {
  allocations: PackageAllocation[];
  consumedBytes: number;
  overageBytes: number;
  unmatchedBytes: number;
  /** Rows that had no byte field and could not be metered. */
  unmeteredRows: number;
}

/**
 * Split usage across a customer's packages.
 * `fifo` fills the earliest start date first.
 * `priority` fills the lowest `priority` number first, then the earliest start.
 * Country lists restrict which rows may draw a package. A row with no country
 * does not draw a country-restricted package.
 */
export function applyUsageToPackages(
  rows: readonly NormalizedUsageRow[],
  allocations: readonly PackageAllocation[],
  packages: readonly SellablePackage[],
  mode: ConsumptionMode = "fifo",
  now = new Date(),
): ConsumptionResult {
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const next = allocations.map((item) => ({ ...item }));
  const order = [...next].sort((a, b) => compareAllocations(a, b, byId, mode));
  let consumedBytes = 0;
  let overageBytes = 0;
  let unmatchedBytes = 0;
  let unmeteredRows = 0;
  for (const row of [...rows].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""))) {
    if (row.bytes === undefined) {
      unmeteredRows += 1;
      continue;
    }
    let remaining = row.bytes;
    for (const allocation of order) {
      if (remaining <= 0) break;
      const pkg = byId.get(allocation.packageId);
      if (!pkg || !allocationAccepts(allocation, pkg, row, now)) continue;
      refreshStatus(allocation, pkg, now);
      if (allocation.status === "expired") continue;
      const room = Math.max(0, effectiveCap(allocation, pkg) - allocation.consumedBytes);
      if (room <= 0) {
        allocation.status = "exhausted";
        continue;
      }
      const take = Math.min(room, remaining);
      allocation.consumedBytes += take;
      consumedBytes += take;
      remaining -= take;
      if (allocation.consumedBytes >= effectiveCap(allocation, pkg)) allocation.status = "exhausted";
    }
    if (remaining > 0) {
      const eligible = order.find((allocation) => {
        const pkg = byId.get(allocation.packageId);
        return pkg ? allocationMatches(allocation, pkg, row, now) : false;
      });
      if (eligible) {
        eligible.consumedBytes += remaining;
        eligible.status = "overage";
        overageBytes += remaining;
      } else {
        unmatchedBytes += remaining;
      }
    }
  }
  for (const allocation of next) {
    const pkg = byId.get(allocation.packageId);
    if (pkg) refreshStatus(allocation, pkg, now);
  }
  return { allocations: next, consumedBytes, overageBytes, unmatchedBytes, unmeteredRows };
}

export function remainingAllowance(allocation: PackageAllocation, pkg: SellablePackage, now = new Date()): {
  bytesRemaining: number;
  daysRemaining: number;
  expired: boolean;
} {
  const ms = new Date(allocation.expiresAt).getTime() - now.getTime();
  return {
    bytesRemaining: Math.max(0, effectiveCap(allocation, pkg) - allocation.consumedBytes),
    daysRemaining: Math.max(0, ms / 86_400_000),
    expired: ms <= 0,
  };
}

export function renewAllocation(
  current: PackageAllocation,
  pkg: SellablePackage,
  options: { extraDays?: number; extraBytes?: number; when?: string } = {},
): PackageAllocation {
  const start = options.when ? new Date(options.when) : new Date(current.expiresAt);
  const days = pkg.validityDays + (options.extraDays ?? 0);
  const expires = new Date(start.getTime() + days * 86_400_000);
  const allocation: PackageAllocation = {
    id: `alloc_${start.getTime().toString(36)}_${pkg.id}`,
    customerId: current.customerId,
    packageId: pkg.id,
    startsAt: start.toISOString(),
    expiresAt: expires.toISOString(),
    consumedBytes: 0,
    status: "active",
  };
  if (current.iccid) allocation.iccid = current.iccid;
  if (options.extraBytes && options.extraBytes > 0) allocation.bonusBytes = options.extraBytes;
  return allocation;
}

/** Add allowance or days on an existing allocation. This does not call POST /topup. */
export function topUpAllocation(
  allocation: PackageAllocation,
  options: { extraBytes?: number; extraDays?: number },
): PackageAllocation {
  const next: PackageAllocation = { ...allocation, status: "active" };
  if (options.extraBytes && options.extraBytes > 0) {
    next.bonusBytes = (allocation.bonusBytes ?? 0) + options.extraBytes;
  }
  if (options.extraDays && options.extraDays > 0) {
    const expires = new Date(allocation.expiresAt).getTime() + options.extraDays * 86_400_000;
    next.expiresAt = new Date(expires).toISOString();
  }
  return next;
}

function effectiveCap(allocation: PackageAllocation, pkg: SellablePackage): number {
  return pkg.dataCapBytes + (allocation.bonusBytes ?? 0);
}

/**
 * The published threshold metrics are `balance_below`, `line_usage_pct`, and
 * `line_usage_usd_today`. None of them is a multi-day byte cap.
 * When the package sets `usdCap`, this creates a daily USD rule. Otherwise it
 * does not call the API.
 * A GB allowance cannot be enforced as a NXTL threshold. USD rules do not see current EUR charges where amount_usd is 0. The stored period is ignored.
 */
export async function syncPackageThreshold(
  client: NxtlClient,
  pkg: SellablePackage,
): Promise<{ created: boolean; reason?: string }> {
  if (pkg.usdCap === undefined) {
    return {
      created: false,
      reason: "No usdCap on the package. Byte allowances stay in the reseller store. The API has no data-volume threshold metric.",
    };
  }
  await client.createThreshold({
    scope: "esim",
    metric: "line_usage_usd_today",
    operator: ">=",
    threshold_value: pkg.usdCap,
    period: "daily",
    action: pkg.overage === "suspend" ? "suspend" : "notify",
    enabled: true,
    notes: { cap_per_line_usd: pkg.usdCap },
  });
  return { created: true };
}

export async function renewLine(
  client: NxtlClient,
  allocation: PackageAllocation,
  pkg: SellablePackage,
  manualPause: boolean,
): Promise<{ allocation: PackageAllocation; resumed: boolean }> {
  const next = renewAllocation(allocation, pkg);
  let resumed = false;
  if (pkg.resumeOnRenewal && allocation.iccid && !manualPause) {
    await client.resumeEsim(allocation.iccid);
    resumed = true;
  }
  return { allocation: next, resumed };
}

/**
 * Suspend when the configured policy is `suspend` and the allocation is
 * exhausted, expired, or in overage. Exact exhaustion counts, not only
 * overage. Another active package with remaining bytes on the same ICCID
 * blocks the suspend. Manually paused lines are left untouched.
 */
export async function suspendOverageLines(
  client: NxtlClient,
  allocations: readonly PackageAllocation[],
  packages: readonly SellablePackage[],
  options: { manualPauseIccids?: ReadonlySet<string>; now?: Date } = {},
): Promise<Array<{ iccid: string; ok: boolean; error?: string }>> {
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const now = options.now ?? new Date();
  const results: Array<{ iccid: string; ok: boolean; error?: string }> = [];
  const seen = new Set<string>();
  for (const allocation of allocations) {
    const pkg = byId.get(allocation.packageId);
    if (!pkg || pkg.overage !== "suspend" || !allocation.iccid) continue;
    if (options.manualPauseIccids?.has(allocation.iccid)) continue;
    const due = allocation.status === "exhausted" || allocation.status === "expired" || allocation.status === "overage";
    if (!due) continue;
    if (hasAlternatePackage(allocation, allocations, byId, now)) continue;
    if (seen.has(allocation.iccid)) continue;
    seen.add(allocation.iccid);
    try {
      await client.suspendEsim(allocation.iccid);
      results.push({ iccid: allocation.iccid, ok: true });
    } catch (error) {
      results.push({ iccid: allocation.iccid, ok: false, error: error instanceof Error ? error.message : "suspend failed" });
    }
  }
  return results;
}

function hasAlternatePackage(
  current: PackageAllocation,
  allocations: readonly PackageAllocation[],
  packages: Map<string, SellablePackage>,
  now: Date,
): boolean {
  return allocations.some((other) => {
    if (other.id === current.id || other.iccid !== current.iccid) return false;
    const pkg = packages.get(other.packageId);
    if (!pkg) return false;
    if (new Date(other.expiresAt).getTime() <= now.getTime()) return false;
    return other.consumedBytes < pkg.dataCapBytes + (other.bonusBytes ?? 0) && other.status !== "expired";
  });
}

function allocationMatches(allocation: PackageAllocation, pkg: SellablePackage, row: NormalizedUsageRow, now: Date): boolean {
  const at = row.at ? new Date(row.at) : now;
  if (at < new Date(allocation.startsAt) || at >= new Date(allocation.expiresAt)) return false;
  if (allocation.iccid && row.iccid && allocation.iccid !== row.iccid) return false;
  return countryMatches(pkg, row);
}

function allocationAccepts(allocation: PackageAllocation, pkg: SellablePackage, row: NormalizedUsageRow, now: Date): boolean {
  if (allocation.status === "expired") return false;
  return allocationMatches(allocation, pkg, row, now);
}

function countryMatches(pkg: SellablePackage, row: NormalizedUsageRow): boolean {
  if (pkg.countries.length === 0) return true;
  const code = row.countryIso2 ?? (row.country && /^[A-Za-z]{2}$/.test(row.country) ? row.country.toUpperCase() : undefined);
  if (!code) return false;
  return pkg.countries.includes(code);
}

function refreshStatus(allocation: PackageAllocation, pkg: SellablePackage, now: Date): void {
  if (new Date(allocation.expiresAt).getTime() <= now.getTime()) {
    allocation.status = "expired";
    return;
  }
  if (allocation.status === "overage") return;
  if (allocation.consumedBytes >= effectiveCap(allocation, pkg)) allocation.status = "exhausted";
  else if (allocation.status !== "active") allocation.status = "active";
}

function compareAllocations(
  a: PackageAllocation,
  b: PackageAllocation,
  packages: Map<string, SellablePackage>,
  mode: ConsumptionMode,
): number {
  if (mode === "priority") {
    const pa = packages.get(a.packageId)?.priority ?? 100;
    const pb = packages.get(b.packageId)?.priority ?? 100;
    if (pa !== pb) return pa - pb;
  }
  return a.startsAt.localeCompare(b.startsAt);
}
