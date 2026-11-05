import asyncio
import hashlib
import hmac

import httpx
import pytest

from nxtl_esim import (
    API_OPERATIONS,
    AsyncNxtlClient,
    NxtlAccessDeniedError,
    NxtlAuthError,
    NxtlClient,
    NxtlInsufficientBalanceError,
    NxtlJobFailedError,
    NxtlNotFoundError,
    NxtlQuotaExceededError,
    NxtlRateLimitError,
    NxtlServerError,
    NxtlValidationError,
    NxtlWebhookError,
    PublicCatalog,
    assess_balance,
    construct_webhook_event,
    extract_activation,
    format_currency,
    fulfil_esim_order,
    quote_price,
    round_price,
    sum_usage_amounts,
    verify_webhook_signature,
)

ICCID = "8900000000000000001"
KEY = "test-key"


def test_operation_count() -> None:
    assert len(API_OPERATIONS) == 48
    assert len({item.id for item in API_OPERATIONS}) == 48
    assert len({(item.method, item.path) for item in API_OPERATIONS}) == 48


def test_auth_header_and_health_without_key() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"name": "Acme", "ok": True})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        bare = NxtlClient(http_client=http, retry=False)
        health = bare.health()
        assert health.status_code == 200
        assert "x-nxtl-key" not in {k.lower() for k in calls[0].headers.keys()}
        authed = NxtlClient(KEY, http_client=http, user_agent="sdk-test", retry=False)
        partner = authed.partner()
        assert partner.data["name"] == "Acme"
        assert calls[1].headers["X-NXTL-Key"] == KEY
        assert calls[1].headers["User-Agent"] == "sdk-test"
        assert str(calls[1].url) == "https://nxtlsim.com/api/v1/partner"


def test_missing_key_is_auth_error() -> None:
    client = NxtlClient(retry=False, http_client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200))))
    with pytest.raises(NxtlAuthError):
        client.partner()
    client.close()


def test_idempotency_key_is_reused_on_retry() -> None:
    calls: list[httpx.Request] = []
    sleeps: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(
                500,
                json={"error": True, "type": "UPSTREAM_ERROR", "code": "upstream_error", "message": "again"},
            )
        return httpx.Response(202, json={"job_id": 9})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        client = NxtlClient(
            KEY,
            http_client=http,
            retry={"max_retries": 2, "sleep": sleeps.append, "random": lambda: 0},
        )
        response = client.issue_esim(
            {"nickname": "Traveller 123", "tier": "cheapest", "client_reference": "ORDER-123"},
            options={"idempotency_key": "order-123-esim"},
        )
        assert response.data["job_id"] == 9
        assert response.idempotency_key == "order-123-esim"
        assert calls[0].headers["Idempotency-Key"] == "order-123-esim"
        assert calls[1].headers["Idempotency-Key"] == "order-123-esim"
        assert sleeps


def test_unsafe_post_is_not_retried() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(
            502,
            json={"error": True, "type": "UPSTREAM_ERROR", "code": "upstream_error", "message": "down"},
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        client = NxtlClient(KEY, http_client=http, retry={"max_retries": 3, "sleep": lambda _s: None})
        with pytest.raises(NxtlServerError):
            client.suspend_esim(ICCID)
        assert calls["n"] == 1


def test_retry_after_on_429() -> None:
    sleeps: list[float] = []
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(
                429,
                headers={"Retry-After": "2"},
                json={"error": True, "type": "RATE_LIMIT_EXCEEDED", "code": "rate_limit_exceeded", "message": "slow"},
            )
        return httpx.Response(200, json={"ok": True})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        client = NxtlClient(
            KEY,
            http_client=http,
            retry={"max_retries": 2, "sleep": sleeps.append, "random": lambda: 0},
        )
        response = client.suspend_esim(ICCID)
        assert response.status_code == 200
        assert sleeps[0] >= 2


@pytest.mark.parametrize(
    ("status", "body", "exc"),
    [
        (400, {"error": True, "type": "BAD_REQUEST", "code": "bad_request", "message": "no"}, NxtlValidationError),
        (401, {"error": True, "type": "UNAUTHORIZED", "code": "unauthorized", "message": "no"}, NxtlAuthError),
        (403, {"error": True, "type": "ACCESS_DENIED", "code": "access_denied", "message": "no"}, NxtlAccessDeniedError),
        (404, {"error": True, "type": "NOT_FOUND", "code": "not_found", "message": "no"}, NxtlNotFoundError),
        (402, {"error": "insufficient_balance"}, NxtlInsufficientBalanceError),
        (409, {"error": True, "type": "QUOTA_EXCEEDED", "code": "quota_exhausted", "message": "full"}, NxtlQuotaExceededError),
        (429, {"error": True, "type": "RATE_LIMIT_EXCEEDED", "code": "rate_limit_exceeded", "message": "slow"}, NxtlRateLimitError),
    ],
)
def test_error_mapping(status: int, body: dict, exc: type) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body)

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        client = NxtlClient(KEY, http_client=http, retry=False)
        with pytest.raises(exc):
            client.partner()


