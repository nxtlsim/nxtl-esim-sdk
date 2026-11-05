import { NxtlWebhookError } from "./errors.js";
import type { JsonObject, WebhookEnvelope } from "./types.js";

/** Header named by the OpenAPI info description. */
export const WEBHOOK_SIGNATURE_HEADER = "X-NXTL-Signature-V1";

export interface VerifyWebhookOptions {
  /** Raw request body. Do not re-serialize parsed JSON. */
  payload: string | Uint8Array;
  /** Value of `X-NXTL-Signature-V1`. */
  signatureHeader: string | null | undefined;
  /**
   * Active HMAC secret. Pass the rotating secret as a second entry when
   * GET /webhooks/secret returns one.
   */
  secret: string | readonly string[];
  /**
   * Reject signatures whose `t` is further than this many seconds from now.
   * Default 300. Set 0 to skip the check.
   * TODO(spec): the OpenAPI document does not define a replay window.
   * The human reference specifies the header and the signed string
   * `{timestamp}.{raw_body}` and does not define a tolerance either.
   */
  toleranceSeconds?: number;
  /** Unix seconds. Defaults to the current time. */
  nowSeconds?: number;
}

/**
 * Verify `X-NXTL-Signature-V1: t=<unix>,v1=<hex>`.
 *
 * The HMAC-SHA256 input is the UTF-8 string `{t}.{raw_body}`, matching the
 * human API reference. The OpenAPI info string names the header and the
 * algorithm and does not spell that payload format.
 */
export async function verifyWebhookSignature(options: VerifyWebhookOptions): Promise<boolean> {
  const parsed = parseSignatureHeader(options.signatureHeader);
  if (!parsed) return false;
  const tolerance = options.toleranceSeconds ?? 300;
  if (tolerance > 0) {
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - parsed.timestamp) > tolerance) return false;
  }
  const secrets = typeof options.secret === "string" ? [options.secret] : [...options.secret];
  if (secrets.length === 0 || secrets.some((item) => item.length === 0)) return false;
  const prefix = new TextEncoder().encode(`${parsed.timestamp}.`);
  const body = typeof options.payload === "string" ? new TextEncoder().encode(options.payload) : options.payload;
  const message = concatBytes(prefix, body);
  let ok = false;
  for (const secret of secrets) {
    const computed = await hmacSha256Hex(secret, message);
    ok = timingSafeEqualHex(computed, parsed.v1) || ok;
  }
  return ok;
}

export async function constructWebhookEvent<TData extends JsonObject = JsonObject>(
  options: VerifyWebhookOptions,
): Promise<WebhookEnvelope<TData>> {
  const ok = await verifyWebhookSignature(options);
  if (!ok) {
    throw new NxtlWebhookError("Invalid NXTL eSIM webhook signature");
  }
  return parseWebhookEvent<TData>(options.payload);
}

export function parseWebhookEvent<TData extends JsonObject = JsonObject>(
  payload: string | Uint8Array | JsonObject,
): WebhookEnvelope<TData> {
  let value: unknown = payload;
  if (typeof payload === "string" || payload instanceof Uint8Array) {
    const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new NxtlWebhookError("Webhook body is not JSON");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NxtlWebhookError("Webhook body must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new NxtlWebhookError("Webhook envelope is missing id");
  }
  if (typeof record.event !== "string" || record.event.length === 0) {
    throw new NxtlWebhookError("Webhook envelope is missing event");
  }
  const timestamp = typeof record.timestamp === "number"
    ? record.timestamp
    : typeof record.timestamp === "string" && /^\d+$/.test(record.timestamp)
      ? Number(record.timestamp)
      : NaN;
  if (!Number.isInteger(timestamp)) {
    throw new NxtlWebhookError("Webhook envelope timestamp must be Unix seconds");
  }
  if (!record.data || typeof record.data !== "object" || Array.isArray(record.data)) {
    throw new NxtlWebhookError("Webhook envelope data must be an object");
  }
  return {
    id: record.id,
    event: record.event,
    timestamp,
    data: record.data as TData,
  };
}

export function parseSignatureHeader(
  header: string | null | undefined,
): { timestamp: number; v1: string } | null {
  if (!header) return null;
  let timestamp: string | undefined;
  let v1: string | undefined;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    if (key === "v1") v1 = value;
  }
  if (!timestamp || !/^\d+$/.test(timestamp) || !v1) return null;
  if (v1.length !== 64 || !/^[0-9a-f]{64}$/i.test(v1)) return null;
  return { timestamp: Number(timestamp), v1: v1.toLowerCase() };
}

interface HmacSubtle {
  importKey(
    format: "raw",
    keyData: ArrayBuffer,
    algorithm: { name: string; hash: string },
    extractable: boolean,
    keyUsages: string[],
  ): Promise<unknown>;
  sign(algorithm: string, key: unknown, data: ArrayBuffer): Promise<ArrayBuffer>;
}

async function hmacSha256Hex(secret: string, message: Uint8Array): Promise<string> {
  const subtle = await getSubtle();
  const key = await subtle.importKey(
    "raw",
    copyBuffer(new TextEncoder().encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await subtle.sign("HMAC", key, copyBuffer(message));
  return bufferToHex(new Uint8Array(signature));
}

async function getSubtle(): Promise<HmacSubtle> {
  const existing = globalThis.crypto?.subtle as HmacSubtle | undefined;
  if (existing) return existing;
  try {
    const mod = await import("node:crypto");
    const subtle = mod.webcrypto?.subtle as HmacSubtle | undefined;
    if (subtle) return subtle;
  } catch {
    // Edge runtimes expose global crypto and do not provide node:crypto.
  }
  throw new NxtlWebhookError("Web Crypto is not available for webhook verification");
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bufferToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function timingSafeEqualHex(computed: string, supplied: string): boolean {
  if (computed.length !== supplied.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i += 1) {
    diff |= computed.charCodeAt(i) ^ supplied.charCodeAt(i);
  }
  return diff === 0;
}
