"""Reseller-side storage. These records are not NXTL eSIM API resources."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Callable, Protocol

CUSTOMER_STORE_SQL = """
CREATE TABLE nxtl_reseller_customers (
  id TEXT PRIMARY KEY,
  external_id TEXT,
  name TEXT,
  email TEXT,
  tags_json TEXT NOT NULL,
  notes TEXT,
  metadata_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE nxtl_reseller_lines (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  iccid TEXT NOT NULL,
  label TEXT,
  assigned_at TEXT NOT NULL,
  unassigned_at TEXT,
  manual_pause INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE nxtl_reseller_wallet (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  memo TEXT,
  reference TEXT
);
CREATE TABLE nxtl_reseller_packages (
  id TEXT PRIMARY KEY,
  document_json TEXT NOT NULL
);
CREATE TABLE nxtl_reseller_allocations (
  id TEXT PRIMARY KEY,
  document_json TEXT NOT NULL
);
CREATE TABLE nxtl_reseller_snapshots (
  id TEXT PRIMARY KEY,
  customer_id TEXT,
  iccid TEXT,
  document_json TEXT NOT NULL
);
CREATE TABLE nxtl_reseller_invoices (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  document_json TEXT NOT NULL
);
CREATE TABLE nxtl_reseller_applied (
  stream TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  PRIMARY KEY (stream, dedup_key)
);
CREATE TABLE nxtl_reseller_checkpoints (
  scope TEXT PRIMARY KEY,
  after_id INTEGER NOT NULL
);
CREATE TABLE nxtl_reseller_pending (
  scope TEXT NOT NULL,
  ledger_id INTEGER NOT NULL,
  iccid TEXT NOT NULL,
  created_at TEXT,
  PRIMARY KEY (scope, ledger_id)
);
CREATE TABLE nxtl_reseller_failed_actions (
  id TEXT PRIMARY KEY,
  iccid TEXT NOT NULL,
  kind TEXT NOT NULL,
  error TEXT NOT NULL,
  at TEXT NOT NULL
);
""".strip()

CUSTOMER_STORE_MIGRATIONS = [
    "ALTER TABLE nxtl_reseller_lines ADD COLUMN manual_pause INTEGER NOT NULL DEFAULT 0",
]


class CustomerStore(Protocol):
    def put_customer(self, customer: Mapping[str, Any]) -> None: ...
    def get_customer(self, customer_id: str) -> dict[str, Any] | None: ...
    def list_customers(self, **filters: Any) -> list[dict[str, Any]]: ...
    def put_assignment(self, assignment: Mapping[str, Any]) -> None: ...
    def list_assignments(self, **filters: Any) -> list[dict[str, Any]]: ...
    def put_wallet_entry(self, entry: Mapping[str, Any]) -> None: ...
    def list_wallet_entries(self, customer_id: str) -> list[dict[str, Any]]: ...
    def put_package(self, package: Mapping[str, Any]) -> None: ...
    def get_package(self, package_id: str) -> dict[str, Any] | None: ...
    def list_packages(self) -> list[dict[str, Any]]: ...
    def put_allocation(self, allocation: Mapping[str, Any]) -> None: ...
    def list_allocations(self, **filters: Any) -> list[dict[str, Any]]: ...
    def put_snapshot(self, snapshot: Mapping[str, Any]) -> None: ...
    def list_snapshots(self, **filters: Any) -> list[dict[str, Any]]: ...
    def put_invoice(self, invoice: Mapping[str, Any]) -> None: ...
    def list_invoices(self, **filters: Any) -> list[dict[str, Any]]: ...


class MemoryCustomerStore:
    def __init__(self) -> None:
        self.customers: list[dict[str, Any]] = []
        self.assignments: list[dict[str, Any]] = []
        self.wallet: list[dict[str, Any]] = []
        self.packages: list[dict[str, Any]] = []
        self.allocations: list[dict[str, Any]] = []
        self.snapshots: list[dict[str, Any]] = []
        self.invoices: list[dict[str, Any]] = []
        self.applied: list[dict[str, str]] = []
        self.checkpoints: list[dict[str, Any]] = []
        self.pending: list[dict[str, Any]] = []
        self.failed_actions: list[dict[str, Any]] = []

    def put_customer(self, customer: Mapping[str, Any]) -> None:
        _upsert(self.customers, dict(customer))

    def get_customer(self, customer_id: str) -> dict[str, Any] | None:
        return next((item for item in self.customers if item["id"] == customer_id), None)

    def list_customers(self, **filters: Any) -> list[dict[str, Any]]:
        return [item for item in self.customers if _customer_ok(item, filters)]

    def put_assignment(self, assignment: Mapping[str, Any]) -> None:
        _upsert(self.assignments, dict(assignment))

    def list_assignments(self, **filters: Any) -> list[dict[str, Any]]:
        rows = self.assignments
        if filters.get("customer_id"):
            rows = [item for item in rows if item["customer_id"] == filters["customer_id"]]
        if filters.get("iccid"):
            rows = [item for item in rows if item["iccid"] == filters["iccid"]]
        if filters.get("active_only"):
            rows = [item for item in rows if not item.get("unassigned_at")]
        return list(rows)

    def put_wallet_entry(self, entry: Mapping[str, Any]) -> None:
        _upsert(self.wallet, dict(entry))

    def list_wallet_entries(self, customer_id: str) -> list[dict[str, Any]]:
        if not customer_id:
            return list(self.wallet)
        return [item for item in self.wallet if item["customer_id"] == customer_id]

    def put_package(self, package: Mapping[str, Any]) -> None:
        _upsert(self.packages, dict(package))

    def get_package(self, package_id: str) -> dict[str, Any] | None:
        return next((item for item in self.packages if item["id"] == package_id), None)

    def list_packages(self) -> list[dict[str, Any]]:
        return list(self.packages)

    def put_allocation(self, allocation: Mapping[str, Any]) -> None:
        _upsert(self.allocations, dict(allocation))

    def list_allocations(self, **filters: Any) -> list[dict[str, Any]]:
        rows = self.allocations
        if filters.get("customer_id"):
            rows = [item for item in rows if item["customer_id"] == filters["customer_id"]]
        if filters.get("package_id"):
            rows = [item for item in rows if item["package_id"] == filters["package_id"]]
        if filters.get("status"):
            rows = [item for item in rows if item["status"] == filters["status"]]
        return list(rows)

    def put_snapshot(self, snapshot: Mapping[str, Any]) -> None:
        _upsert(self.snapshots, dict(snapshot))

    def list_snapshots(self, **filters: Any) -> list[dict[str, Any]]:
        rows = self.snapshots
        if filters.get("customer_id"):
            rows = [item for item in rows if item.get("customer_id") == filters["customer_id"]]
        if filters.get("iccid"):
            rows = [item for item in rows if item.get("iccid") == filters["iccid"]]
        return list(rows)

    def put_invoice(self, invoice: Mapping[str, Any]) -> None:
        _upsert(self.invoices, dict(invoice))

    def list_invoices(self, **filters: Any) -> list[dict[str, Any]]:
        if filters.get("customer_id"):
            return [item for item in self.invoices if item["customer_id"] == filters["customer_id"]]
        return list(self.invoices)

    def has_applied(self, stream: str, key: str) -> bool:
        return any(item["stream"] == stream and item["key"] == key for item in self.applied)

    def get_checkpoint(self, scope: str) -> int:
        for item in self.checkpoints:
            if item["scope"] == scope:
                return int(item["after_id"])
        return 0

    def list_pending(self, scope: str) -> list[dict[str, Any]]:
        return [dict(item) for item in self.pending if item["scope"] == scope]

    def list_failed_actions(self) -> list[dict[str, Any]]:
        return [dict(item) for item in self.failed_actions]

    def commit_sync(self, wallet: list[dict[str, Any]] | None = None, applied: list[dict[str, str]] | None = None, **extra: Any) -> None:
        draft = {
            "wallet": [dict(item) for item in self.wallet],
            "applied": [dict(item) for item in self.applied],
            "allocations": [dict(item) for item in self.allocations],
            "checkpoints": [dict(item) for item in self.checkpoints],
            "pending": [dict(item) for item in self.pending],
            "failed_actions": [dict(item) for item in self.failed_actions],
        }
        _apply_commit(draft, wallet, applied, extra)
        self.wallet = draft["wallet"]
        self.applied = draft["applied"]
        self.allocations = draft["allocations"]
        self.checkpoints = draft["checkpoints"]
        self.pending = draft["pending"]
        self.failed_actions = draft["failed_actions"]


class JsonFileCustomerStore(MemoryCustomerStore):
    """Example adapter. One JSON document. Not safe across processes."""

    def __init__(self, path: str) -> None:
        super().__init__()
        self.path = Path(path)
        self._loaded = False

    def _load(self) -> None:
        if self._loaded:
            return
        if self.path.exists():
            data = json.loads(self.path.read_text(encoding="utf-8"))
            for item in data.get("customers", []):
                super().put_customer(item)
            for item in data.get("assignments", []):
                super().put_assignment(item)
            for item in data.get("wallet", []):
                super().put_wallet_entry(item)
            for item in data.get("packages", []):
                super().put_package(item)
            for item in data.get("allocations", []):
                super().put_allocation(item)
            for item in data.get("snapshots", []):
                super().put_snapshot(item)
            for item in data.get("invoices", []):
                super().put_invoice(item)
            super().commit_sync(
                applied=data.get("applied", []),
                checkpoints=data.get("checkpoints", []),
                pending=data.get("pending", []),
                failed_actions=data.get("failed_actions", []),
            )
        self._loaded = True

    def _persist(self) -> None:
        payload = {
            "customers": self.list_customers(),
            "assignments": self.list_assignments(),
            "wallet": self.list_wallet_entries(""),
            "packages": self.list_packages(),
            "allocations": self.list_allocations(),
            "snapshots": self.list_snapshots(),
            "invoices": self.list_invoices(),
            "applied": list(self.applied),
            "checkpoints": list(self.checkpoints),
            "pending": list(self.pending),
            "failed_actions": list(self.failed_actions),
        }
        self.path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def put_customer(self, customer: Mapping[str, Any]) -> None:
        self._load()
        super().put_customer(customer)
        self._persist()

    def get_customer(self, customer_id: str) -> dict[str, Any] | None:
        self._load()
        return super().get_customer(customer_id)

    def list_customers(self, **filters: Any) -> list[dict[str, Any]]:
        self._load()
        return super().list_customers(**filters)

    def put_assignment(self, assignment: Mapping[str, Any]) -> None:
        self._load()
        super().put_assignment(assignment)
        self._persist()

    def put_wallet_entry(self, entry: Mapping[str, Any]) -> None:
        self._load()
        super().put_wallet_entry(entry)
        self._persist()

    def put_package(self, package: Mapping[str, Any]) -> None:
        self._load()
        super().put_package(package)
        self._persist()

    def put_allocation(self, allocation: Mapping[str, Any]) -> None:
        self._load()
        super().put_allocation(allocation)
        self._persist()

    def put_snapshot(self, snapshot: Mapping[str, Any]) -> None:
        self._load()
        super().put_snapshot(snapshot)
        self._persist()

    def put_invoice(self, invoice: Mapping[str, Any]) -> None:
        self._load()
        super().put_invoice(invoice)
        self._persist()

    def list_assignments(self, **filters: Any) -> list[dict[str, Any]]:
        self._load()
        return super().list_assignments(**filters)

    def list_wallet_entries(self, customer_id: str) -> list[dict[str, Any]]:
        self._load()
        return super().list_wallet_entries(customer_id)

    def list_packages(self) -> list[dict[str, Any]]:
        self._load()
        return super().list_packages()

    def get_package(self, package_id: str) -> dict[str, Any] | None:
        self._load()
        return super().get_package(package_id)

    def list_allocations(self, **filters: Any) -> list[dict[str, Any]]:
        self._load()
        return super().list_allocations(**filters)

    def list_snapshots(self, **filters: Any) -> list[dict[str, Any]]:
        self._load()
        return super().list_snapshots(**filters)

    def list_invoices(self, **filters: Any) -> list[dict[str, Any]]:
        self._load()
        return super().list_invoices(**filters)

    def has_applied(self, stream: str, key: str) -> bool:
        self._load()
        return super().has_applied(stream, key)

    def commit_sync(self, wallet: list[dict[str, Any]] | None = None, applied: list[dict[str, str]] | None = None, **extra: Any) -> None:
        self._load()
        draft_wallet = [dict(item) for item in self.wallet]
        draft_applied = [dict(item) for item in self.applied]
        draft_allocations = [dict(item) for item in self.allocations]
        draft = {
            "wallet": draft_wallet,
            "applied": draft_applied,
            "allocations": draft_allocations,
            "checkpoints": [dict(item) for item in self.checkpoints],
            "pending": [dict(item) for item in self.pending],
            "failed_actions": [dict(item) for item in self.failed_actions],
        }
        _apply_commit(draft, wallet, applied, extra)
        payload = dict(self._dump_state())
        payload = {
            "customers": self.list_customers(),
            "assignments": self.list_assignments(),
            "packages": self.list_packages(),
            "snapshots": self.list_snapshots(),
            "invoices": self.list_invoices(),
            "wallet": draft["wallet"],
            "applied": draft["applied"],
            "allocations": draft["allocations"],
            "checkpoints": draft["checkpoints"],
            "pending": draft["pending"],
            "failed_actions": draft["failed_actions"],
        }
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        os.replace(temporary, self.path)
        self.wallet = draft["wallet"]
        self.applied = draft["applied"]
        self.allocations = draft["allocations"]
        self.checkpoints = draft["checkpoints"]
        self.pending = draft["pending"]
        self.failed_actions = draft["failed_actions"]


class SqlCustomerStore:
    """Example SQL adapter. ``query(sql, params)`` returns a list of row mappings. Placeholders are ``?``."""

    def __init__(self, query: Any, transaction: Callable[[Callable[[Any], Any]], Any] | None = None) -> None:
        self.query = query
        self.transaction = transaction

    def put_customer(self, customer: Mapping[str, Any]) -> None:
        self.query(
            """INSERT INTO nxtl_reseller_customers
            (id, external_id, name, email, tags_json, notes, metadata_json, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              external_id=excluded.external_id, name=excluded.name, email=excluded.email,
              tags_json=excluded.tags_json, notes=excluded.notes, metadata_json=excluded.metadata_json,
              status=excluded.status, updated_at=excluded.updated_at""",
            [
                customer["id"],
                customer.get("external_id"),
                customer.get("name"),
                customer.get("email"),
                json.dumps(customer.get("tags") or []),
                customer.get("notes"),
                json.dumps(customer.get("metadata") or {}),
                customer["status"],
                customer["created_at"],
                customer["updated_at"],
            ],
        )

    def get_customer(self, customer_id: str) -> dict[str, Any] | None:
        rows = self.query("SELECT * FROM nxtl_reseller_customers WHERE id = ?", [customer_id])
        return _customer_from_row(rows[0]) if rows else None

    def list_customers(self, **filters: Any) -> list[dict[str, Any]]:
        rows = [_customer_from_row(row) for row in self.query("SELECT * FROM nxtl_reseller_customers", [])]
        return [item for item in rows if _customer_ok(item, filters)]

    def put_assignment(self, assignment: Mapping[str, Any]) -> None:
        self.query(
            """INSERT INTO nxtl_reseller_lines (id, customer_id, iccid, label, assigned_at, unassigned_at, manual_pause)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET unassigned_at=excluded.unassigned_at, label=excluded.label, manual_pause=excluded.manual_pause""",
            [assignment["id"], assignment["customer_id"], assignment["iccid"], assignment.get("label"), assignment["assigned_at"], assignment.get("unassigned_at"), 1 if assignment.get("manual_pause") else 0],
        )

    def list_assignments(self, **filters: Any) -> list[dict[str, Any]]:
        rows = [_assignment_from_row(row) for row in self.query("SELECT * FROM nxtl_reseller_lines", [])]
        if filters.get("customer_id"):
            rows = [item for item in rows if item["customer_id"] == filters["customer_id"]]
        if filters.get("iccid"):
            rows = [item for item in rows if item["iccid"] == filters["iccid"]]
        if filters.get("active_only"):
            rows = [item for item in rows if not item.get("unassigned_at")]
        return rows

    def put_wallet_entry(self, entry: Mapping[str, Any]) -> None:
        self.query(
            """INSERT INTO nxtl_reseller_wallet (id, customer_id, at, kind, amount, currency, memo, reference)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            [entry["id"], entry["customer_id"], entry["at"], entry["kind"], entry["amount"], entry["currency"], entry.get("memo"), entry.get("reference")],
        )

    def list_wallet_entries(self, customer_id: str) -> list[dict[str, Any]]:
        return [_wallet_from_row(row) for row in self.query("SELECT * FROM nxtl_reseller_wallet WHERE customer_id = ?", [customer_id])]

    def put_package(self, package: Mapping[str, Any]) -> None:
        self.query(
            "INSERT INTO nxtl_reseller_packages (id, document_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document_json=excluded.document_json",
            [package["id"], json.dumps(package)],
        )

    def get_package(self, package_id: str) -> dict[str, Any] | None:
        rows = self.query("SELECT document_json FROM nxtl_reseller_packages WHERE id = ?", [package_id])
        return json.loads(rows[0]["document_json"]) if rows else None

    def list_packages(self) -> list[dict[str, Any]]:
        return [json.loads(row["document_json"]) for row in self.query("SELECT document_json FROM nxtl_reseller_packages", [])]

    def put_allocation(self, allocation: Mapping[str, Any]) -> None:
        self.query(
            "INSERT INTO nxtl_reseller_allocations (id, document_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document_json=excluded.document_json",
            [allocation["id"], json.dumps(allocation)],
        )

    def list_allocations(self, **filters: Any) -> list[dict[str, Any]]:
        rows = [json.loads(row["document_json"]) for row in self.query("SELECT document_json FROM nxtl_reseller_allocations", [])]
        if filters.get("customer_id"):
            rows = [item for item in rows if item["customer_id"] == filters["customer_id"]]
        if filters.get("status"):
            rows = [item for item in rows if item["status"] == filters["status"]]
        return rows

    def put_snapshot(self, snapshot: Mapping[str, Any]) -> None:
        self.query(
            "INSERT INTO nxtl_reseller_snapshots (id, customer_id, iccid, document_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET document_json=excluded.document_json",
            [snapshot["id"], snapshot.get("customer_id"), snapshot.get("iccid"), json.dumps(snapshot)],
        )

    def list_snapshots(self, **filters: Any) -> list[dict[str, Any]]:
        rows = [json.loads(row["document_json"]) for row in self.query("SELECT document_json FROM nxtl_reseller_snapshots", [])]
        if filters.get("customer_id"):
            rows = [item for item in rows if item.get("customer_id") == filters["customer_id"]]
        return rows

    def put_invoice(self, invoice: Mapping[str, Any]) -> None:
        self.query(
            "INSERT INTO nxtl_reseller_invoices (id, customer_id, document_json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET document_json=excluded.document_json",
            [invoice["id"], invoice["customer_id"], json.dumps(invoice)],
        )

    def list_invoices(self, **filters: Any) -> list[dict[str, Any]]:
        rows = [json.loads(row["document_json"]) for row in self.query("SELECT document_json FROM nxtl_reseller_invoices", [])]
        if filters.get("customer_id"):
            return [item for item in rows if item["customer_id"] == filters["customer_id"]]
        return rows

    def has_applied(self, stream: str, key: str) -> bool:
        return bool(self.query("SELECT dedup_key FROM nxtl_reseller_applied WHERE stream = ? AND dedup_key = ?", [stream, key]))

    def get_checkpoint(self, scope: str) -> int:
        rows = self.query("SELECT after_id FROM nxtl_reseller_checkpoints WHERE scope = ?", [scope])
        return int(rows[0]["after_id"]) if rows else 0

    def list_pending(self, scope: str) -> list[dict[str, Any]]:
        rows = self.query("SELECT * FROM nxtl_reseller_pending WHERE scope = ?", [scope])
        return [{"scope": scope, "ledger_id": int(row["ledger_id"]), "iccid": row["iccid"], "created_at": row.get("created_at")} for row in rows]

    def list_failed_actions(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self.query("SELECT * FROM nxtl_reseller_failed_actions", [])]

    def commit_sync(self, wallet: list[dict[str, Any]] | None = None, applied: list[dict[str, str]] | None = None, **extra: Any) -> None:
        if self.transaction is None:
            raise TypeError("SqlCustomerStore.commit_sync requires a transaction callback. Separate writes are not atomic.")

        def run(query: Any) -> None:
            _apply_sql(query, wallet, applied, extra)

        self.transaction(run)


def _apply_commit(draft: dict[str, list], wallet: list[dict[str, Any]] | None, applied: list[dict[str, str]] | None, extra: Mapping[str, Any]) -> None:
    draft["wallet"].extend(dict(item) for item in wallet or [])
    for item in applied or []:
        if not any(current["stream"] == item["stream"] and current["key"] == item["key"] for current in draft["applied"]):
            draft["applied"].append(dict(item))
    for allocation in extra.get("allocations") or []:
        _upsert(draft["allocations"], dict(allocation))
    for checkpoint in extra.get("checkpoints") or []:
        replaced = False
        for index, current in enumerate(draft["checkpoints"]):
            if current["scope"] == checkpoint["scope"]:
                draft["checkpoints"][index] = dict(checkpoint)
                replaced = True
        if not replaced:
            draft["checkpoints"].append(dict(checkpoint))
    clear = {(item["scope"], item["ledger_id"]) for item in extra.get("clear_pending") or []}
    draft["pending"] = [item for item in draft["pending"] if (item["scope"], item["ledger_id"]) not in clear]
    for item in extra.get("pending") or []:
        if not any(current["scope"] == item["scope"] and current["ledger_id"] == item["ledger_id"] for current in draft["pending"]):
            draft["pending"].append(dict(item))
    clear_failed = set(extra.get("clear_failed") or [])
    draft["failed_actions"] = [item for item in draft["failed_actions"] if item["id"] not in clear_failed]
    for action in extra.get("failed_actions") or []:
        if not any(current["id"] == action["id"] for current in draft["failed_actions"]):
            draft["failed_actions"].append(dict(action))


def _apply_sql(query: Any, wallet: list[dict[str, Any]] | None, applied: list[dict[str, str]] | None, extra: Mapping[str, Any]) -> None:
    for entry in wallet or []:
        query(
            "INSERT INTO nxtl_reseller_wallet (id, customer_id, at, kind, amount, currency, memo, reference) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [entry["id"], entry["customer_id"], entry["at"], entry["kind"], entry["amount"], entry["currency"], entry.get("memo"), entry.get("reference")],
        )
    for item in applied or []:
        query("INSERT INTO nxtl_reseller_applied (stream, dedup_key) VALUES (?, ?)", [item["stream"], item["key"]])
    for checkpoint in extra.get("checkpoints") or []:
        query(
            "INSERT INTO nxtl_reseller_checkpoints (scope, after_id) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET after_id=excluded.after_id",
            [checkpoint["scope"], checkpoint["after_id"]],
        )
    for item in extra.get("clear_pending") or []:
        query("DELETE FROM nxtl_reseller_pending WHERE scope = ? AND ledger_id = ?", [item["scope"], item["ledger_id"]])
    for item in extra.get("pending") or []:
        query(
            "INSERT INTO nxtl_reseller_pending (scope, ledger_id, iccid, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope, ledger_id) DO UPDATE SET created_at=excluded.created_at",
            [item["scope"], item["ledger_id"], item["iccid"], item.get("created_at")],
        )


def _upsert(items: list[dict[str, Any]], item: dict[str, Any]) -> None:
    for index, current in enumerate(items):
        if current["id"] == item["id"]:
            items[index] = item
            return
    items.append(item)


def _customer_ok(item: Mapping[str, Any], filters: Mapping[str, Any]) -> bool:
    if filters.get("status") and item.get("status") != filters["status"]:
        return False
    if filters.get("external_id") and item.get("external_id") != filters["external_id"]:
        return False
    if filters.get("tag") and filters["tag"] not in (item.get("tags") or []):
        return False
    return True


def _customer_from_row(row: Mapping[str, Any]) -> dict[str, Any]:
    customer: dict[str, Any] = {
        "id": row["id"],
        "tags": json.loads(str(row.get("tags_json") or "[]")),
        "metadata": json.loads(str(row.get("metadata_json") or "{}")),
        "status": row["status"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    for source, target in (("external_id", "external_id"), ("name", "name"), ("email", "email"), ("notes", "notes")):
        if row.get(source):
            customer[target] = row[source]
    return customer


def _assignment_from_row(row: Mapping[str, Any]) -> dict[str, Any]:
    assignment = {"id": row["id"], "customer_id": row["customer_id"], "iccid": row["iccid"], "assigned_at": row["assigned_at"]}
    if row.get("label"):
        assignment["label"] = row["label"]
    if row.get("unassigned_at"):
        assignment["unassigned_at"] = row["unassigned_at"]
    if int(row.get("manual_pause") or 0) == 1:
        assignment["manual_pause"] = True
    return assignment


def _wallet_from_row(row: Mapping[str, Any]) -> dict[str, Any]:
    entry = {
        "id": row["id"],
        "customer_id": row["customer_id"],
        "at": row["at"],
        "kind": row["kind"],
        "amount": float(row["amount"]),
        "currency": row["currency"],
    }
    if row.get("memo"):
        entry["memo"] = row["memo"]
    if row.get("reference"):
        entry["reference"] = row["reference"]
    return entry