def test_every_operation() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api/v1")
        calls.append(f"{request.method} {path}")
        return httpx.Response(200, json={"job_id": 1, "id": 1, "public_id": "pk", "secret": "once", "rules": []})

    rule = {"metric": "balance_below", "threshold_value": 5}
    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        client = NxtlClient(KEY, http_client=http, retry=False)
        client.health()
        client.partner()
        client.quotas()
        client.audit(page=1, per_page=10)
        client.list_esims(status="ready", page=1)
        client.issue_esim({"tier": "cheapest"}, options={"idempotency_key": "k"})
        client.list_lines()
        client.get_esim(ICCID)
        client.update_nickname(ICCID, {"nickname": "A"})
        client.update_tier(ICCID, {"tier": "best_coverage"})
        client.update_status(ICCID, {"action": "suspend"})
        client.suspend_esim(ICCID)
        client.resume_esim(ICCID)
        client.get_wallet(ICCID)
        client.get_esim_usage(ICCID)
        client.get_esim_events(ICCID)
        client.bulk_status({"iccids": [ICCID]})
        client.bulk_tier({"iccids": [ICCID], "tier": "cheapest"})
        client.bulk_issue({"quantity": 1, "tier": "standard"}, options={"idempotency_key": "b"})
        client.estimate({"quantity": 2})
        client.list_jobs()
        client.get_job(4)
        client.get_esim_request(4)
        client.get_balance()
        client.list_balance_history(page=1, per_page=5)
        client.topup({"amount_usd": 1}, options={"idempotency_key": "t"})
        client.list_invoices()
        client.usage_summary(days=7)
        client.usage_esims(limit=10)
        client.usage_lines()
        client.usage_cdrs(page=1, per_page=20)
        client.usage_timeseries(days=30)
        client.list_api_keys()
        client.create_api_key({"label": "ci"})
        client.revoke_api_key("pk_123")
        client.get_webhooks()
        client.update_webhooks({"webhook_url": "https://example.com/hook", "events": ["test.ping"]})
        client.list_webhook_events()
        client.get_webhook_secret()
        client.test_webhook()
        client.list_webhook_deliveries(status="failed", page=1)
        client.get_webhook_delivery(3)
        client.replay_webhook_delivery(3)
        client.replay_webhook_delivery_legacy(3)
        client.list_thresholds()
        client.create_threshold(rule)
        client.update_threshold(8, rule)
        client.delete_threshold(8)

    assert calls == [
        "GET /health",
        "GET /partner",
        "GET /quotas",
        "GET /audit",
        "GET /esims",
        "POST /esims",
        "GET /lines",
        f"GET /esims/{ICCID}",
        f"PATCH /esims/{ICCID}/nickname",
        f"PATCH /esims/{ICCID}/tier",
        f"PATCH /esims/{ICCID}/status",
        f"POST /esims/{ICCID}/suspend",
        f"POST /esims/{ICCID}/resume",
        f"GET /esims/{ICCID}/wallet",
        f"GET /esims/{ICCID}/usage",
        f"GET /esims/{ICCID}/events",
        "POST /esims/bulk-status",
        "POST /esims/bulk-tier",
        "POST /esims/bulk-issue",
        "POST /esims/estimate",
        "GET /jobs",
        "GET /jobs/4",
        "GET /esim-requests/4",
        "GET /balance",
        "GET /balance/history",
        "POST /topup",
        "GET /invoices",
        "GET /usage/summary",
        "GET /usage/esims",
        "GET /usage/lines",
        "GET /usage/cdrs",
        "GET /usage/timeseries",
        "GET /api-keys",
        "POST /api-keys",
        "DELETE /api-keys/pk_123",
        "GET /webhooks",
        "PUT /webhooks",
        "GET /webhooks/events",
        "GET /webhooks/secret",
        "POST /webhooks/test",
        "GET /webhooks/deliveries",
        "GET /webhooks/deliveries/3",
        "POST /webhooks/deliveries/3/replay",
        "POST /webhooks/3/replay",
        "GET /thresholds",
        "POST /thresholds",
        "PATCH /thresholds/8",
        "DELETE /thresholds/8",
    ]


