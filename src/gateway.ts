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
  /** The API's machine-readable reason, e.g. "ALLOWANCE_EXHAUSTED". The field to branch on. */
  readonly code: string | undefined;
  /** One of the six classes on /docs/gateway/errors. */
  readonly errorClass: ErrorClass | undefined;
  /** Seconds, from the Retry-After header, when the API sent one. */
  readonly retryAfter: number | undefined;
  constructor(
    message: string,
    opts: {
      hint?: string;
      status?: number;
      requestId?: string;
      code?: string;
      errorClass?: ErrorClass;
      retryAfter?: number;
    } = {},
  ) {
    super(message);
    this.name = "GatewayError";
    this.hint = opts.hint;
    this.status = opts.status;
    this.requestId = opts.requestId;
    this.code = opts.code;
    this.errorClass = opts.errorClass;
    this.retryAfter = opts.retryAfter;
  }
}

/**
 * The API's six error classes. Mirrors `ERROR_CLASSES` in the platform's
 * `src/lib/gateway/error-classes.ts`, which generates /docs/gateway/errors:
 * the class decides whether a retry can help, so an agent is told it.
 */
export const ERROR_CLASSES = ["auth", "quota", "validation", "provider", "timeout", "internal"] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

export function classForStatus(status: number): ErrorClass {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 429) return "quota";
  if (status === 400 || status === 409 || status === 422) return "validation";
  if (status === 408 || status === 504) return "timeout";
  if (status === 500) return "internal";
  if (status >= 500) return "provider";
  return "internal";
}

/** Whether retrying can help, per class and status. Stated to the agent so it does not loop on a 402. */
export function retryAdvice(cls: ErrorClass, status: number | undefined, retryAfter?: number, code?: string): string {
  const wait = retryAfter ? ` after ${retryAfter}s (Retry-After)` : "";
  // A deployment switch, not a blip: retrying in a loop only burns the agent's turns.
  if (code === "SEARCH_UNAVAILABLE" || code === "MANAGED_DISABLED" || code === "PROVIDER_ACCOUNT_UNAVAILABLE") {
    return `Do not retry in a loop; use a fallback${retryAfter ? `, or try once more after ${retryAfter}s` : ""}.`;
  }
  switch (cls) {
    case "auth":
      return "Do not retry: fix the key or its scopes.";
    case "quota":
      return status === 429 ? `Retry${wait || " with backoff"}.` : "Do not retry: the allowance or a budget is spent until it is raised or resets.";
    case "validation":
      return "Do not retry unchanged: fix the arguments; the same call fails the same way.";
    case "provider":
      return `Retry with backoff${wait}.`;
    case "timeout":
      return "Retry; the first attempt may have completed and been billed.";
    default:
      return "Retry once, then report the request id.";
  }
}

