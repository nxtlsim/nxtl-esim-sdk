#!/usr/bin/env python3
"""Regenerate nxtl_esim/endpoints.py from the OpenAPI operation table."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "src" / "nxtl_esim" / "endpoints.py"

# name, http, path, summary, auto, path_params, query, body, prelude
# path_params: list of (name, kind) kind = iccid | int | key
# query: list of (name, annotation, extra_validate_line or "")
# body: None or (annotation, required, prelude)

OPS = [
    ("health", "GET", "/health", "Public health check", False, [], [], None),
    ("partner", "GET", "/partner", "Partner profile and scopes resolved by the key", False, [], [], None),
    ("quotas", "GET", "/quotas", "Balance, lifetime quota, rate limit, issuance fee, subscription state", False, [], [], None),
    ("audit", "GET", "/audit", "Partner-scoped audit log", False, [], [
        ("action", "Optional[str]"),
        ("target_type", "Optional[str]"),
        ("target_id", "Optional[str]"),
        ("since", "Optional[str]"),
        ("until", "Optional[str]"),
        ("page", "Optional[int]"),
        ("per_page", "Optional[int]"),
    ], None, "validate_page(page, per_page, 200)"),
    ("list_esims", "GET", "/esims", "List eSIMs in your fleet", False, [], [
        ("iccid", "Optional[str]"),
        ("status", "Optional[str]"),
        ("tier", "Optional[str]"),
        ("client_reference", "Optional[str]"),
        ("page", "Optional[int]"),
        ("per_page", "Optional[int]"),
    ], None, "validate_page(page, per_page, 200)\nif status is not None:\n    validate_status(status)"),
    ("issue_esim", "POST", "/esims", "Issue a single eSIM (async). Returns 202 and a job id", True, [], [], ("Optional[ESimIssueBody]", False), "if body and body.get('nickname') is not None:\n    validate_nickname(body['nickname'])\nif body and body.get('tier') is not None:\n    validate_tier(body['tier'])"),
    ("list_lines", "GET", "/lines", "Legacy alias of GET /esims", False, [], [
        ("iccid", "Optional[str]"),
        ("status", "Optional[str]"),
        ("tier", "Optional[str]"),
        ("client_reference", "Optional[str]"),
        ("page", "Optional[int]"),
        ("per_page", "Optional[int]"),
    ], None, "validate_page(page, per_page, 200)\nif status is not None:\n    validate_status(status)"),
    ("get_esim", "GET", "/esims/{iccid}", "Retrieve one eSIM", False, [("iccid", "iccid")], [], None),
    ("update_nickname", "PATCH", "/esims/{iccid}/nickname", "Update nickname", False, [("iccid", "iccid")], [], ("NicknameBody", True), "validate_nickname(body['nickname'])"),
    ("update_tier", "PATCH", "/esims/{iccid}/tier", "Change network tier", False, [("iccid", "iccid")], [], ("TierBody", True), "validate_tier(body['tier'])"),
    ("update_status", "PATCH", "/esims/{iccid}/status", "Suspend, reactivate, or terminate", False, [("iccid", "iccid")], [], ("StatusBody", True), "validate_action(body['action'])"),
    ("suspend_esim", "POST", "/esims/{iccid}/suspend", "Suspend alias", False, [("iccid", "iccid")], [], None),
    ("resume_esim", "POST", "/esims/{iccid}/resume", "Reactivate alias", False, [("iccid", "iccid")], [], None),
    ("get_wallet", "GET", "/esims/{iccid}/wallet", "Wallet snapshot", False, [("iccid", "iccid")], [], None),
    ("get_esim_usage", "GET", "/esims/{iccid}/usage", "Per-line usage rows", False, [("iccid", "iccid")], [], None),
    ("get_esim_events", "GET", "/esims/{iccid}/events", "Per-line ledger events", False, [("iccid", "iccid")], [], None),
    ("bulk_status", "POST", "/esims/bulk-status", "Look up the status of many ICCIDs", False, [], [], ("IccidListBody", True), "body = {'iccids': validate_iccids(list(body['iccids']), 100)}"),
    ("bulk_tier", "POST", "/esims/bulk-tier", "Change the network tier for many ICCIDs", False, [], [], ("BulkTierBody", True), "validate_tier(body['tier'])\nbody = {'iccids': validate_iccids(list(body['iccids']), 1000), 'tier': body['tier']}"),
    ("bulk_issue", "POST", "/esims/bulk-issue", "Async batch issuance. Returns 202 and a job id", True, [], [], ("BulkIssueBody", True), "validate_quantity(body['quantity'])\nif body.get('tier') is not None:\n    validate_tier(body['tier'])"),
    ("estimate", "POST", "/esims/estimate", "Pre-flight cost estimate. Does not create eSIMs", False, [], [], ("EstimateBody", True), "validate_quantity(body['quantity'])\nif body.get('tier') is not None:\n    validate_tier(body['tier'])"),
    ("list_jobs", "GET", "/jobs", "List async jobs. TODO(spec): described as paginated, with no page parameters", False, [], [], None),
    ("get_job", "GET", "/jobs/{id}", "Job detail with per-row results", False, [("id", "int")], [], None),
    ("get_esim_request", "GET", "/esim-requests/{job_id}", "Legacy alias of GET /jobs/{id}", False, [("job_id", "int")], [], None),
    ("get_balance", "GET", "/balance", "Pool totals and per-eSIM wallet mirrors", False, [], [], None),
    ("list_balance_history", "GET", "/balance/history", "Recent ledger entries", False, [], [
        ("page", "Optional[int]"),
        ("per_page", "Optional[int]"),
    ], None, "validate_page(page, per_page, None)"),
    ("topup", "POST", "/topup", "Credit the pooled balance from the partner prepaid budget. Does not charge a card", True, [], [], ("TopupBody", True), "validate_amount_usd(body['amount_usd'])"),
    ("list_invoices", "GET", "/invoices", "Orders associated with API-driven top-ups", False, [], [], None),
    ("usage_summary", "GET", "/usage/summary", "Partner-wide aggregated usage", False, [], [
        ("days", "Optional[int]"),
    ], None, "if days is not None:\n    validate_days(days)"),
    ("usage_esims", "GET", "/usage/esims", "Per-eSIM aggregates", False, [], [
        ("since", "Optional[str]"),
        ("until", "Optional[str]"),
        ("iccid", "Optional[str]"),
        ("limit", "Optional[int]"),
    ], None, "if limit is not None:\n    validate_limit(limit)"),
    ("usage_lines", "GET", "/usage/lines", "Legacy alias of GET /usage/esims. TODO(spec): no query parameters are published", False, [], [], None),
    ("usage_cdrs", "GET", "/usage/cdrs", "Itemised usage events", False, [], [
        ("iccid", "Optional[str]"),
        ("since", "Optional[str]"),
        ("until", "Optional[str]"),
        ("page", "Optional[int]"),
        ("per_page", "Optional[int]"),
    ], None, "validate_page(page, per_page, 500)"),
    ("usage_timeseries", "GET", "/usage/timeseries", "Daily usage and top-up totals", False, [], [
        ("days", "Optional[int]"),
    ], None, "if days is not None:\n    validate_days(days, 365)"),
    ("list_api_keys", "GET", "/api-keys", "List keys without secrets", False, [], [], None),
    ("create_api_key", "POST", "/api-keys", "Create a key. The secret is returned once", False, [], [], ("Optional[ApiKeyCreateBody]", False), None),
    ("revoke_api_key", "DELETE", "/api-keys/{key_public}", "Revoke a key", False, [("key_public", "key")], [], None),
    ("get_webhooks", "GET", "/webhooks", "Read the webhook URL and subscriptions", False, [], [], None),
    ("update_webhooks", "PUT", "/webhooks", "Update the webhook URL and subscriptions", False, [], [], ("Optional[WebhookConfigBody]", False), None),
    ("list_webhook_events", "GET", "/webhooks/events", "Catalog of events and subscription state", False, [], [], None),
    ("get_webhook_secret", "GET", "/webhooks/secret", "Active HMAC secret and signed-payload spec", False, [], [], None),
    ("test_webhook", "POST", "/webhooks/test", "Send test.ping to the configured URL", False, [], [], None),
    ("list_webhook_deliveries", "GET", "/webhooks/deliveries", "List webhook deliveries. TODO(spec): page is published; per_page is not", False, [], [
        ("status", "Optional[str]"),
        ("event", "Optional[str]"),
        ("since", "Optional[str]"),
        ("until", "Optional[str]"),
        ("page", "Optional[int]"),
    ], None, "validate_page(page, None, None)"),
    ("get_webhook_delivery", "GET", "/webhooks/deliveries/{id}", "Full delivery row", False, [("id", "int")], [], None),
    ("replay_webhook_delivery", "POST", "/webhooks/deliveries/{id}/replay", "Replay a delivery", False, [("id", "int")], [], None),
    ("replay_webhook_delivery_legacy", "POST", "/webhooks/{id}/replay", "Replay a delivery (legacy alias)", False, [("id", "int")], [], None),
    ("list_thresholds", "GET", "/thresholds", "List threshold rules", False, [], [], None),
    ("create_threshold", "POST", "/thresholds", "Create a threshold rule", False, [], [], ("ThresholdRuleBody", True), "validate_threshold(body)"),
    ("update_threshold", "PATCH", "/thresholds/{id}", "Update a threshold rule", False, [("id", "int")], [], ("ThresholdRuleBody", True), "validate_threshold(body)"),
    ("delete_threshold", "DELETE", "/thresholds/{id}", "Delete a threshold rule", False, [("id", "int")], [], None),
]


def normalize(item: tuple) -> dict:
    name, method, path, summary, auto, path_params, query, body = item[:8]
    prelude = item[8] if len(item) > 8 else None
    return {
        "name": name,
        "method": method,
        "path": path,
        "summary": summary,
        "auto": auto,
        "path_params": path_params,
        "query": query,
        "body": body,
        "prelude": prelude,
    }


def render_method(op: dict, asynchronous: bool) -> str:
    params = ["self"]
    for name, kind in op["path_params"]:
        annotation = "str" if kind in {"iccid", "key"} else "Union[int, str]"
        params.append(f"{name}: {annotation}")
    if op["body"] is not None:
        annotation, required = op["body"]
        if required:
            params.append(f"body: {annotation}")
        else:
            params.append(f"body: {annotation} = None")
    for name, annotation in op["query"]:
        params.append(f"{name}: {annotation} = None")
    params.append("options: Optional[Mapping[str, Any]] = None")
    signature = ",\n        ".join(params)
    lines = []
    prefix = "async def" if asynchronous else "def"
    lines.append(f"    {prefix} {op['name']}(")
    lines.append(f"        {signature},")
    lines.append("    ) -> ApiResponse[JsonObject]:")
    lines.append(f'        """{op["method"]} {op["path"]} — {op["summary"]}."""')
    for name, kind in op["path_params"]:
        if kind == "iccid":
            lines.append(f"        {name} = validate_iccid({name})")
        elif kind == "int":
            lines.append(f"        {name} = validate_integer_id({name}, {name!r})")
        elif kind == "key":
            lines.append(f"        {name} = validate_key_public({name})")
    if op["prelude"]:
        for line in op["prelude"].split("\n"):
            lines.append(f"        {line}" if line else "")
    path = op["path"]
    if op["path_params"]:
        rendered = path
        for name, _kind in op["path_params"]:
            rendered = rendered.replace("{" + name + "}", "{" + name + "}")
        # encode at the call by using an f-string with encode_path
        expr = path
        for name, _kind in op["path_params"]:
            expr = expr.replace("{" + name + "}", "{encode_path(" + name + ")}")
        path_arg = 'f"' + expr + '"'
    else:
        path_arg = repr(path)
    call_bits = [repr(op["method"]), path_arg]
    if op["query"]:
        keys = ", ".join(f"{name!r}: {name}" for name, _ann in op["query"])
        lines.append(f"        query = omit_none({{{keys}}})")
        call_bits.append("query=query")
    if op["body"] is not None:
        _annotation, required = op["body"]
        if required:
            call_bits.append("json_body=body")
        else:
            # Send {} when the caller omitted an optional JSON body so POST/PUT stay explicit.
            if op["method"] in {"POST", "PUT", "PATCH"}:
                lines.append("        payload = {} if body is None else body")
                call_bits.append("json_body=payload")
            else:
                call_bits.append("json_body=body")
    call_bits.append("options=options")
    if op["auto"]:
        call_bits.append("auto_idempotency=True")
    callee = "await self._request" if asynchronous else "self._request"
    lines.append(f"        return {callee}(")
    for bit in call_bits:
        lines.append(f"            {bit},")
    lines.append("        )")
    lines.append("")
    return "\n".join(lines)


def render_operations() -> str:
    rows = []
    for raw in OPS:
        op = normalize(raw)
        rows.append(
            "    Operation("
            f"{op['name']!r}, {op['method']!r}, {op['path']!r}, {op['summary']!r}, {op['auto']!r}"
            "),"
        )
    return "API_OPERATIONS: tuple[Operation, ...] = (\n" + "\n".join(rows) + "\n)\n"


def main() -> None:
    ops = [normalize(item) for item in OPS]
    if len(ops) != 48:
        raise SystemExit(f"expected 48 operations, found {len(ops)}")
    chunks = [
        '"""Endpoint methods for the 48 NXTL eSIM API operations.',
        "",
        "Generated by python/tools/render_endpoints.py — edit that table and rerun it.",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "from typing import Any, Mapping, Optional, Union",
        "",
        "from .models import (",
        "    ApiKeyCreateBody,",
        "    ApiResponse,",
        "    BulkIssueBody,",
        "    BulkTierBody,",
        "    ESimIssueBody,",
        "    EstimateBody,",
        "    IccidListBody,",
        "    JsonObject,",
        "    NicknameBody,",
        "    Operation,",
        "    StatusBody,",
        "    ThresholdRuleBody,",
        "    TierBody,",
        "    TopupBody,",
        "    WebhookConfigBody,",
        ")",
        "from .validate import (",
        "    encode_path,",
        "    omit_none,",
        "    validate_action,",
        "    validate_amount_usd,",
        "    validate_days,",
        "    validate_iccid,",
        "    validate_iccids,",
        "    validate_integer_id,",
        "    validate_key_public,",
        "    validate_limit,",
        "    validate_nickname,",
        "    validate_page,",
        "    validate_quantity,",
        "    validate_status,",
        "    validate_threshold,",
        "    validate_tier,",
        ")",
        "",
        render_operations(),
        "",
        "class EndpointMixin:",
        '    """Sync endpoint methods. The concrete client implements ``_request``."""',
        "",
        "    def _request(self, method: str, path: str, **kwargs: Any) -> ApiResponse[JsonObject]:",
        "        raise NotImplementedError",
        "",
    ]
    for op in ops:
        chunks.append(render_method(op, False))
    chunks.append("class AsyncEndpointMixin:")
    chunks.append('    """Async endpoint methods. The concrete client implements ``_request``."""')
    chunks.append("")
    chunks.append("    async def _request(self, method: str, path: str, **kwargs: Any) -> ApiResponse[JsonObject]:")
    chunks.append("        raise NotImplementedError")
    chunks.append("")
    for op in ops:
        chunks.append(render_method(op, True))
    TARGET.write_text("\n".join(chunks))
    print(f"wrote {TARGET} ({len(ops)} operations)")


if __name__ == "__main__":
    main()
