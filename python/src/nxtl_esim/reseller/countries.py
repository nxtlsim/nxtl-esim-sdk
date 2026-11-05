"""English country names to ISO 3166-1 alpha-2. Network text is not an input."""

from __future__ import annotations

NAMES = {
    "albania": "AL",
    "austria": "AT",
    "belgium": "BE",
    "france": "FR",
    "germany": "DE",
    "greece": "GR",
    "ireland": "IE",
    "italy": "IT",
    "netherlands": "NL",
    "poland": "PL",
    "portugal": "PT",
    "spain": "ES",
    "sweden": "SE",
    "switzerland": "CH",
    "united kingdom": "GB",
    "united states": "US",
}


def country_name_to_iso2(name: str | None) -> str | None:
    if not name:
        return None
    trimmed = name.strip()
    if len(trimmed) == 2 and trimmed.isalpha():
        return trimmed.upper()
    return NAMES.get(trimmed.lower())
