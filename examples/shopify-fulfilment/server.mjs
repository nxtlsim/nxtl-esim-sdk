/**
 * Shopify-style webhook to NXTL eSIM fulfilment.
 * Sample application code, not a Shopify app.
 *
 * Shopify signs the raw body and sends base64 HMAC-SHA256 in
 * X-Shopify-Hmac-Sha256. This route handles orders/paid, queues one eSIM with
 * the Shopify order id as client_reference, and stores activation strings
 * when a later NXTL webhook carries them. Attaching that text to the Shopify
 * order is a call to the merchant Admin API and is left as a comment.
 *
 *   npm install express @nxtlsim/esim-sdk
 *   NXTL_API_KEY=... NXTL_WEBHOOK_SECRET=... SHOPIFY_WEBHOOK_SECRET=... node server.mjs
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import { NxtlClient, constructWebhookEvent, extractActivation } from "@nxtlsim/esim-sdk";

const nxtl = new NxtlClient({ apiKey: process.env.NXTL_API_KEY });
const fulfilments = new Map();
const app = express();

function shopifySignatureOk(rawBody, header) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET ?? "";
  if (!header || !secret) return false;
  const digest = createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.post("/webhooks/shopify/orders-paid", express.raw({ type: "application/json" }), async (req, res) => {
  if (!shopifySignatureOk(req.body, req.get("X-Shopify-Hmac-Sha256"))) {
    res.status(401).json({ error: "invalid_shopify_signature" });
    return;
  }
  const order = JSON.parse(req.body.toString("utf8"));
  const reference = String(order.id);
  const queued = await nxtl.issueEsim(
    {
      nickname: order.email ?? `Order ${reference}`,
      tier: "cheapest",
      client_reference: reference,
    },
    { idempotencyKey: `shopify-${reference}` },
  );
  fulfilments.set(reference, {
    shopifyOrderId: reference,
    jobId: queued.data.job_id,
    status: "queued",
  });
  res.status(202).json({ reference, jobId: queued.data.job_id });
});

app.post("/webhooks/nxtl", express.raw({ type: "application/json" }), async (req, res) => {
  const event = await constructWebhookEvent({
    payload: req.body,
    signatureHeader: req.get("X-NXTL-Signature-V1"),
    secret: process.env.NXTL_WEBHOOK_SECRET,
  });
  const reference = typeof event.data.client_reference === "string" ? event.data.client_reference : undefined;
  if (reference && event.event === "esim.provisioned") {
    const activation = extractActivation(event.data);
    const current = fulfilments.get(reference) ?? { shopifyOrderId: reference };
    fulfilments.set(reference, { ...current, status: "ready_to_notify", ...activation });
    // A production app would then write activation.lpa onto the Shopify order
    // through the merchant Admin API, using the shop's own access token.
  }
  res.status(204).end();
});

app.get("/fulfilments/:reference", (req, res) => {
  const row = fulfilments.get(req.params.reference);
  if (!row) {
    res.status(404).end();
    return;
  }
  res.json(row);
});

app.listen(Number(process.env.PORT ?? 3000));
