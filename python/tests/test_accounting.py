import sqlite3
import tempfile
from pathlib import Path

import httpx
import pytest

from nxtl_esim import AsyncNxtlClient, NxtlClient
from nxtl_esim.reseller import CustomerDirectory, MemoryCustomerStore, sync_reseller
from nxtl_esim.reseller.customers import AsyncCustomerDirectory
from nxtl_esim.reseller.money import posting_for_row
from nxtl_esim.reseller.monitoring import sync_reseller_async
from nxtl_esim.reseller.store import CUSTOMER_STORE_SQL, SqlCustomerStore
from nxtl_esim.reseller.sync import classify_usage_webhook
from nxtl_esim.reseller.usage import normalize_usage_row

ICCID = "8900000000000000001"


def test_markup_fx_and_distinct_ledger_ids() -> None:
    debit = normalize_usage_row({"id": 1, "currency": "EUR", "amount_usd": 0, "amount_eur": -0.42}, "cdr")
    marked = posting_for_row(debit, wallet_currency="EUR", markup={"percentage": 100, "rounding": "nearest", "currency": "EUR"})
    assert marked["acquisition"] == 0.42
    assert marked["selling"] == 0.84
    assert marked["margin"] == 0.42
    missing = posting_for_row(normalize_usage_row({"id": 2, "currency": "USD", "amount_usd": -1, "amount_eur": 0}, "cdr"), wallet_currency="EUR")
    assert missing["status"] == "unresolved"
    assert classify_usage_webhook({"id": "evt", "data": {"ledger_id": None}})["deferred"] is True
    germany = normalize_usage_row({"id": 3, "detail_available": True, "currency": "EUR", "amount_eur": -0.1, "amount_usd": 0, "bytes": 0, "country": "Germany"}, "cdr", {"iccid": ICCID})
    assert germany["country_iso2"] == "DE"
    assert germany["bytes"] == 0
    assert germany["volume_trusted"] is True


def test_sqlite_transaction_rollback_and_manual_pause() -> None:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "reseller.sqlite"
        connection = sqlite3.connect(path)
        connection.row_factory = sqlite3.Row
        connection.executescript(CUSTOMER_STORE_SQL)

        def query(sql: str, params: list | None = None):
            cursor = connection.execute(sql, params or [])
            if sql.strip().upper().startswith("SELECT"):
                return [dict(row) for row in cursor.fetchall()]
            connection.commit()
            return []

        def transaction(fn):
            connection.execute("BEGIN IMMEDIATE")
            try:
                result = fn(query_in_tx)
                connection.commit()
                return result
            except Exception:
                connection.rollback()
                raise

        def query_in_tx(sql: str, params: list | None = None):
            cursor = connection.execute(sql, params or [])
            if sql.strip().upper().startswith("SELECT"):
                return [dict(row) for row in cursor.fetchall()]
            return []

        store = SqlCustomerStore(query, transaction)
        store.put_assignment({"id": "line", "customer_id": "cus", "iccid": ICCID, "assigned_at": "2026-07-01T00:00:00Z", "manual_pause": True})
        assert store.list_assignments(iccid=ICCID)[0]["manual_pause"] is True
        store.commit_sync([{"id": "wal_1", "customer_id": "cus", "at": "2026-07-01T00:00:00Z", "kind": "debit", "amount": 1, "currency": "EUR"}], [{"stream": "financial", "key": "1"}])
        with pytest.raises(sqlite3.IntegrityError):
            store.commit_sync([{"id": "wal_1", "customer_id": "cus", "at": "2026-07-01T00:00:00Z", "kind": "debit", "amount": 9, "currency": "EUR"}], [{"stream": "financial", "key": "2"}])
        assert len(store.list_wallet_entries("cus")) == 1
        with pytest.raises(RuntimeError):
            transaction(lambda q: (_insert_then_crash(q)))
        assert len(store.list_wallet_entries("cus")) == 1
        connection.close()


def _insert_then_crash(query) -> None:
    query("INSERT INTO nxtl_reseller_wallet (id, customer_id, at, kind, amount, currency, memo, reference) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["wal_2", "cus", "2026-07-01T00:00:00Z", "debit", 3, "EUR", None, None])
    raise RuntimeError("crash")


def test_sync_and_async_post_the_same_selling_charge() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        after = int(request.url.params.get("after_id") or "0")
        rows = [] if after >= 8 else [
            {"id": 7, "ledger_id": 7, "detail_available": True, "currency": "EUR", "amount_usd": 0, "amount_eur": -0.42, "created_at": "2026-07-02 00:00:00", "bytes": 5, "country": "Germany"},
            {"id": 8, "ledger_id": 8, "detail_available": True, "currency": "EUR", "amount_usd": 0, "amount_eur": -0.42, "created_at": "2026-07-02 00:00:00", "bytes": 5, "country": "Germany"},
        ]
        return httpx.Response(200, json={"cdrs": rows, "total": len(rows), "page": 1, "pages": 4, "next_cursor": None})

    period = {"kind": "range", "since": "2026-07-01T00:00:00Z", "until": "2026-08-01T00:00:00Z"}
    markup = {"percentage": 100, "rounding": "nearest", "currency": "EUR"}
    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        client = NxtlClient("k", http_client=http, retry=False)
        directory = CustomerDirectory(MemoryCustomerStore(), client)
        directory.save_customer({"id": "cus", "name": "Ada"})
        directory.assign_line("cus", ICCID)
        directory.credit("cus", 10, "EUR")
        sync_reseller(directory, period=period, retail_currency="EUR", markup=markup)
        assert directory.wallet_balance("cus", "EUR") == 8.32

    async def run() -> float:
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http:
            client = AsyncNxtlClient("k", http_client=http, retry=False)
            directory = AsyncCustomerDirectory(MemoryCustomerStore(), client)
            directory.save_customer({"id": "cus", "name": "Ada"})
            directory.assign_line("cus", ICCID)
            directory.credit("cus", 10, "EUR")
            await sync_reseller_async(directory, period=period, retail_currency="EUR", markup=markup)
            return directory.wallet_balance("cus", "EUR")

    import asyncio
    assert asyncio.run(run()) == 8.32
