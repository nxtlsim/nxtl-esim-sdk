"""FastAPI sample for NXTL eSIM checkout and signed webhooks.

Install and run:

    pip install fastapi uvicorn nxtl-esim
    NXTL_API_KEY=... NXTL_WEBHOOK_SECRET=... uvicorn main:app --reload

This is application code. Customer payment stays in your checkout. Issuance
uses the pooled balance. The LPA string is returned only after the job
completes and only when that string is present in the job JSON.
"""

from __future__ import annotations

import os
from typing import Any, Optional

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field

from nxtl_esim import (
    NxtlClient,
    NxtlError,
    construct_webhook_event,
    fulfil_esim_order,
    quote_price,
)

app = FastAPI(title="NXTL eSIM fulfilment sample")
orders: dict[str, dict[str, Any]] = {}
MARKUP = {"mode": "percentage", "percentage": 35, "rounding": "0.99", "currency": "EUR"}


class CheckoutIn(BaseModel):
    reference: str = Field(min_length=1)
    email: str
    country: str = Field(min_length=2, max_length=2)
    wholesale_eur_per_gb: float = Field(ge=0)


@app.post("/api/checkout")
def checkout(body: CheckoutIn) -> dict[str, Any]:
    retail = quote_price(body.wholesale_eur_per_gb, MARKUP, country=body.country)
    try:
        with NxtlClient(os.environ["NXTL_API_KEY"]) as nxtl:
            result = fulfil_esim_order(
                nxtl,
                client_reference=body.reference,
                nickname=body.email,
                tier="cheapest",
                idempotency_key=f"checkout-{body.reference}",
            )
    except NxtlError as exc:
        raise HTTPException(status_code=exc.status_code or 502, detail=str(exc)) from exc
    record = {
        "reference": body.reference,
        "retail_per_gb": retail.retail,
        "currency": retail.currency,
        "job_id": result["accepted"].data.get("job_id"),
        "lpa": result["activation"].get("lpa"),
        "qr": result["activation"].get("qr"),
        "iccid": result["activation"].get("iccid"),
    }
    orders[body.reference] = record
    return record


@app.post("/webhooks/nxtl", status_code=204)
async def nxtl_webhook(
    request: Request,
    x_nxtl_signature_v1: Optional[str] = Header(default=None),
) -> None:
    raw = await request.body()
    try:
        event = construct_webhook_event(
            payload=raw,
            signature_header=x_nxtl_signature_v1,
            secret=os.environ["NXTL_WEBHOOK_SECRET"],
        )
    except NxtlError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    reference = event["data"].get("client_reference") if isinstance(event["data"], dict) else None
    if event["event"] == "esim.provisioned" and isinstance(reference, str) and reference in orders:
        orders[reference]["status"] = "provisioned"
        orders[reference]["event_id"] = event["id"]


@app.get("/api/orders/{reference}")
def get_order(reference: str) -> dict[str, Any]:
    row = orders.get(reference)
    if row is None:
        raise HTTPException(status_code=404, detail="not_found")
    return row
