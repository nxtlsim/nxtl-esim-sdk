import tempfile
from pathlib import Path

import httpx

from nxtl_esim import NxtlClient
from nxtl_esim.reseller import (
    CustomerDirectory,
    JsonFileCustomerStore,
    MemoryCustomerStore,
    SqlCustomerStore,
    WebhookRouter,
    apply_usage_to_packages,
    build_customer_invoice,
    build_usage_report,
    convert_fx,
    define_package,
    diff_snapshots,
    format_data,
    invoices_to_csv,
    margin_report,
    new_customer,
    normalize_usage_row,
    open_allocation,
    provision_customers,
    quote_trip,
    search_catalog,
    snapshot_usage,
    sync_reseller,
    to_bytes,
    top_up_allocation,
)

ICCID = "8900000000000000001"


def test_usage_packages_and_invoice() -> None:
    assert to_bytes(1, "GB") == 1_000_000_000
    assert format_data(1_500_000_000) == "1.50 GB"
    api_row = normalize_usage_row({
        "iccid": ICCID,
        "timestamp": "2026-04-02T00:00:00Z",
        "amount_usd": 0,
        "amount_eur": 1.5,
        "bytes": 500_000_000,
        "iso2": "fr",
    })
    assert api_row["country"] == "FR"
    feed_row = normalize_usage_row({"iccid": ICCID, "at": "2026-04-03T00:00:00Z", "iso2": "FR", "volume_mb": 500})
    report = build_usage_report([api_row, feed_row], {"kind": "monthly", "month": "2026-04"}, {
        "pricing": {"countries": [{"iso2": "FR", "name": "France", "cheapest_eur_per_gb": 2}]},
        "markup": {"percentage": 100, "rounding": "nearest", "currency": "EUR"},
        "retail_currency": "EUR",
    })
    assert report["country_breakdown_available"] is True
    assert report["totals"]["zero_is_not_free"] is True
    assert report["totals"]["retail"] > report["totals"]["wholesale_eur"]
    snap = snapshot_usage(report, {"customer_id": "cus_1"})
    assert len(diff_snapshots(None, snap)["added"]) == 2
    assert diff_snapshots(snap, snap)["retail"] == 0

    europe = define_package({
        "id": "eu",
        "name": "Europe 1GB 30 days",
        "data_cap_gb": 1,
        "validity_days": 30,
        "countries": ["FR", "DE"],
        "price": 20,
        "currency": "EUR",
        "priority": 1,
    })
    extra = define_package({
        "id": "extra",
        "name": "Extra 1GB",
        "data_cap_gb": 1,
        "validity_days": 30,
        "countries": ["FR"],
        "price": 10,
        "currency": "EUR",
        "priority": 2,
    })
    from datetime import datetime, timezone

    now = datetime(2026, 4, 10, tzinfo=timezone.utc)
    result = apply_usage_to_packages(
        [normalize_usage_row({"iccid": ICCID, "at": "2026-04-03T00:00:00Z", "iso2": "FR", "bytes": 1_500_000_000})],
        [
            open_allocation("cus", extra, iccid=ICCID, starts_at="2026-04-02T00:00:00Z", id="a2"),
            open_allocation("cus", europe, iccid=ICCID, starts_at="2026-04-01T00:00:00Z", id="a1"),
        ],
        [europe, extra],
        "fifo",
        now,
    )
    by_id = {item["id"]: item for item in result["allocations"]}
    assert by_id["a1"]["consumed_bytes"] == 1_000_000_000
    assert by_id["a1"]["status"] == "exhausted"
    assert by_id["a2"]["consumed_bytes"] == 500_000_000
    assert top_up_allocation(by_id["a2"], extra_bytes=1000)["bonus_bytes"] == 1000

    usage = build_usage_report([
        normalize_usage_row({"iccid": ICCID, "at": "2026-04-02T00:00:00Z", "amount_eur": 4, "bytes": 1_000_000_000, "iso2": "FR"}),
    ], {"kind": "range", "since": "2026-04-01T00:00:00Z", "until": "2026-05-01T00:00:00Z"}, {
        "markup": {"percentage": 50, "rounding": "nearest", "currency": "EUR"},
        "retail_currency": "EUR",
    })
    package = define_package({"name": "Europe 5GB 30 days", "data_cap_gb": 5, "validity_days": 30, "countries": ["FR"], "price": 25, "currency": "EUR"})
    invoice = build_customer_invoice(
        id="inv_1",
        customer_id="cus_1",
        currency="EUR",
        period_since=usage["since"],
        period_until=usage["until"],
        usage=usage,
        package_fees=[{"package": package}],
    )
    assert any(line["kind"] == "markup" for line in invoice["lines"])
    assert "package_fee" in invoices_to_csv([invoice])
    assert convert_fx(10, "EUR", "USD", {"base": "USD", "rates": {"EUR": 1.1}}) == 11
    assert margin_report([invoice], "EUR")["invoice_count"] == 1


