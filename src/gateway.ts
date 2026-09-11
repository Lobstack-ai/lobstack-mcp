/**
 * Talking to the Gateway.
 *
 * One fetch wrapper, because there is one rule that must never be skipped on
 * any request: do not follow a redirect with a credential attached.
 *
 * A redirect that changes host makes every conforming HTTP client drop
 * `Authorization` (RFC 9110 §15.4), so the Gateway answers a perfectly good key
 * with "missing credentials" and the user goes looking for a problem with their
 * key. `redirect: "manual"` plus a loud failure is the only honest response:
 * the request did not fail because the key is bad, it failed because the key
 * was never sent.
 */

import { scrub, type Config } from "./config.js";

export class GatewayError extends Error {
  readonly hint: string | undefined;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  constructor(message: string, opts: { hint?: string; status?: number; requestId?: string } = {}) {
    super(message);
    this.name = "GatewayError";
    this.hint = opts.hint;
    this.status = opts.status;
    this.requestId = opts.requestId;
  }
}

/** Identifies this client in the Gateway's traces. Not a credential. */
export const CLIENT_ID = "lobstack-mcp";

export interface FetchOpts {
  method?: string;
  body?: string;
  /** Send no `Authorization` at all. Used by route_preview, which needs none. */
  anonymous?: boolean;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export async function gwFetch(cfg: Config, url: string, opts: FetchOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "x-lobstack-client": CLIENT_ID,
    ...(opts.headers ?? {}),
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (!opts.anonymous && cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      body: opts.body,
      signal: opts.signal ?? null,
      redirect: "manual",
      headers,
    });
  } catch (e) {
    throw new GatewayError(
      `could not reach the gateway: ${scrub(e instanceof Error ? e.message : String(e), cfg.apiKey)}`,
      { hint: `Base URL in use: ${cfg.base.origin}` },
    );
  }

  if (res.status >= 300 && res.status < 400) {
    // Not followed, and not quietly.
    const location = res.headers.get("location");
    throw new GatewayError(
      `the gateway redirected (${res.status}) to ${location || "somewhere else"}; the request was not followed.`,
      {
        status: res.status,
        hint:
          "A redirect across hosts strips the Authorization header, so the key would never arrive. " +
          "Set LOBSTACK_BASE_URL to the host that answers directly — https://www.lobstack.ai, never the bare apex.",
      },
    );
  }
  return res;
}

/** A readable error out of a non-2xx response, with the key scrubbed out. */
export async function errorFrom(cfg: Config, res: Response, hint?: string): Promise<GatewayError> {
  const requestId = res.headers.get("x-lobstack-request-id") ?? undefined;
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { message?: string } | string };
    const inner = typeof body?.error === "string" ? body.error : body?.error?.message;
    if (inner) message = inner;
  } catch {
    /* not JSON */
  }
  return new GatewayError(scrub(message, cfg.apiKey), { status: res.status, requestId, hint });
}

/** Quota, as the Gateway reports it on every response. See `lib/gateway/quota.ts`. */
export interface Quota {
  meter: string;
  allowance_usd?: number | null;
  spent_usd?: number | null;
  remaining_usd?: number | null;
  limit?: number | null;
  used?: number | null;
  remaining?: number | null;
  credits?: number | null;
  resets_at?: string | null;
}

const numOrNull = (v: string | null): number | null => {
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Pull the allowance off response headers.
 *
 * Worth doing because it is free: the Gateway sets these on every answer,
 * including the streamed one, so an agent finds out it is close to a 402 on the
 * call before the one that fails rather than after it. There is no key-
 * authenticated endpoint that reports this on its own — `/api/user/allowance`
 * needs a browser session — so this is the only honest place to get it.
 */
export function quotaFromHeaders(h: Headers): Quota | null {
  const meter = h.get("x-lobstack-quota-meter");
  if (!meter) return null;
  const q: Quota = { meter };
  if (meter === "spend") {
    q.allowance_usd = numOrNull(h.get("x-lobstack-quota-allowance-usd"));
    q.spent_usd = numOrNull(h.get("x-lobstack-quota-spent-usd"));
    q.remaining_usd = numOrNull(h.get("x-lobstack-quota-remaining-usd"));
  } else {
    q.limit = numOrNull(h.get("x-lobstack-quota-limit"));
    q.used = numOrNull(h.get("x-lobstack-quota-used"));
    q.remaining = numOrNull(h.get("x-lobstack-quota-remaining"));
    q.credits = numOrNull(h.get("x-lobstack-quota-credits"));
  }
  q.resets_at = h.get("x-lobstack-quota-resets");
  return q;
}

/** One line describing the allowance, or null when the Gateway did not report one. */
export function describeQuota(q: Quota | null): string | null {
  if (!q) return null;
  if (q.meter === "spend") {
    if (q.remaining_usd === null || q.remaining_usd === undefined) return null;
    const of = q.allowance_usd != null ? ` of $${q.allowance_usd.toFixed(2)}` : "";
    return `  allowance $${q.remaining_usd.toFixed(4)} remaining${of}`;
  }
  if (q.remaining === null || q.remaining === undefined) return null;
  const of = q.limit != null ? ` of ${q.limit}` : "";
  return `  allowance ${q.remaining} requests remaining${of} (${q.meter} meter)`;
}
