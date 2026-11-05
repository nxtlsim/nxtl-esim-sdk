/**
 * Express storefront sample for NXTL eSIM. This is application code, not a plugin.
 *
 *   npm install express @nxtlsim/esim-sdk
 *   NXTL_API_KEY=... NXTL_WEBHOOK_SECRET=... node server.mjs
 *
 * Customer payment happens in your checkout. NXTL issuance draws the pooled
 * balance. POST /topup is not used here: it credits that pool from prepaid
 * budget and does not charge a card.
 */
import express from "express";
import {
  NxtlClient,
  PublicCatalog,
  constructWebhookEvent,
  fulfilEsimOrder,
  quotePrice,
} from "@nxtlsim/esim-sdk";

const nxtl = new NxtlClient({ apiKey: process.env.NXTL_API_KEY });
const catalog = new PublicCatalog();
const orders = new Map();
const markup = {
  mode: "percentage",
  percentage: 35,
  rounding: "0.99",
  currency: "EUR",
  countryOverrides: { JP: { percentage: 50 } },
};

const app = express();

app.post("/api/checkout", express.json(), async (req, res, next) => {
  try {
    const { email, country, reference } = req.body ?? {};
    if (!email || !country || !reference) {
      res.status(400).json({ error: "email, country, and reference are required" });
      return;
    }
    const pricing = await catalog.pricing();
    const retail = catalog.quoteCountryRate(pricing, country, markup);
    const order = {
      reference,
      email,
      country,
      retailPerGb: retail.retail,
      currency: retail.currency,
      status: "queued",
    };
    orders.set(reference, order);
    const fulfilled = await fulfilEsimOrder(nxtl, {
      clientReference: reference,
      nickname: email,
      tier: "cheapest",
      idempotencyKey: `checkout-${reference}`,
    });
    order.status = "provisioned";
    order.jobId = fulfilled.accepted.data.job_id;
    order.iccid = fulfilled.activation.iccid;
    order.lpa = fulfilled.activation.lpa;
    order.qr = fulfilled.activation.qr;
    res.status(201).json({
      reference,
      retailPerGb: order.retailPerGb,
      currency: order.currency,
      formatted: quotePrice(retail.wholesale, markup, { country }).formatted,
      lpa: order.lpa ?? null,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/webhooks/nxtl", express.raw({ type: "application/json" }), async (req, res) => {
  const event = await constructWebhookEvent({
    payload: req.body,
    signatureHeader: req.get("X-NXTL-Signature-V1"),
    secret: process.env.NXTL_WEBHOOK_SECRET,
  });
  if (event.event === "esim.provisioned") {
    const reference = event.data.client_reference;
    const order = typeof reference === "string" ? orders.get(reference) : undefined;
    if (order) {
      order.status = "provisioned";
      order.eventId = event.id;
    }
  }
  res.status(204).end();
});

app.get("/api/orders/:reference", (req, res) => {
  const order = orders.get(req.params.reference);
  if (!order) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(order);
});

app.use((error, _req, res, _next) => {
  const status = error.status && error.status >= 400 ? error.status : 500;
  res.status(status).json({ error: error.code ?? "checkout_failed", message: error.message });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  process.stdout.write(`NXTL eSIM storefront sample listening on ${port}\n`);
});