def test_directory_sync_catalog_and_sql() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/usage/cdrs"):
            return httpx.Response(200, json={"cdrs": [{"iccid": ICCID, "amount_eur": 3, "bytes": 10, "at": "2026-04-02T00:00:00Z"}]})
        if path.endswith("/suspend"):
            return httpx.Response(200, json={"ok": True})
        if request.method == "POST" and path.endswith("/esims"):
            return httpx.Response(202, json={"job_id": 4})
        if path.endswith("/jobs/4"):
            return httpx.Response(200, json={"status": "completed", "results": [{"iccid": ICCID}]})
        return httpx.Response(200, json={"iccid": ICCID, "status": "ready"})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        client = NxtlClient("k", http_client=http, retry=False)
        directory = CustomerDirectory(MemoryCustomerStore(), client)
        directory.save_customer(new_customer({"id": "cus_9", "name": "Bea", "tags": ["vip"]}))
        directory.assign_line("cus_9", ICCID, "phone")
        assert directory.list_customer_lines("cus_9", refresh=True)[0]["esim"]["status"] == "ready"
        directory.credit("cus_9", 10, "EUR")
        alerts = []
        synced = sync_reseller(
            directory,
            period={"kind": "monthly", "month": "2026-04"},
            markup={"percentage": 0, "rounding": "nearest", "currency": "EUR"},
            retail_currency="EUR",
            low_balance={"currency": "EUR", "threshold": 20},
            on_alert=alerts.append,
        )
        assert synced["customers"] == 1
        assert any(item["type"] == "low_balance" for item in alerts)
        assert directory.wallet_balance("cus_9", "EUR") < 10
        suspended = directory.suspend_customer("cus_9")
        assert suspended["customer"]["status"] == "suspended"
        provisioned = provision_customers(
            client,
            directory,
            [{"customer_id": "cus_9", "idempotency_key": "row-1"}],
            wait=True,
            sleep=lambda _s: None,
            interval=0.01,
            timeout=5,
        )
        assert provisioned[0]["ok"] is True
        assert provisioned[0]["iccid"] == ICCID
        seen = []
        router = WebhookRouter(client)
        router.on("esim.provisioned", lambda event, _client: seen.append(event["event"]))
        router.dispatch({"id": "evt_1", "event": "esim.provisioned", "timestamp": 1, "data": {}})
        assert seen == ["esim.provisioned"]

    found = search_catalog(pricing={"countries": [
        {"iso2": "FR", "name": "France", "cheapest_eur_per_gb": 2},
        {"iso2": "DE", "name": "Germany", "cheapest_eur_per_gb": 4},
    ]}, country="FR", max_eur_per_gb=3)
    assert len(found["matches"]) == 1
    quote = quote_trip(
        pricing={"countries": [
            {"iso2": "FR", "name": "France", "cheapest_eur_per_gb": 2},
            {"iso2": "DE", "name": "Germany", "cheapest_eur_per_gb": 4},
        ]},
        countries=["FR", "DE"],
        estimated_gb=2,
        split="even",
        markup={"percentage": 0, "rounding": "nearest", "currency": "EUR"},
    )
    assert quote["wholesale_eur"] == 6

    with tempfile.TemporaryDirectory() as tmp:
        path = str(Path(tmp) / "store.json")
        store = JsonFileCustomerStore(path)
        store.put_customer(new_customer({"id": "cus_file", "name": "File"}))
        assert JsonFileCustomerStore(path).get_customer("cus_file")["name"] == "File"

    rows = []
    sql = []

    def query(statement, params=()):
        sql.append(statement)
        if statement.lstrip().startswith("INSERT INTO nxtl_reseller_customers"):
            rows.append({
                "id": params[0],
                "external_id": params[1],
                "name": params[2],
                "email": params[3],
                "tags_json": params[4],
                "notes": params[5],
                "metadata_json": params[6],
                "status": params[7],
                "created_at": params[8],
                "updated_at": params[9],
            })
        if statement.startswith("SELECT * FROM nxtl_reseller_customers WHERE"):
            return [row for row in rows if row["id"] == params[0]]
        return []

    sql_store = SqlCustomerStore(query)
    sql_store.put_customer(new_customer({"id": "cus_sql", "name": "Sql"}))
    assert sql_store.get_customer("cus_sql")["name"] == "Sql"
    assert "nxtl_reseller_customers" in sql[0]