/** One line per machine-readable code the API documents. */
export const CODE_HINTS: Record<string, string> = {
  RATE_LIMITED: "Over the per-key rate limit.",
  SEARCH_RATE_LIMITED: "Over the per-key web search limit.",
  CONCURRENCY_LIMIT: "Too many calls running at once for this plan.",
  SPEND_IN_FLIGHT: "Calls already running have reserved what is left of the allowance; retry when they finish.",
  FREE_CREDIT_USED: "The Free plan's one-time credit is used; it does not reset. Upgrade in Console → Billing.",
  ALLOWANCE_EXHAUSTED: "The plan's included usage and credit are used. Top up or upgrade in Console → Billing.",
  INSUFFICIENT_ALLOWANCE: "What is left will not cover this call. Top up in Console → Billing.",
  KEY_CAP_REACHED: "This API key reached its monthly spend cap. Raise it in Console → API keys.",
  PERSON_CAP_REACHED: "The key creator reached their monthly spend cap.",
  CLIENT_BUDGET_EXHAUSTED: "That client tag's monthly budget is spent. Raise it in Console → Clients.",
  CLIENT_TAG_INVALID: "A client tag is 1–64 characters of a–z, 0–9, '.', '_' or '-', starting with a letter or digit.",
  INVALID_PARAMETER: "An argument has the wrong type or range; the message names it.",
  SEARCH_UNAVAILABLE: "Web search is not configured on this deployment. Use another search tool; do not retry in a loop.",
  MANAGED_DISABLED: "Calls on Lobstack's provider keys are paused. Use another tool or retry later.",
  PROVIDER_ACCOUNT_UNAVAILABLE: "Lobstack's own provider account refused the call; Lobstack is alerted.",
};

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
      `could not reach the Lobstack API: ${scrub(e instanceof Error ? e.message : String(e), cfg.apiKey)}`,
      { hint: `Base URL in use: ${cfg.base.origin}` },
    );
  }

  if (res.status >= 300 && res.status < 400) {
    // Not followed, and not quietly.
    const location = res.headers.get("location");
    throw new GatewayError(
      `the Lobstack API redirected (${res.status}) to ${location || "somewhere else"}; the request was not followed.`,
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

/**
 * A readable error out of a non-2xx response, with the key scrubbed out.
 *
 * Two body shapes exist: the usual `{ error: { message, type, code, error_code,
 * request_id } }`, and a plain `{ error: "…", error_code }` (the search 503
 * and the platform API's 401/403). Both are read.
 */
export async function errorFrom(cfg: Config, res: Response, hint?: string): Promise<GatewayError> {
  let requestId = res.headers.get("x-lobstack-request-id") ?? undefined;
  let message = `HTTP ${res.status}`;
  let code: string | undefined;
  let klass: string | undefined;
  try {
    const body = (await res.json()) as {
      error?: { message?: string; type?: string; error_code?: string; request_id?: string } | string;
      error_code?: string;
      request_id?: string;
    };
    const e = body?.error;
    const inner = typeof e === "string" ? e : e?.message;
    if (inner) message = inner;
    const c = (typeof e === "object" ? e?.error_code : undefined) ?? body?.error_code;
    if (typeof c === "string") code = c;
    if (typeof e === "object" && typeof e?.type === "string") klass = e.type;
    requestId = requestId ?? (typeof e === "object" ? e?.request_id : undefined) ?? body?.request_id;
  } catch {
    /* not JSON */
  }
  const errorClass: ErrorClass = (ERROR_CLASSES as readonly string[]).includes(klass ?? "")
    ? (klass as ErrorClass)
    : classForStatus(res.status);
  const ra = Number(res.headers.get("retry-after"));
  return new GatewayError(scrub(message, cfg.apiKey), {
    status: res.status,
    requestId,
    hint,
    code,
    errorClass,
    retryAfter: Number.isFinite(ra) && ra > 0 ? ra : undefined,
  });
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

/**
 * The receipt of a call answered in one JSON body (`/embeddings`, `/search`).
 *
 * Those endpoints do not stream, so the price is in the `x-lobstack-*`
 * headers rather than a trailing frame. `x-lobstack-cost-usd` is an EMPTY
 * STRING when the call could not be priced; that is read as null, never 0.
 */
export interface HeaderReceipt {
  request_id: string | null;
  model: string | null;
  cost_usd: number | null;
  priced: boolean;
  metered: boolean | null;
  cache: string | null;
  mode: string | null;
  client_tag: string | null;
}

export function receiptFromHeaders(h: Headers): HeaderReceipt {
  const metered = h.get("x-lobstack-metered");
  return {
    request_id: h.get("x-lobstack-request-id"),
    model: h.get("x-lobstack-model"),
    cost_usd: numOrNull(h.get("x-lobstack-cost-usd")),
    priced: h.get("x-lobstack-priced") === "true",
    metered: metered === null ? null : metered === "true",
    cache: h.get("x-lobstack-cache"),
    mode: h.get("x-lobstack-mode"),
    client_tag: h.get("x-lobstack-client-tag"),
  };
}

/** The header the Gateway reads a client tag from. A tag set on the key itself wins over it. */
export const CLIENT_TAG_HEADER = "x-lobstack-client-tag";
