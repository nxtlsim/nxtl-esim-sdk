/**
 * Reseller-supplied foreign exchange. The NXTL eSIM API does not convert
 * currencies. `rates[CODE]` is how many units of `base` equal 1 unit of CODE.
 * The base currency itself is treated as rate 1.
 */

export interface FxTable {
  base: string;
  rates: Record<string, number>;
}

export function convertFx(amount: number, from: string, to: string, fx: FxTable): number {
  if (!Number.isFinite(amount)) throw new TypeError("amount must be finite");
  const fromRate = rateOf(fx, from);
  const toRate = rateOf(fx, to);
  return (amount * fromRate) / toRate;
}

export function rateOf(fx: FxTable, currency: string): number {
  const code = currency.toUpperCase();
  if (code === fx.base.toUpperCase()) return 1;
  const rate = fx.rates[code] ?? fx.rates[currency];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new TypeError(`Missing reseller FX rate for ${code} (base ${fx.base})`);
  }
  return rate;
}

export function formatMoneyWithFx(
  amount: number,
  currency: string,
  presentCurrency: string,
  fx: FxTable | undefined,
  locale = "en-US",
): { amount: number; currency: string; formatted: string } {
  const converted = !fx || currency.toUpperCase() === presentCurrency.toUpperCase()
    ? amount
    : convertFx(amount, currency, presentCurrency, fx);
  const code = fx && currency.toUpperCase() !== presentCurrency.toUpperCase() ? presentCurrency : currency;
  let formatted: string;
  try {
    formatted = new Intl.NumberFormat(locale, { style: "currency", currency: code }).format(converted);
  } catch {
    formatted = `${converted.toFixed(2)} ${code}`;
  }
  return { amount: converted, currency: code, formatted };
}
