"""Best-effort pagination.

TODO(spec): paginated responses do not publish an envelope. The helper reads
a bare array or the first array under a small set of likely keys, and stops
on an empty page, a short page when per_page is known, a repeated first item,
has_more false, or total_pages when those fields exist.
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Mapping
from typing import Any, Callable

from .models import ApiResponse, JsonObject

ITEM_KEYS = (
    "data",
    "esims",
    "items",
    "results",
    "entries",
    "rows",
    "rules",
    "events",
    "cdrs",
    "jobs",
    "deliveries",
    "audit",
    "history",
    "invoices",
    "ledger",
)


def extract_items(payload: Any) -> list[JsonObject]:
    if isinstance(payload, list):
        return [item for item in payload if _is_object(item)]
    if not _is_object(payload):
        return []
    for key in ITEM_KEYS:
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if _is_object(item)]
    for value in payload.values():
        if isinstance(value, list) and all(_is_object(item) for item in value):
            return list(value)
    return []


async def async_iterate_pages(
    fetch_page: Callable[[int], Any],
    *,
    per_page: int | None = None,
    max_pages: int = 100,
    start_page: int = 1,
) -> Any:
    previous: str | None = None
    for index in range(max_pages):
        page = start_page + index
        response = await fetch_page(page)
        items = extract_items(response.data)
        if not items:
            return
        fingerprint = json.dumps(items[0], sort_keys=True, default=str)
        if fingerprint == previous:
            return
        previous = fingerprint
        for item in items:
            yield item
        if per_page is not None and len(items) < per_page:
            return
        total_pages = _read_total_pages(response.data)
        if total_pages is not None and page >= total_pages:
            return
        if _read_has_more(response.data) is False:
            return


def iterate_pages(
    fetch_page: Callable[[int], ApiResponse[Any]],
    *,
    per_page: int | None = None,
    max_pages: int = 100,
    start_page: int = 1,
) -> Iterator[JsonObject]:
    previous: str | None = None
    for index in range(max_pages):
        page = start_page + index
        response = fetch_page(page)
        items = extract_items(response.data)
        if not items:
            return
        fingerprint = json.dumps(items[0], sort_keys=True, default=str)
        if fingerprint == previous:
            return
        previous = fingerprint
        yield from items
        if per_page is not None and len(items) < per_page:
            return
        total_pages = _read_total_pages(response.data)
        if total_pages is not None and page >= total_pages:
            return
        if _read_has_more(response.data) is False:
            return


def _read_total_pages(payload: Any) -> int | None:
    value = _read_number(payload, ("total_pages", "pages"))
    if value is not None:
        return value
    if not _is_object(payload):
        return None
    for key in ("meta", "pagination"):
        nested = _read_number(payload.get(key), ("total_pages", "pages"))
        if nested is not None:
            return nested
    return None


def _read_has_more(payload: Any) -> bool | None:
    if not _is_object(payload):
        return None
    if isinstance(payload.get("has_more"), bool):
        return bool(payload["has_more"])
    for key in ("meta", "pagination"):
        nested = payload.get(key)
        if _is_object(nested) and isinstance(nested.get("has_more"), bool):
            return bool(nested["has_more"])
    return None


def _read_number(payload: Any, keys: tuple[str, ...]) -> int | None:
    if not _is_object(payload):
        return None
    for key in keys:
        value = payload.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            return value
    return None


def _is_object(value: Any) -> bool:
    return isinstance(value, Mapping) and not isinstance(value, (str, bytes))