def test_pagination_and_balance_and_order() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/esims/estimate"):
            return httpx.Response(200, json={"affordable": True})
        if request.method == "POST" and request.url.path.endswith("/esims"):
            return httpx.Response(202, json={"job_id": 7})
        if request.url.path.endswith("/jobs/7"):
            handler.jobs += 1  # type: ignore[attr-defined]
            if handler.jobs == 1:  # type: ignore[attr-defined]
                return httpx.Response(200, json={"status": "running", "id": 7})
            return httpx.Response(
                200,
                json={
                    "status": "completed",
                    "results": [{"iccid": ICCID, "activation_code": "LPA:1$smdp.example$MATCH"}],
                },
            )
        if request.url.path.endswith("/esims"):
            page = request.url.params.get("page")
            esims = [{"iccid": "8900000000000000001"}, {"iccid": "8900000000000000002"}] if page == "1" else [{"iccid": "8900000000000000003"}]
            return httpx.Response(200, json={"esims": esims})
        if request.url.path.endswith("/balance"):
            return httpx.Response(200, json={"pool": {"balance_usd": 4.5, "currency": "USD"}})
        return httpx.Response(404, json={"error": True, "type": "NOT_FOUND", "code": "not_found", "message": "no"})

    handler.jobs = 0  # type: ignore[attr-defined]
    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        client = NxtlClient(KEY, http_client=http, retry=False)
        rows = [row["iccid"] for row in client.iterate_esims(per_page=2)]
        assert rows == ["8900000000000000001", "8900000000000000002", "8900000000000000003"]
        result = fulfil_esim_order(
            client,
            client_reference="ORDER-123",
            nickname="Traveller 123",
            tier="cheapest",
            idempotency_key="order-123-esim",
            sleep=lambda _s: None,
        )
        assert result["activation"]["lpa"] == "LPA:1$smdp.example$MATCH"
        assessment = assess_balance(client, low_usd=10)
        assert assessment["amount_usd"] == 4.5
        assert assessment["status"] == "low"


def test_failed_job() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/estimate"):
            return httpx.Response(200, json={})
        if request.method == "POST":
            return httpx.Response(202, json={"job_id": 3})
        return httpx.Response(200, json={"status": "failed", "id": 3})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        client = NxtlClient(KEY, http_client=http, retry=False)
        with pytest.raises(NxtlJobFailedError):
            fulfil_esim_order(client, client_reference="ORDER-9", sleep=lambda _s: None)


def test_pricing_and_usage_and_catalog() -> None:
    quote = quote_price(10, {"mode": "percentage", "percentage": 20, "fixed": 1, "currency": "EUR", "rounding": "nearest"})
    assert quote.retail == 13
    assert quote.fx_applied is False
    config = {
        "mode": "tiered",
        "rounding": "nearest",
        "currency": "EUR",
        "tiers": [
            {"up_to": 5, "percentage": 40},
            {"up_to": 20, "percentage": 25},
            {"up_to": None, "percentage": 15},
        ],
        "country_overrides": {"jp": {"percentage": 50, "mode": "percentage"}},
    }
    assert quote_price(4, config).retail == 5.6
    assert quote_price(10, config).retail == 12.5
    assert quote_price(30, config).retail == 34.5
    assert quote_price(10, config, country="JP").retail == 15
    assert round_price(10, "0.99") == 10.99
    assert round_price(10.99, "0.99") == 10.99
    assert round_price(11, "0.99") == 11.99
    assert format_currency(1.5, "EURO") == "1.50 EURO"
    with pytest.raises(TypeError):
        quote_price(-1, {"percentage": 10})
    totals = sum_usage_amounts([{"amount_usd": 0, "amount_eur": 1.25}, {"amount_usd": 2, "amount_eur": 0}])
    assert totals["zero_is_not_free"] is True
    assert extract_activation({"results": [{"qr_code": "https://cdn.example/qr.png"}]})["qr"].endswith("qr.png")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "currency": "EUR",
                "countries": [{"iso2": "FR", "name": "France", "currency": "EUR", "cheapest_eur_per_gb": 2}],
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        catalog = PublicCatalog(http_client=http, retry=False)
        feed = catalog.pricing()
        priced = catalog.quote_country_rate(feed, "fr", {"percentage": 50, "rounding": "0.99"})
        assert priced.retail == 3.99
        assert priced.currency == "EUR"
        assert priced.fx_applied is False


def test_webhooks() -> None:
    secret = "whsec_test"
    body = '{"id":"evt_1","event":"test.ping","timestamp":1700000000,"data":{"ok":true}}'
    digest = hmac.new(secret.encode(), f"1700000000.{body}".encode(), hashlib.sha256).hexdigest()
    header = f"t=1700000000,v1={digest}"
    assert verify_webhook_signature(payload=body, signature_header=header, secret=secret, now_seconds=1700000000)
    assert not verify_webhook_signature(payload=body + " ", signature_header=header, secret=secret, now_seconds=1700000000)
    assert not verify_webhook_signature(
        payload=body,
        signature_header=header,
        secret=secret,
        now_seconds=1700000000 + 301,
    )
    event = construct_webhook_event(payload=body, signature_header=header, secret=secret, now_seconds=1700000000)
    assert event["event"] == "test.ping"
    with pytest.raises(NxtlWebhookError):
        construct_webhook_event(payload=body, signature_header="t=1700000000,v1=" + "ab" * 32, secret=secret)


def test_async_client_smoke() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True, "esims": [{"iccid": ICCID}]})

    async def run() -> None:
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http:
            client = AsyncNxtlClient(KEY, http_client=http, retry=False)
            partner = await client.partner()
            assert partner.data["ok"] is True
            rows = []
            async for row in client.iterate_esims(per_page=50):
                rows.append(row["iccid"])
                break
            assert rows == [ICCID]
            await client.aclose()

    asyncio.run(run())
