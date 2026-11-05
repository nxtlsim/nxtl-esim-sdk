"""Types published by OpenAPI 2.6.3, plus loose aliases where no schema exists."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Generic, Literal, TypedDict, TypeVar

JsonObject = dict[str, Any]
T = TypeVar("T")

EsimStatus = Literal["pre_service", "ready", "suspended", "terminated"]
NetworkTier = Literal["cheapest", "best_coverage"]
# ``standard`` is accepted by the API and stored as ``cheapest``. It is not in the enum.
NetworkTierInput = Literal["cheapest", "best_coverage", "standard"]
StatusAction = Literal["suspend", "reactivate", "terminate"]
ThresholdScope = Literal["balance", "esim", "line"]
ThresholdMetric = Literal["balance_below", "line_usage_pct", "line_usage_usd_today"]
ThresholdOperator = Literal["<", "<=", "=", ">=", ">"]
ThresholdPeriod = Literal["instant", "daily", "weekly", "monthly"]
ThresholdAction = Literal["notify", "suspend"]
DeliveryStatus = Literal["pending", "delivered", "failed"]

# Events named in the human API reference. ``event`` is a free string in OpenAPI.
WEBHOOK_EVENT_NAMES = (
    "esim.provisioned",
    "esim.provision_failed",
    "esim.tier_changed",
    "esim.suspended",
    "esim.reactivated",
    "esim.terminated",
    "esim.exchanged",
    "esim.usage_threshold",
    "balance.topup",
    "balance.low",
    "balance.exhausted",
    "usage.recorded",
    "job.completed",
    "job.failed",
    "test.ping",
)

SDK_VERSION = "0.1.0"
API_SPEC_VERSION = "2.6.3"
DEFAULT_BASE_URL = "https://nxtlsim.com/api/v1"
DEFAULT_ORIGIN = "https://nxtlsim.com"
DEFAULT_USER_AGENT = f"nxtl-esim/{SDK_VERSION} (+https://nxtlsim.com)"


class ESimIssueRequest(dict):
    """components.schemas.ESimIssueRequest. A plain dict with the published keys."""


class ErrorEnvelope(dict):
    """components.schemas.Error."""


@dataclass
class RateLimitInfo:
    limit: int | None = None
    remaining: int | None = None
    # TODO(spec): X-RateLimit-Reset is named in the human reference and its unit is not defined.
    reset: str | None = None
    retry_after: float | None = None


@dataclass
class ApiResponse(Generic[T]):
    data: T
    status_code: int
    headers: Mapping[str, str]
    request_id: str | None
    idempotent_replayed: bool
    rate_limit: RateLimitInfo = field(default_factory=RateLimitInfo)
    idempotency_key: str | None = None


@dataclass
class Operation:
    id: str
    method: str
    path: str
    summary: str
    auto_idempotency: bool


class ESimIssueBody(TypedDict, total=False):
    nickname: str
    tier: NetworkTierInput
    client_reference: str


class NicknameBody(TypedDict):
    nickname: str


class TierBody(TypedDict):
    tier: NetworkTierInput


class StatusBody(TypedDict):
    action: StatusAction


class IccidListBody(TypedDict):
    iccids: list[str]


class BulkTierBody(TypedDict):
    iccids: list[str]
    tier: NetworkTierInput


class BulkIssueBody(TypedDict, total=False):
    quantity: int
    tier: NetworkTierInput
    client_reference: str
    metadata: JsonObject


class EstimateBody(TypedDict, total=False):
    quantity: int
    tier: NetworkTierInput


class TopupBody(TypedDict):
    amount_usd: float


class ApiKeyCreateBody(TypedDict, total=False):
    label: str


class WebhookConfigBody(TypedDict, total=False):
    webhook_url: str
    events: list[str]


class ThresholdRuleBody(TypedDict, total=False):
    scope: ThresholdScope
    metric: ThresholdMetric
    operator: ThresholdOperator
    threshold_value: float
    period: ThresholdPeriod
    action: ThresholdAction
    enabled: bool
    notes: JsonObject


class CallOptions(dict):
    """Optional per-call overrides.

    Keys: ``idempotency_key``, ``headers``, ``timeout`` (seconds), ``retry``
    (a mapping or False).
    """


class Logger:
    """Logger hook. Methods may be omitted."""

    def debug(self, message: str, meta: Mapping[str, Any] | None = None) -> None:
        return None

    def info(self, message: str, meta: Mapping[str, Any] | None = None) -> None:
        return None

    def warn(self, message: str, meta: Mapping[str, Any] | None = None) -> None:
        return None

    def error(self, message: str, meta: Mapping[str, Any] | None = None) -> None:
        return None
