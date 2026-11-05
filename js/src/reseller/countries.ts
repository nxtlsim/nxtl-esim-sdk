/**
 * Deterministic English country name to ISO 3166-1 alpha-2.
 * Operator and network text are never inputs.
 * Names not in this table stay unmapped.
 */
const NAMES: Record<string, string> = {
  albania: "AL",
  argentina: "AR",
  australia: "AU",
  austria: "AT",
  belgium: "BE",
  brazil: "BR",
  bulgaria: "BG",
  canada: "CA",
  china: "CN",
  croatia: "HR",
  cyprus: "CY",
  czechia: "CZ",
  "czech republic": "CZ",
  denmark: "DK",
  egypt: "EG",
  estonia: "EE",
  finland: "FI",
  france: "FR",
  germany: "DE",
  greece: "GR",
  "hong kong": "HK",
  hungary: "HU",
  iceland: "IS",
  india: "IN",
  indonesia: "ID",
  ireland: "IE",
  israel: "IL",
  italy: "IT",
  japan: "JP",
  latvia: "LV",
  lithuania: "LT",
  luxembourg: "LU",
  malaysia: "MY",
  malta: "MT",
  mexico: "MX",
  netherlands: "NL",
  "new zealand": "NZ",
  norway: "NO",
  poland: "PL",
  portugal: "PT",
  romania: "RO",
  singapore: "SG",
  slovakia: "SK",
  slovenia: "SI",
  "south africa": "ZA",
  "south korea": "KR",
  spain: "ES",
  sweden: "SE",
  switzerland: "CH",
  taiwan: "TW",
  thailand: "TH",
  turkey: "TR",
  "united arab emirates": "AE",
  "united kingdom": "GB",
  "united states": "US",
  "united states of america": "US",
};

export function countryNameToIso2(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const trimmed = name.trim();
  if (/^[a-z]{2}$/i.test(trimmed)) return trimmed.toUpperCase();
  return NAMES[trimmed.toLowerCase()];
}
