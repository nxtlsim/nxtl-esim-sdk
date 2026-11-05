"""Reseller and customer layer. These helpers sit on top of the NXTL eSIM API.

Packages, customer wallets, invoices, and markup are reseller-side records.
They are not NXTL plans. The connectivity model remains pay-as-you-go.
"""

from .billing import build_customer_invoice, build_statement, invoices_to_csv, invoices_to_json, margin_report
from .customers import AsyncCustomerDirectory, CustomerDirectory, new_customer
from .fx import convert_fx
from .monitoring import (
    WebhookRouter,
    ensure_pool_balance_rule,
    ensure_usage_percent_rule,
    sync_loop,
    sync_reseller,
    sync_reseller_async,
)
from .ops import LineLifecycle, provision_customers, provision_customers_async, quote_trip, read_audit, search_catalog
from .packages import (
    apply_usage_to_packages,
    define_package,
    open_allocation,
    remaining_allowance,
    renew_allocation,
    suspend_overage_lines,
    sync_package_threshold,
    top_up_allocation,
)
from .store import CUSTOMER_STORE_SQL, JsonFileCustomerStore, MemoryCustomerStore, SqlCustomerStore
from .units import format_data, from_bytes, to_bytes
from .usage import (
    build_usage_report,
    cost_usage,
    diff_snapshots,
    load_usage_details,
    load_usage_details_async,
    normalize_usage_row,
    period_bounds,
    snapshot_usage,
)

__all__ = [
    "CUSTOMER_STORE_SQL",
    "AsyncCustomerDirectory",
    "CustomerDirectory",
    "JsonFileCustomerStore",
    "LineLifecycle",
    "MemoryCustomerStore",
    "SqlCustomerStore",
    "WebhookRouter",
    "apply_usage_to_packages",
    "build_customer_invoice",
    "build_statement",
    "build_usage_report",
    "convert_fx",
    "cost_usage",
    "define_package",
    "diff_snapshots",
    "ensure_pool_balance_rule",
    "ensure_usage_percent_rule",
    "format_data",
    "from_bytes",
    "invoices_to_csv",
    "invoices_to_json",
    "load_usage_details",
    "load_usage_details_async",
    "margin_report",
    "new_customer",
    "normalize_usage_row",
    "open_allocation",
    "period_bounds",
    "provision_customers",
    "provision_customers_async",
    "quote_trip",
    "read_audit",
    "remaining_allowance",
    "renew_allocation",
    "search_catalog",
    "snapshot_usage",
    "suspend_overage_lines",
    "sync_loop",
    "sync_package_threshold",
    "sync_reseller",
    "sync_reseller_async",
    "to_bytes",
    "top_up_allocation",
]
