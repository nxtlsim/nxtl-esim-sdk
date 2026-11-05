/**
 * WooCommerce-style webhook to NXTL eSIM fulfilment.
 * Sample application code, not a WordPress plugin.
 *
 * WooCommerce signs the raw body with HMAC-SHA256 and sends base64 in
 * X-WC-Webhook-Signature. After the order is paid, this process queues one
 * pay-as-you-go eSIM. A second route accepts the NXTL webhook and stores the
 * LPA string against the order when the job JSON or event data contains one.
 *
 *   npm install express @nxtlsim/esim-sdk
 *   NXTL_API_KEY=... NXTL_WEBHOOK_SECRET=... WC_WEBHOOK_SECRET=... node server.mjs
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import { NxtlClient, constructWebhookEvent, extractActivation } from "@nxtlsim/esim-sdk";

const nxtl = new NxtlClient({ apiKey: process.env.NXTL_API_KEY });
const orders = new Map();
const app = express();

function wooSignatureOk(rawBody, header) {
  const secret = process.env.WC_WEBHOOK_SECRET ?? "";
  if (!header || !secret) return false;
  const digest = createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.post("/webhooks/woocommerce", express.raw({ type: "application/json" }), async (req, res) => {
  if (!wooSignatureOk(req.body, req.get("X-WC-Webhook-Signature"))) {
    res.status(401).json({ error: "invalid_woocommerce_signature" });
    return;
  }
  const order = JSON.parse(req.body.toString("utf8"));
  if (order.status !== "processing" && order.status !== "completed") {
    res.status(202).json({ ignored: order.status });
    return;
  }
  const reference = String(order.id);
  const queued = await nxtl.issueEsim(
    {
      nickname: order.billing?.email ?? `Order ${reference}`,
      tier: "cheapest",
      client_reference: reference,
    },
    { idempotencyKey: `woo-${reference}` },
  );
  orders.set(reference, { jobId: queued.data.job_id, status: "queued" });
  res.status(202).json({ reference, jobId: queued.data.job_id });
});

app.post("/webhooks/nxtl", express.raw({ type: "application/json" }), async (req, res) => {
  const event = await constructWebhookEvent({
    payload: req.body,
    signatureHeader: req.get("X-NXTL-Signature-V1"),
    secret: process.env.NXTL_WEBHOOK_SECRET,
  });
  if (event.event === "esim.provisioned" || event.event === "job.completed") {
    const activation = extractActivation(event.data);
    const reference = typeof event.data.client_reference === "string" ? event.data.client_reference : undefined;
    if (reference && orders.has(reference)) {
      orders.set(reference, { ...orders.get(reference), status: "fulfilled", ...activation });
    }
  }
  res.status(204).end();
});

app.get("/orders/:reference", (req, res) => {
  const row = orders.get(req.params.reference);
  if (!row) {
    res.status(404).end();
    return;
  }
  res.json(row);
});

app.listen(Number(process.env.PORT ?? 3000));
