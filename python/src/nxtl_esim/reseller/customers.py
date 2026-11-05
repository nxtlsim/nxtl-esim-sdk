"""Reseller customers mapped onto NXTL eSIM lines.

The prepaid wallet is the reseller's ledger. POST /topup credits the partner
pool and is not called here. Suspend and resume use the eSIM status operations.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

from .packages import apply_usage_to_packages
from .usage import build_usage_report, diff_snapshots, load_usage_details, load_usage_details_async, snapshot_usage


def new_customer(draft: Mapping[str, Any] | None = None) -> dict[str, Any]:
    draft = draft or {}
    stamp = _now()
    customer: dict[str, Any] = {
        "id": draft.get("id") or f"cus_{uuid.uuid4().hex[:8]}",
        "tags": list(draft.get("tags") or []),
        "metadata": dict(draft.get("metadata") or {}),
        "status": "active",
        "created_at": stamp,
        "updated_at": stamp,
    }
    for key in ("external_id", "name", "email", "notes"):
        if draft.get(key):
            customer[key] = draft[key]
    return customer


class CustomerDirectory:
    def __init__(self, store: Any, client: Any) -> None:
        self.store = store
        self.client = client

    def save_customer(self, draft: Mapping[str, Any]) -> dict[str, Any]:
        customer = new_customer(draft)
        self.store.put_customer(customer)
        return customer

    def assign_line(self, customer_id: str, iccid: str, label: str | None = None) -> dict[str, Any]:
        self._require(customer_id)
        existing = self.store.list_assignments(iccid=iccid, active_only=True)
        if any(item["customer_id"] != customer_id for item in existing):
            raise RuntimeError(f"ICCID {iccid} is already assigned to another customer")
        assignment: dict[str, Any] = {
            "id": f"line_{customer_id}_{iccid}",
            "customer_id": customer_id,
            "iccid": iccid,
            "assigned_at": _now(),
        }
        if label:
            assignment["label"] = label
        self.store.put_assignment(assignment)
        return assignment

    def unassign_line(self, customer_id: str, iccid: str) -> dict[str, Any]:
        rows = self.store.list_assignments(customer_id=customer_id, iccid=iccid, active_only=True)
        if not rows:
            raise RuntimeError(f"No active assignment for {iccid}")
        nxt = dict(rows[0])
        nxt["unassigned_at"] = _now()
        self.store.put_assignment(nxt)
        return nxt

    def list_customer_lines(self, customer_id: str, refresh: bool = False) -> list[dict[str, Any]]:
        lines = self.store.list_assignments(customer_id=customer_id, active_only=True)
        if not refresh:
            return lines
        detailed = []
        for line in lines:
            copied = dict(line)
            copied["esim"] = self.client.get_esim(line["iccid"]).data
            detailed.append(copied)
        return detailed

    def customer_usage(self, customer_id: str, period: Mapping[str, str], **options: Any) -> dict[str, Any]:
        lines = self.store.list_assignments(customer_id=customer_id, active_only=True)
        rows: list[Mapping[str, Any]] = []
        notes: list[str] = []
        volume_complete = bool(lines)
        for line in lines:
            report = load_usage_details(self.client, period=period, iccid=line["iccid"], **options)
            rows.extend(report["rows"])
            notes.extend(report["notes"])
            if not report.get("volume_complete", False):
                volume_complete = False
        combined = build_usage_report(rows, period, options)
        combined["volume_complete"] = volume_complete
        combined["notes"].extend(notes)
        return combined

    def credit(self, customer_id: str, amount: float, currency: str, memo: str | None = None) -> dict[str, Any]:
        return self._ledger(customer_id, "credit", amount, currency, memo)

    def debit(self, customer_id: str, amount: float, currency: str, memo: str | None = None, reference: str | None = None) -> dict[str, Any]:
        return self._ledger(customer_id, "debit", amount, currency, memo, reference)

    def wallet_balance(self, customer_id: str, currency: str) -> float:
        total = 0.0
        for entry in self.store.list_wallet_entries(customer_id):
            if str(entry["currency"]).upper() != currency.upper():
                continue
            total += -float(entry["amount"]) if entry["kind"] == "debit" else float(entry["amount"])
        return total

    def is_low_balance(self, customer_id: str, currency: str, threshold: float) -> bool:
        return self.wallet_balance(customer_id, currency) <= threshold

    def suspend_customer(self, customer_id: str) -> dict[str, Any]:
        return self._set_state(customer_id, "suspended", "suspend")

    def resume_customer(self, customer_id: str) -> dict[str, Any]:
        return self._set_state(customer_id, "active", "resume")

    def flag_customer(self, customer_id: str, notes: str | None = None) -> dict[str, Any]:
        customer = self._require(customer_id)
        customer["status"] = "flagged"
        customer["updated_at"] = _now()
        if notes:
            customer["notes"] = notes
        self.store.put_customer(customer)
        return customer

    def record_snapshot(self, customer_id: str, report: Mapping[str, Any]) -> dict[str, Any]:
        previous = self.store.list_snapshots(customer_id=customer_id)
        prior = previous[-1] if previous else None
        snapshot = snapshot_usage(report, {"customer_id": customer_id, "id": f"snap_{customer_id}_{report['until']}"})
        self.store.put_snapshot(snapshot)
        return {"snapshot": snapshot, "delta": diff_snapshots(prior, snapshot)}

    def apply_packages(self, customer_id: str, report: Mapping[str, Any], mode: str = "fifo") -> dict[str, Any]:
        result = apply_usage_to_packages(report["rows"], self.store.list_allocations(customer_id=customer_id), self.store.list_packages(), mode)
        for allocation in result["allocations"]:
            self.store.put_allocation(allocation)
        return result

    def _set_state(self, customer_id: str, status: str, action: str) -> dict[str, Any]:
        customer = self._require(customer_id)
        results = []
        for line in self.store.list_assignments(customer_id=customer_id, active_only=True):
            try:
                if action == "suspend":
                    self.client.suspend_esim(line["iccid"])
                else:
                    self.client.resume_esim(line["iccid"])
                updated = dict(line)
                updated["manual_pause"] = action == "suspend"
                self.store.put_assignment(updated)
                results.append({"iccid": line["iccid"], "ok": True})
            except Exception as exc:  # noqa: BLE001
                results.append({"iccid": line["iccid"], "ok": False, "error": str(exc)})
        customer["status"] = status
        customer["updated_at"] = _now()
        self.store.put_customer(customer)
        return {"customer": customer, "results": results}

    def _ledger(self, customer_id: str, kind: str, amount: float, currency: str, memo: str | None = None, reference: str | None = None) -> dict[str, Any]:
        self._require(customer_id)
        if amount < 0:
            raise TypeError("amount must be >= 0")
        entry: dict[str, Any] = {
            "id": f"wal_{uuid.uuid4().hex[:8]}",
            "customer_id": customer_id,
            "at": _now(),
            "kind": kind,
            "amount": float(amount),
            "currency": currency,
        }
        if memo:
            entry["memo"] = memo
        if reference:
            entry["reference"] = reference
        self.store.put_wallet_entry(entry)
        return entry

    def _require(self, customer_id: str) -> dict[str, Any]:
        customer = self.store.get_customer(customer_id)
        if customer is None:
            raise RuntimeError(f"Unknown customer {customer_id}")
        return customer


class AsyncCustomerDirectory(CustomerDirectory):
    """Same directory methods, awaiting ``AsyncNxtlClient``."""

    async def list_customer_lines(self, customer_id: str, refresh: bool = False) -> list[dict[str, Any]]:  # type: ignore[override]
        lines = self.store.list_assignments(customer_id=customer_id, active_only=True)
        if not refresh:
            return lines
        detailed = []
        for line in lines:
            copied = dict(line)
            copied["esim"] = (await self.client.get_esim(line["iccid"])).data
            detailed.append(copied)
        return detailed

    async def customer_usage(self, customer_id: str, period: Mapping[str, str], **options: Any) -> dict[str, Any]:  # type: ignore[override]
        lines = self.store.list_assignments(customer_id=customer_id, active_only=True)
        rows: list[Mapping[str, Any]] = []
        notes: list[str] = []
        volume_complete = bool(lines)
        for line in lines:
            report = await load_usage_details_async(self.client, period=period, iccid=line["iccid"], **options)
            rows.extend(report["rows"])
            notes.extend(report["notes"])
            if not report.get("volume_complete", False):
                volume_complete = False
        combined = build_usage_report(rows, period, options)
        combined["volume_complete"] = volume_complete
        combined["notes"].extend(notes)
        return combined

    async def suspend_customer(self, customer_id: str) -> dict[str, Any]:  # type: ignore[override]
        return await self._aset_state(customer_id, "suspended", "suspend")

    async def resume_customer(self, customer_id: str) -> dict[str, Any]:  # type: ignore[override]
        return await self._aset_state(customer_id, "active", "resume")

    async def _aset_state(self, customer_id: str, status: str, action: str) -> dict[str, Any]:
        customer = self._require(customer_id)
        results = []
        for line in self.store.list_assignments(customer_id=customer_id, active_only=True):
            try:
                if action == "suspend":
                    await self.client.suspend_esim(line["iccid"])
                else:
                    await self.client.resume_esim(line["iccid"])
                updated = dict(line)
                updated["manual_pause"] = action == "suspend"
                self.store.put_assignment(updated)
                results.append({"iccid": line["iccid"], "ok": True})
            except Exception as exc:  # noqa: BLE001
                results.append({"iccid": line["iccid"], "ok": False, "error": str(exc)})
        customer["status"] = status
        customer["updated_at"] = _now()
        self.store.put_customer(customer)
        return {"customer": customer, "results": results}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
