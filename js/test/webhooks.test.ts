import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  NxtlWebhookError,
  constructWebhookEvent,
  parseWebhookEvent,
  verifyWebhookSignature,
} from "../src/index.js";

const secret = "whsec_test";
const body = JSON.stringify({
  id: "evt_1",
  event: "test.ping",
  timestamp: 1_700_000_000,
  data: { ok: true },
});

function sign(payload: string, key = secret, timestamp = "1700000000"): string {
  const hex = createHmac("sha256", key).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${hex}`;
}

describe("webhooks", () => {
  it("accepts a valid HMAC and rejects tampering", async () => {
    const header = sign(body);
    assert.equal(await verifyWebhookSignature({
      payload: body,
      signatureHeader: header,
      secret,
      nowSeconds: 1_700_000_000,
    }), true);
    assert.equal(await verifyWebhookSignature({
      payload: body + " ",
      signatureHeader: header,
      secret,
      nowSeconds: 1_700_000_000,
    }), false);
    assert.equal(await verifyWebhookSignature({
      payload: body,
      signatureHeader: header,
      secret,
      nowSeconds: 1_700_000_000 + 301,
    }), false);
    assert.equal(await verifyWebhookSignature({
      payload: body,
      signatureHeader: null,
      secret,
    }), false);
  });

  it("accepts the rotating secret", async () => {
    const header = sign(body, "whsec_next");
    assert.equal(await verifyWebhookSignature({
      payload: body,
      signatureHeader: header,
      secret: [secret, "whsec_next"],
      nowSeconds: 1_700_000_000,
    }), true);
  });

  it("parses the envelope and rejects a bad signature on construct", async () => {
    const event = parseWebhookEvent(body);
    assert.equal(event.event, "test.ping");
    assert.equal(event.id, "evt_1");
    const constructed = await constructWebhookEvent({
      payload: body,
      signatureHeader: sign(body),
      secret,
      nowSeconds: 1_700_000_000,
    });
    assert.equal(constructed.data.ok, true);
    await assert.rejects(
      () => constructWebhookEvent({ payload: body, signatureHeader: "t=1700000000,v1=" + "ab".repeat(32), secret }),
      NxtlWebhookError,
    );
  });
});
