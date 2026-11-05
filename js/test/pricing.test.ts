import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCurrency, quotePrice, roundPrice } from "../src/index.js";

describe("pricing", () => {
  it("applies a percentage and a fixed amount", () => {
    const quote = quotePrice(10, { mode: "percentage", percentage: 20, fixed: 1, currency: "EUR", rounding: "nearest" });
    assert.equal(quote.retail, 13);
    assert.equal(quote.markupAmount, 3);
    assert.equal(quote.fxApplied, false);
    assert.match(quote.formatted ?? "", /13/);
  });

  it("selects tiered markups and country overrides", () => {
    const config = {
      mode: "tiered" as const,
      rounding: "nearest" as const,
      currency: "EUR",
      tiers: [
        { upTo: 5, percentage: 40 },
        { upTo: 20, percentage: 25 },
        { upTo: null, percentage: 15 },
      ],
      countryOverrides: {
        jp: { percentage: 50, mode: "percentage" as const },
      },
    };
    assert.equal(quotePrice(4, config).retail, 5.6);
    assert.equal(quotePrice(10, config).retail, 12.5);
    assert.equal(quotePrice(30, config).retail, 34.5);
    assert.equal(quotePrice(10, config, { country: "JP" }).retail, 15);
  });

  it("rounds up to a .99 ending", () => {
    assert.equal(roundPrice(10, "0.99"), 10.99);
    assert.equal(roundPrice(10.99, "0.99"), 10.99);
    assert.equal(roundPrice(11, "0.99"), 11.99);
    assert.equal(roundPrice(10.01, "0.00"), 11);
    assert.equal(roundPrice(10, "0.00"), 10);
    const quote = quotePrice(10, { percentage: 0, rounding: "0.99", currency: "USD" });
    assert.equal(quote.retail, 10.99);
  });

  it("formats ISO currency codes and falls back when the code is invalid", () => {
    assert.match(formatCurrency(1.5, "EUR", "en-US"), /1\.50/);
    assert.equal(formatCurrency(1.5, "EURO"), "1.50 EURO");
  });

  it("rejects a negative wholesale price", () => {
    assert.throws(() => quotePrice(-1, { percentage: 10 }), TypeError);
  });
});
