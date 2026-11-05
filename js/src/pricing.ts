/**
 * Reseller markup applied locally. This does not call the NXTL API and
 * does not convert currencies.
 */

export type RoundingMode = "none" | "nearest" | "up" | "down" | "0.99" | "0.95" | "0.00";

export interface MarkupTier {
  /** Inclusive wholesale upper bound. Omit or null for the open-ended tier. */
  upTo?: number | null;
  /** Added percent. 25 means retail = wholesale * 1.25, before `fixed`. */
  percentage?: number;
  /** Currency units added after the percentage. */
  fixed?: number;
}

export interface MarkupConfig {
  /**
   * `percentage` uses `percentage` (and `fixed` when set).
   * `fixed` adds `fixed` and ignores `percentage`.
   * `tiered` selects the first bounded tier with wholesale <= upTo, else the open tier.
   * When omitted, a `tiers` array selects tiered mode; otherwise percentage and fixed are combined.
   */
  mode?: "percentage" | "fixed" | "tiered";
  percentage?: number;
  fixed?: number;
  tiers?: MarkupTier[];
  rounding?: RoundingMode;
  currency?: string;
  /**
   * ISO 3166-1 alpha-2 keys. Matching is case-insensitive.
   * Provided fields replace the base config. One level deep.
   */
  countryOverrides?: Record<string, MarkupConfig>;
}

export interface PriceQuote {
  wholesale: number;
  retail: number;
  markupAmount: number;
  currency?: string;
  country?: string;
  rounding: RoundingMode;
  formatted?: string;
  /** This helper never converts between currencies. */
  fxApplied: false;
}

export interface QuoteOptions {
  country?: string;
  /** Passed to `Intl.NumberFormat`. Default `en-US`. */
  locale?: string;
}

export function quotePrice(wholesale: number, config: MarkupConfig, options: QuoteOptions = {}): PriceQuote {
  if (typeof wholesale !== "number" || !Number.isFinite(wholesale) || wholesale < 0) {
    throw new TypeError("wholesale must be a finite number >= 0");
  }
  const resolved = resolveMarkup(config, options.country);
  const mode = resolved.mode ?? (resolved.tiers && resolved.tiers.length > 0 ? "tiered" : "percentage");
  let percentage = resolved.percentage;
  let fixed = resolved.fixed;
  if (mode === "tiered") {
    const tier = selectTier(wholesale, resolved.tiers ?? []);
    percentage = tier.percentage;
    fixed = tier.fixed;
  } else if (mode === "fixed") {
    percentage = 0;
    if (fixed === undefined) throw new TypeError("fixed markup requires fixed");
  } else if (mode === "percentage" && percentage === undefined && fixed === undefined) {
    throw new TypeError("percentage markup requires percentage or fixed");
  }
  assertComponent(percentage, "percentage");
  assertComponent(fixed, "fixed");
  const raw = wholesale * (1 + (percentage ?? 0) / 100) + (fixed ?? 0);
  if (!Number.isFinite(raw) || raw < 0) {
    throw new RangeError("markup produced a negative or non-finite retail price");
  }
  const rounding = resolved.rounding ?? "nearest";
  const retail = roundPrice(raw, rounding);
  const currency = resolved.currency;
  const quote: PriceQuote = {
    wholesale,
    retail,
    markupAmount: roundPrice(retail - wholesale, "nearest"),
    rounding,
    fxApplied: false,
  };
  if (currency !== undefined) quote.currency = currency;
  if (options.country !== undefined) quote.country = options.country.toUpperCase();
  if (currency) quote.formatted = formatCurrency(retail, currency, options.locale);
  return quote;
}

export function formatCurrency(amount: number, currency: string, locale = "en-US"): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new TypeError("amount must be a finite number");
  }
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function roundPrice(amount: number, mode: RoundingMode): number {
  if (!Number.isFinite(amount)) throw new TypeError("amount must be finite");
  switch (mode) {
    case "none":
      return amount;
    case "nearest":
      return roundHalfAway(amount, 2);
    case "up":
      return Math.ceil(amount * 100 - 1e-9) / 100;
    case "down":
      return Math.floor(amount * 100 + 1e-9) / 100;
    case "0.99":
      return charm(amount, 99);
    case "0.95":
      return charm(amount, 95);
    case "0.00":
      return charm(amount, 0);
    default:
      throw new TypeError(`Unknown rounding mode ${String(mode)}`);
  }
}

function resolveMarkup(config: MarkupConfig, country?: string): MarkupConfig {
  if (!country || !config.countryOverrides) return config;
  const key = Object.keys(config.countryOverrides).find((item) => item.toUpperCase() === country.toUpperCase());
  if (!key) return config;
  const override = config.countryOverrides[key];
  if (!override) return config;
  return {
    ...config,
    ...override,
    tiers: override.tiers ?? config.tiers,
    countryOverrides: undefined,
  };
}

function selectTier(wholesale: number, tiers: MarkupTier[]): MarkupTier {
  if (tiers.length === 0) throw new TypeError("tiered markup requires at least one tier");
  let open: MarkupTier | undefined;
  for (const tier of tiers) {
    if (tier.upTo == null) {
      open = tier;
      continue;
    }
    if (wholesale <= tier.upTo) return tier;
  }
  if (open) return open;
  const last = tiers[tiers.length - 1];
  if (!last) throw new TypeError("tiered markup requires at least one tier");
  return last;
}

function assertComponent(value: number | undefined, name: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

function roundHalfAway(amount: number, decimals: number): number {
  const factor = 10 ** decimals;
  const sign = amount < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(amount) * factor + 1e-9)) / factor;
}

/** Smallest amount >= input whose cents equal `endingCents`. */
function charm(amount: number, endingCents: number): number {
  const cents = Math.round(amount * 100);
  const mod = ((cents % 100) + 100) % 100;
  let delta = endingCents - mod;
  if (delta < 0) delta += 100;
  return (cents + delta) / 100;
}
