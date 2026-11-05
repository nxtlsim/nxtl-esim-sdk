import { quotePrice, type MarkupConfig, type PriceQuote } from "./pricing.js";
import type { Logger, RetryOptions } from "./types.js";
import { DEFAULT_ORIGIN, DEFAULT_USER_AGENT } from "./version.js";
import { NxtlConnectionError, NxtlError } from "./errors.js";
import { computeDelayMs, resolveRetry } from "./retry.js";

/**
 * Public JSON files under https://nxtlsim.com/ai/.
 * These are not operations of the B2B REST API. The API reference lists a
 * destination catalogue as outside the documented REST surface. Field names
 * below match the files as published; the B2B OpenAPI document does not
 * describe them.
 */

export interface PublicCatalogOptions {
  fetch?: typeof fetch;
  /** Default `https://nxtlsim.com`. */
  origin?: string;
  timeout?: number;
  userAgent?: string;
  logger?: Logger;
  retry?: RetryOptions | false;
}

export interface PricingCountry {
  iso2: string;
  name: string;
  currency?: string;
  cheapest_eur_per_gb: number;
  range_eur_per_gb?: { min?: number; max?: number };
}

export interface OnboardProduct {
  id?: string;
  iso2?: string | null;
  kind?: string;
  name?: string;
  operator?: string;
  currency?: string;
  eur_per_gb?: number;
  note?: string;
  search?: string[];
  url?: string;
}

export interface PricingFeed {
  countries: PricingCountry[];
  currency?: string;
  links?: { air_maritime?: string; live_pricing?: string; methodology?: string };
  onboard?: OnboardProduct[];
  unit?: string;
  updated?: string;
}

export interface CoverageNetwork {
  operator?: string;
  eur_per_gb?: number;
  lte?: boolean;
  nr5g?: boolean;
}

export interface CoverageCountry {
  iso2: string;
  name: string;
  networks?: CoverageNetwork[];
}

export interface CoverageFeed {
  country_count?: number;
  coverage: CoverageCountry[];
  links?: { air_maritime?: string; coverage_map?: string; pricing?: string };
  onboard?: OnboardProduct[];
  updated?: string;
}

export interface DestinationEntry {
  type?: string;
  iso2?: string;
  slug?: string;
  title?: string;
  h1?: string;
  url?: string;
  product_model?: string;
  balance_expires?: boolean;
  eur_per_gb?: number;
  operator?: string;
  primary_query?: string;
  secondary_queries?: string[];
  search_intent?: string;
  meta_description?: string;
  comparisons?: string[];
}

export interface DestinationsFeed {
  destinations: DestinationEntry[];
  hub?: string;
  updated?: string;
}

export interface ProductFeed {
  product?: {
    name?: string;
    title?: string;
    description?: string;
    model?: string;
    balance_expiry?: string;
    coverage_wording?: string;
    included_credit_usd?: number;
    starter_price_usd?: number;
    starter_currency?: string;
    currency_notes?: { starter?: string; usage_rates?: string };
  };
  links?: Record<string, string>;
  methodology?: string;
  updated?: string;
}

export interface CatalogSnapshot {
  pricing: PricingFeed;
  coverage: CoverageFeed;
  destinations: DestinationsFeed;
  product: ProductFeed;
}

export class PublicCatalog {
  private readonly fetchImpl: typeof fetch;
  private readonly origin: string;
  private readonly timeout: number;
  private readonly userAgent: string;
  private readonly logger?: Logger;
  private readonly retry: ReturnType<typeof resolveRetry>;

  constructor(options: PublicCatalogOptions = {}) {
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchImpl !== "function") {
      throw new Error("Global fetch is not available. Pass options.fetch.");
    }
    this.fetchImpl = fetchImpl;
    this.origin = (options.origin ?? DEFAULT_ORIGIN).replace(/\/+$/, "");
    this.timeout = options.timeout ?? 30_000;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.retry = resolveRetry(options.retry);
    if (options.logger) this.logger = options.logger;
  }

  pricing(): Promise<PricingFeed> {
    return this.getJson<PricingFeed>("/ai/pricing.json");
  }

  coverage(): Promise<CoverageFeed> {
    return this.getJson<CoverageFeed>("/ai/coverage.json");
  }

  destinations(): Promise<DestinationsFeed> {
    return this.getJson<DestinationsFeed>("/ai/destinations.json");
  }

  product(): Promise<ProductFeed> {
    return this.getJson<ProductFeed>("/ai/nxtl-product.json");
  }

  async loadAll(): Promise<CatalogSnapshot> {
    const [pricing, coverage, destinations, product] = await Promise.all([
      this.pricing(),
      this.coverage(),
      this.destinations(),
      this.product(),
    ]);
    return { pricing, coverage, destinations, product };
  }

  findPricingCountry(feed: PricingFeed, iso2: string): PricingCountry | undefined {
    const code = iso2.toUpperCase();
    return feed.countries.find((row) => row.iso2?.toUpperCase() === code);
  }

  findCoverage(feed: CoverageFeed, iso2: string): CoverageCountry | undefined {
    const code = iso2.toUpperCase();
    return feed.coverage.find((row) => row.iso2?.toUpperCase() === code);
  }

  findDestination(feed: DestinationsFeed, iso2OrSlug: string): DestinationEntry | undefined {
    const needle = iso2OrSlug.toLowerCase();
    return feed.destinations.find(
      (row) => row.iso2?.toLowerCase() === needle || row.slug?.toLowerCase() === needle,
    );
  }

  /**
   * Retail price for one published per-GB rate. The number stays in the
   * feed currency (EUR on the current pricing file). No FX is applied.
   * Issuance fees charged to the pooled balance come from POST /esims/estimate,
   * not from this file.
   */
  quoteCountryRate(feed: PricingFeed, iso2: string, markup: MarkupConfig, locale?: string): PriceQuote & { name: string } {
    const row = this.findPricingCountry(feed, iso2);
    if (!row) {
      throw new NxtlError(`No public pricing row for ${iso2.toUpperCase()}`, {
        status: 0,
        code: "catalog_miss",
      });
    }
    const quote = quotePrice(row.cheapest_eur_per_gb, {
      currency: markup.currency ?? row.currency ?? feed.currency ?? "EUR",
      ...markup,
    }, { country: row.iso2, ...(locale ? { locale } : {}) });
    return { ...quote, name: row.name };
  }

  private async getJson<T>(path: string): Promise<T> {
    const retry = this.retry;
    const maxAttempts = (retry?.maxRetries ?? 0) + 1;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        const response = await this.fetchImpl(this.origin + path, {
          method: "GET",
          headers: { Accept: "application/json", "User-Agent": this.userAgent },
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = new NxtlConnectionError(`Public feed ${path} returned ${response.status}`, {
            status: response.status,
            code: "catalog_http",
          });
          if (!retry || response.status < 500 || attempt + 1 >= maxAttempts) throw error;
          await retry.sleep(computeDelayMs(retry, attempt, undefined));
          lastError = error;
          continue;
        }
        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof NxtlError && error.status < 500) throw error;
        if (!retry || attempt + 1 >= maxAttempts) {
          if (error instanceof NxtlError) throw error;
          throw new NxtlConnectionError(error instanceof Error ? error.message : "Catalog request failed", {
            status: 0,
            code: "catalog_connection",
          });
        }
        await retry.sleep(computeDelayMs(retry, attempt, undefined));
        lastError = error instanceof Error ? error : new Error("Catalog request failed");
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new NxtlConnectionError("Catalog request failed", { status: 0 });
  }
}
