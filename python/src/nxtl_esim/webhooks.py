"""HMAC-SHA256 verification for ``X-NXTL-Signature-V1``.

The human API reference signs ``{timestamp}.{raw_body}``. The OpenAPI info
string names the header and the algorithm and does not spell that payload.
TODO(spec): no replay window is defined. ``tolerance_seconds`` defaults to 300
and can be set to 0 to skip the timestamp check.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from collections.abc import Mapping, Sequence
from typing import Any, Union

from .errors import NxtlWebhookError
from .models import JsonObject

SIGNATURE_HEADER = "X-NXTL-Signature-V1"
Payload = Union[str, bytes]


def verify_webhook_signature(
    *,
    payload: Payload,
    signature_header: str | None,
    secret: str | Sequence[str],
    tolerance_seconds: int = 300,
    now_seconds: int | None = None,
) -> bool:
    parsed = parse_signature_header(signature_header)
    if parsed is None:
        return False
    timestamp, supplied = parsed
    if tolerance_seconds > 0:
        now = int(time.time()) if now_seconds is None else now_seconds
        if abs(now - timestamp) > tolerance_seconds:
            return False
    secrets = [secret] if isinstance(secret, str) else list(secret)
    if not secrets or any(not item for item in secrets):
        return False
    body = payload.encode("utf-8") if isinstance(payload, str) else payload
    message = f"{timestamp}.".encode() + body
    ok = False
    for key in secrets:
        computed = hmac.new(key.encode("utf-8"), message, hashlib.sha256).hexdigest()
        ok = hmac.compare_digest(computed, supplied) or ok
    return ok


def construct_webhook_event(
    *,
    payload: Payload,
    signature_header: str | None,
    secret: str | Sequence[str],
    tolerance_seconds: int = 300,
    now_seconds: int | None = None,
) -> JsonObject:
    if not verify_webhook_signature(
        payload=payload,
        signature_header=signature_header,
        secret=secret,
        tolerance_seconds=tolerance_seconds,
        now_seconds=now_seconds,
    ):
        raise NxtlWebhookError("Invalid NXTL eSIM webhook signature")
    return parse_webhook_event(payload)


def parse_webhook_event(payload: Payload | Mapping[str, Any]) -> JsonObject:
    value: Any = payload
    if isinstance(payload, (str, bytes)):
        text = payload.decode("utf-8") if isinstance(payload, bytes) else payload
        try:
            value = json.loads(text)
        except json.JSONDecodeError as exc:
            raise NxtlWebhookError("Webhook body is not JSON") from exc
    if not isinstance(value, dict):
        raise NxtlWebhookError("Webhook body must be a JSON object")
    if not isinstance(value.get("id"), str) or not value["id"]:
        raise NxtlWebhookError("Webhook envelope is missing id")
    if not isinstance(value.get("event"), str) or not value["event"]:
        raise NxtlWebhookError("Webhook envelope is missing event")
    raw_timestamp = value.get("timestamp")
    if isinstance(raw_timestamp, bool) or not isinstance(raw_timestamp, (int, float)):
        if isinstance(raw_timestamp, str) and raw_timestamp.isdigit():
            raw_timestamp = int(raw_timestamp)
        else:
            raise NxtlWebhookError("Webhook envelope timestamp must be Unix seconds")
    if int(raw_timestamp) != raw_timestamp:
        raise NxtlWebhookError("Webhook envelope timestamp must be Unix seconds")
    data = value.get("data")
    if not isinstance(data, dict):
        raise NxtlWebhookError("Webhook envelope data must be an object")
    return {"id": value["id"], "event": value["event"], "timestamp": int(raw_timestamp), "data": data}


def parse_signature_header(header: str | None) -> tuple[int, str] | None:
    if not header:
        return None
    timestamp: str | None = None
    v1: str | None = None
    for part in header.split(","):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key == "t":
            timestamp = value
        elif key == "v1":
            v1 = value
    if not timestamp or not timestamp.isdigit() or not v1:
        return None
    if len(v1) != 64:
        return None
    try:
        int(v1, 16)
    except ValueError:
        return None
    return int(timestamp), v1.lower()
