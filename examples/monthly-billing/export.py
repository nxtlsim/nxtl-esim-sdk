"""Monthly billing export for a NXTL eSIM reseller.

The sample prices rows you already collected. Use ``load_usage_details`` for a
live ``GET /usage/cdrs`` read. The CSV is your customer invoice. ``GET /invoices``
lists orders for API pool top-ups.
"""

from nxtl_esim.reseller import (
    build_customer_invoice,
    build_usage_report,
    define_package,
    invoices_to_csv,
    normalize_usage_row,
)

rows = [
    normalize_usage_row({
        "iccid": "8900000000000000001",
        "at": "2026-04-04T12:00:00Z",
        "amount_eur": 3.2,
        "bytes": 800_000_000,
        "iso2": "FR",
    })
]
usage = build_usage_report(rows, {"kind": "monthly", "month": "2026-04"}, {
    "markup": {"percentage": 40, "rounding": "nearest", "currency": "EUR"},
    "retail_currency": "EUR",
})
invoice = build_customer_invoice(
    id="inv_2026_04_cus_1",
    customer_id="cus_1",
    currency="EUR",
    period_since=usage["since"],
    period_until=usage["until"],
    usage=usage,
    package_fees=[{
        "package": define_package({
            "name": "Europe 5GB 30 days",
            "data_cap_gb": 5,
            "validity_days": 30,
            "countries": ["FR", "DE", "ES", "IT"],
            "price": 29,
            "currency": "EUR",
        })
    }],
)
csv = invoices_to_csv([invoice])
print(csv, end="")
