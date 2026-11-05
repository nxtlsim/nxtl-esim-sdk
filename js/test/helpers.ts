import type { ApiResponse } from "../src/types.js";

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface Route {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** When set, each call consumes the next response. */
  sequence?: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>;
}

export function mockFetch(routes: Record<string, Route> | ((req: CapturedRequest) => Route)) {
  const calls: CapturedRequest[] = [];
  const counts = new Map<string, number>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headersToObject(init?.headers);
    let body: unknown;
    if (typeof init?.body === "string" && init.body.length > 0) {
      body = JSON.parse(init.body) as unknown;
    }
    const captured: CapturedRequest = { url, method, headers, ...(body !== undefined ? { body } : {}) };
    calls.push(captured);
    const path = new URL(url).pathname.replace(/^\/api\/v1/, "");
    const key = `${method} ${path}`;
    const route = typeof routes === "function" ? routes(captured) : routes[key];
    if (!route) {
      return jsonResponse(404, { error: true, type: "NOT_FOUND", code: "not_found", message: `no route ${key}` });
    }
    const index = counts.get(key) ?? 0;
    counts.set(key, index + 1);
    const chosen = route.sequence ? route.sequence[Math.min(index, route.sequence.length - 1)] : route;
    const status = chosen?.status ?? route.status ?? 200;
    const payload = chosen && "body" in chosen ? chosen.body : route.body;
    const responseHeaders = { ...(route.headers ?? {}), ...(chosen?.headers ?? {}) };
    return jsonResponse(status, payload ?? {}, responseHeaders);
  };
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key.toLowerCase()] = value;
    return out;
  }
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

export function dataOf<T>(response: ApiResponse<T>): T {
  return response.data;
}
