from datetime import datetime, timezone

import httpx

from nxtl_esim import AsyncNxtlClient, NxtlClient
from nxtl_esim.reseller import CustomerDirectory, MemoryCustomerStore, define_package, open_allocation, sync_reseller
from nxtl_esim.reseller.customers import AsyncCustomerDirectory
from nxtl_esim.reseller.monitoring import sync_reseller_async

ICCID = "8900000000000000001"
OTHER = "8900000000000000002"
PERIOD = {"kind": "range", "since": "2026-01-01T00:00:00Z", "until": "2026-02-01T00:00:00Z"}
NOW = datetime(2026, 1, 3, tzinfo=timezone.utc)


def _handler(calls: list[str], status: int):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/suspend"):
            calls.append(request.url.path)
            return httpx.Response(status, json={})
        if request.url.path.endswith("/usage/cdrs"):
            return httpx.Response(200, json={"cdrs": [], "total": 0, "page": 1, "pages": 0, "next_cursor": None})
        return httpx.Response(200, json={})

    return handler


def test_expiry_without_new_usage_suspends() -> None:
    calls: list[str] = []
    with httpx.Client(transport=httpx.MockTransport(_handler(calls, 200))) as http:
        directory = CustomerDirectory(MemoryCustomerStore(), NxtlClient("k", http_client=http, retry=False))
        directory.save_customer({"id": "cus", "name": "Ada"})
        directory.assign_line("cus", ICCID)
        package = define_package({"id": "day", "name": "Day", "data_cap_gb": 1, "validity_days": 1, "price": 1, "currency": "EUR", "overage": "suspend"})
        directory.store.put_package(package)
        directory.store.put_allocation(open_allocation("cus", package, iccid=ICCID, starts_at="2026-01-01T00:00:00Z", id="a1"))
        sync_reseller(directory, period=PERIOD, retail_currency="EUR", now=NOW)
        stored = next(item for item in directory.store.list_allocations(customer_id="cus") if item["id"] == "a1")
        assert stored["status"] == "expired"
        assert calls == [f"/api/v1/esims/{ICCID}/suspend"]


def test_renewal_clears_a_failed_suspension_without_retrying_it() -> None:
    calls: list[str] = []
    with httpx.Client(transport=httpx.MockTransport(_handler(calls, 500))) as http:
        directory = CustomerDirectory(MemoryCustomerStore(), NxtlClient("k", http_client=http, retry=False))
        directory.save_customer({"id": "cus", "name": "Ada"})
        directory.assign_line("cus", ICCID)
        package = define_package({"id": "day", "name": "Day", "data_cap_gb": 1, "validity_days": 1, "price": 1, "currency": "EUR", "overage": "suspend"})
        directory.store.put_package(package)
        directory.store.put_allocation(open_allocation("cus", package, iccid=ICCID, starts_at="2026-01-01T00:00:00Z", id="old"))
        sync_reseller(directory, period=PERIOD, retail_currency="EUR", now=NOW)
        assert len(calls) == 1
        assert len(directory.store.list_failed_actions()) == 1
        renewal = define_package({"id": "next", "name": "Next", "data_cap_gb": 1, "validity_days": 30, "price": 1, "currency": "EUR", "overage": "suspend"})
        directory.store.put_package(renewal)
        directory.store.put_allocation(open_allocation("cus", renewal, iccid=ICCID, starts_at="2026-01-03T00:00:00Z", id="new"))
        sync_reseller(directory, period=PERIOD, retail_currency="EUR", now=datetime(2026, 1, 4, tzinfo=timezone.utc))
        assert len(calls) == 1
        assert directory.store.list_failed_actions() == []


def test_other_customer_failure_is_not_retried_and_a_valid_one_is() -> None:
    calls: list[str] = []
    with httpx.Client(transport=httpx.MockTransport(_handler(calls, 200))) as http:
        directory = CustomerDirectory(MemoryCustomerStore(), NxtlClient("k", http_client=http, retry=False))
        directory.save_customer({"id": "ada", "name": "Ada"})
        directory.save_customer({"id": "bea", "name": "Bea"})
        directory.assign_line("ada", ICCID)
        directory.assign_line("bea", OTHER)
        quiet = define_package({"id": "quiet", "name": "Quiet", "data_cap_gb": 1, "validity_days": 30, "price": 1, "currency": "EUR", "overage": "flag"})
        due = define_package({"id": "due", "name": "Due", "data_cap_gb": 1, "validity_days": 1, "price": 1, "currency": "EUR", "overage": "suspend"})
        directory.store.put_package(quiet)
        directory.store.put_package(due)
        directory.store.put_allocation(open_allocation("ada", quiet, iccid=ICCID, starts_at="2026-01-01T00:00:00Z", id="ada-pack"))
        directory.store.put_allocation(open_allocation("bea", due, iccid=OTHER, starts_at="2026-01-01T00:00:00Z", id="bea-pack"))
        directory.store.commit_sync(failed_actions=[{"id": f"suspend_{OTHER}", "iccid": OTHER, "customer_id": "bea", "kind": "suspend", "error": "earlier", "at": "2026-01-03T00:00:00Z"}])
        sync_reseller(directory, period=PERIOD, retail_currency="EUR", now=NOW)
        assert calls == [f"/api/v1/esims/{OTHER}/suspend"]
        assert directory.store.list_failed_actions() == []


def test_async_sync_expires_without_usage() -> None:
    import asyncio

    calls: list[str] = []

    async def run() -> None:
        transport = httpx.MockTransport(_handler(calls, 200))
        async with httpx.AsyncClient(transport=transport) as http:
            directory = AsyncCustomerDirectory(MemoryCustomerStore(), AsyncNxtlClient("k", http_client=http, retry=False))
            directory.save_customer({"id": "cus", "name": "Ada"})
            directory.assign_line("cus", ICCID)
            package = define_package({"id": "day", "name": "Day", "data_cap_gb": 1, "validity_days": 1, "price": 1, "currency": "EUR", "overage": "suspend"})
            directory.store.put_package(package)
            directory.store.put_allocation(open_allocation("cus", package, iccid=ICCID, starts_at="2026-01-01T00:00:00Z", id="a1"))
            await sync_reseller_async(directory, period=PERIOD, retail_currency="EUR", now=NOW)
            stored = next(item for item in directory.store.list_allocations(customer_id="cus") if item["id"] == "a1")
            assert stored["status"] == "expired"
            assert calls == [f"/api/v1/esims/{ICCID}/suspend"]

    asyncio.run(run())
