import httpx

from nxtl_esim import NxtlAlreadyTerminatedError, NxtlClient, NxtlResumeBlockedError
from nxtl_esim.reseller import CustomerDirectory, MemoryCustomerStore, sync_reseller
from nxtl_esim.reseller.ledger import api_charge, parse_rollup_number, parse_utc_timestamp, webhook_charge
from nxtl_esim.reseller.usage import build_usage_report, load_usage_details, normalize_usage_row

ICCID = "8900000000000000001"


def test_eur_debit_and_placeholder_cdr_volume() -> None:
    charge = api_charge({"currency": "EUR", "amount_usd": 0, "amount_eur": -0.42})
    assert charge["consumption_charge"] == 0.42
    assert charge["kind"] == "debit"
    credit = api_charge({"currency": "EUR", "amount_usd": 0, "amount_eur": 0.42})
    assert credit["kind"] == "credit"
    assert credit["consumption_charge"] == 0
    cdr = normalize_usage_row({
        "id": 1001,
        "iccid": ICCID,
        "currency": "EUR",
        "amount_usd": 0,
        "amount_eur": -0.42,
        "created_at": "2026-07-31 12:00:05",
        "bytes": 0,
        "country": "",
    }, "cdr")
    assert cdr.get("bytes") is None
    assert cdr.get("country") is None
    assert parse_utc_timestamp("2026-07-31 12:00:05") == "2026-07-31T12:00:05.000Z"
    detail = normalize_usage_row({
        "entry_type": "usage",
        "currency": "EUR",
        "amount_usd": 0,
        "amount_eur": -0.42,
        "created_at": "2026-07-31 12:00:05",
        "bytes": 1048576,
        "country": "Germany",
    }, "line_usage")
    other = normalize_usage_row({
        "entry_type": "topup",
        "currency": "EUR",
        "amount_usd": 0,
        "amount_eur": 10,
        "created_at": "2026-07-31 12:00:06",
        "bytes": 999,
        "country": "Germany",
    }, "line_usage")
    report = build_usage_report([cdr, detail, other], {
        "kind": "range",
        "since": "2026-07-01T00:00:00Z",
        "until": "2026-08-01T00:00:00Z",
    }, {"markup": {"percentage": 0, "rounding": "nearest", "currency": "EUR"}, "retail_currency": "EUR"})
    assert report["totals"]["wholesale_eur"] == 0.42
    assert report["totals"]["bytes"] == 1048576
    assert report["by_country"][0]["key"] == "Germany"
    assert other["volume_trusted"] is False
    assert parse_rollup_number("0.4200") == 0.42
    assert webhook_charge({"currency": "EUR", "amount": 0.42})["consumption_charge"] == 0.42


def test_paging_dedup_and_lifecycle_requests() -> None:
    pages = {"usage": 0}
    bodies = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.content:
            bodies.append((request.method, path, request.content.decode()))
        else:
            bodies.append((request.method, path, None))
            if path.endswith("/usage/cdrs"):
                pages["usage"] += 1
                after = int(request.url.params.get("after_id") or "0")
                assert request.url.params.get("accounting") == "1"
                assert request.url.params.get("page") == "1"
                rows = [] if after >= 1001 else [{
                    "id": 1001,
                    "ledger_id": 1001,
                    "detail_available": True,
                    "iccid": ICCID,
                    "currency": "EUR",
                    "amount_usd": 0,
                    "amount_eur": -0.42,
                    "created_at": "2026-07-31 12:00:05",
                    "bytes": 1048576,
                    "country": "Germany",
                }]
                return httpx.Response(200, json={"cdrs": rows, "total": len(rows), "page": 1, "pages": 1, "next_cursor": None})
        if request.method == "PATCH":
            return httpx.Response(409, json={"error": "already_terminated"})
        return httpx.Response(200, json={})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        client = NxtlClient("k", http_client=http, retry=False)
        report = load_usage_details(client, iccid=ICCID, period={"kind": "monthly", "month": "2026-07"}, retail_currency="EUR", markup={"percentage": 0, "rounding": "nearest", "currency": "EUR"})
        assert pages["usage"] >= 1
        assert report["totals"]["wholesale_eur"] == 0.42
        assert report["totals"]["bytes"] == 1048576
        directory = CustomerDirectory(MemoryCustomerStore(), client)
        directory.save_customer({"id": "cus", "name": "Ada"})
        directory.assign_line("cus", ICCID)
        directory.credit("cus", 10, "EUR")
        sync_reseller(directory, period={"kind": "monthly", "month": "2026-07"}, retail_currency="EUR")
        sync_reseller(directory, period={"kind": "monthly", "month": "2026-07"}, retail_currency="EUR")
        assert directory.wallet_balance("cus", "EUR") == 9.58
        client.suspend_esim(ICCID)
        client.resume_esim(ICCID)
        try:
            client.update_status(ICCID, {"action": "terminate"})
            raise AssertionError("expected already_terminated")
        except NxtlAlreadyTerminatedError:
            pass
        suspend = next(item for item in bodies if item[1].endswith("/suspend"))
        resume = next(item for item in bodies if item[1].endswith("/resume"))
        terminate = next(item for item in bodies if item[1].endswith("/status"))
        assert suspend[0] == "POST" and suspend[2] is None
        assert resume[0] == "POST"
        assert terminate[0] == "PATCH" and terminate[2] == '{"action": "terminate"}'


def test_resume_blocked() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(402, json={"error": "resume_blocked"})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        client = NxtlClient("k", http_client=http, retry=False)
        try:
            client.resume_esim(ICCID)
            raise AssertionError("expected resume_blocked")
        except NxtlResumeBlockedError:
            pass
