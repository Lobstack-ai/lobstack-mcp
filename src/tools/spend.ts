/**
 * lobstack_spend — what this organization has spent, over a range.
 *
 * `GET /api/v1/usage` is org-scoped and takes either a browser session or an
 * API key holding the `usage:read` scope. It is a sibling of the gateway
 * prefix, not under it, which is why the base URL here is kept as an origin
 * and paths are composed rather than concatenated onto a gateway URL.
 *
 * TWO THINGS THIS TOOL REPORTS THAT THE ENDPOINT BURIES
 *
 * `unpriced_requests` — rows the meter could not price. The endpoint's
 * `cost_usd` sums a NULL as zero, which is the only arithmetic available and
 * not the only truth: a total built partly from unpriced rows is a FLOOR. A
 * reader not told how many were unpriced reads it as exact, which is the same
 * mistake as a $0.00 receipt, one aggregation up.
 *
 * `truncated` — the endpoint pages to a cap. When it binds, the sums are a
 * floor for a second, independent reason.
 *
 * WHAT THIS TOOL DOES NOT REPORT
 *
 * A savings total. `/api/v1/usage` does not compute one — its summary carries
 * requests, tokens, cost, error rate and latency percentiles, and nothing else.
 * Adding up per-call savings client-side would require the baselines, which are
 * not in this response, and printing a number derived from a rate card we hold
 * a copy of is the failure mode this whole product argues against. Savings are
 * reported per call, by lobstack_chat, where the Gateway sends them with the
 * reason attached.
 */

import { z } from "zod";
import { apiUrl } from "../config.js";
import type { Config } from "../config.js";
import { errorFrom, gwFetch } from "../gateway.js";
import { money } from "../receipt.js";
import { baseNote, fromThrown, ok, requireKey, type ToolResult } from "./shared.js";

const RANGES = ["7d", "14d", "30d", "90d"] as const;
const GROUPS = ["day", "model", "key", "agent"] as const;

export const spendInput = {
  range: z.enum(RANGES).optional().describe("How far back to look. Defaults to 7d."),
  group_by: z.enum(GROUPS).optional().describe("How to break the total down. Defaults to model."),
};

export const spendOutput = {
  enabled: z.boolean().describe("False when request tracing is not enabled on this deployment."),
  range: z.string(),
  group_by: z.string(),
  summary: z.record(z.unknown()).nullable(),
  groups: z.array(z.record(z.unknown())),
  is_floor: z
    .boolean()
    .describe("True when some rows were unpriced or the row cap bound, so the totals are a lower bound, not a total."),
  message: z.string().nullable(),
};

interface UsageBody {
  enabled?: boolean;
  message?: string;
  range?: string;
  group_by?: string;
  summary?: {
    requests?: number;
    errors?: number;
    total_tokens?: number;
    cost_usd?: number;
    unpriced_requests?: number;
    p50_latency_ms?: number | null;
    p95_latency_ms?: number | null;
  } | null;
  groups?: Array<{ key?: string; requests?: number; cost_usd?: number; unpriced_requests?: number; total_tokens?: number }>;
  truncated?: boolean;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const padStart = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

export async function runSpend(cfg: Config, args: { range?: string; group_by?: string }): Promise<ToolResult> {
  const missing = requireKey(cfg);
  if (missing) return missing;

  const range = args.range ?? "7d";
  const groupBy = args.group_by ?? "model";

  try {
    const res = await gwFetch(
      cfg,
      `${apiUrl(cfg.base.origin, "/v1/usage")}?range=${encodeURIComponent(range)}&group_by=${encodeURIComponent(groupBy)}`,
    );
    if (!res.ok) {
      throw await errorFrom(
        cfg,
        res,
        res.status === 403
          ? 'This key needs the "usage:read" scope. Mint one in Console → API keys; a key with only "inference" can spend but cannot read the ledger.'
          : undefined,
      );
    }

    const b = (await res.json()) as UsageBody;

    if (b.enabled === false) {
      // Not an error. "Tracing is not on here" and "you spent nothing" are
      // different sentences and only the first one is true.
      return ok([b.message ?? "Request tracing is not enabled on this deployment, so there is nothing to report."], {
        enabled: false,
        range,
        group_by: groupBy,
        summary: null,
        groups: [],
        is_floor: false,
        message: b.message ?? null,
      });
    }

    const s = b.summary ?? {};
    const unpriced = s.unpriced_requests ?? 0;
    const truncated = b.truncated === true;
    const isFloor = unpriced > 0 || truncated;
    const groups = b.groups ?? [];

    const head =
      `Last ${b.range ?? range}  ·  ${s.requests ?? 0} request${s.requests === 1 ? "" : "s"}  ·  ` +
      `${money(typeof s.cost_usd === "number" ? s.cost_usd : null)}` +
      (s.total_tokens ? `  ·  ${s.total_tokens.toLocaleString("en-US")} tokens` : "") +
      (s.errors ? `  ·  ${s.errors} error${s.errors === 1 ? "" : "s"}` : "");

    const w = Math.max(3, ...groups.map((g) => String(g.key ?? "").length));
    const table = groups.length
      ? [
          "",
          `${pad(String(groupBy).toUpperCase(), w)}  ${padStart("REQS", 6)}  ${padStart("COST", 11)}`,
          ...groups.map(
            (g) =>
              `${pad(String(g.key ?? ""), w)}  ${padStart(String(g.requests ?? 0), 6)}  ` +
              `${padStart(money(typeof g.cost_usd === "number" ? g.cost_usd : null), 11)}` +
              (g.unpriced_requests ? `  (${g.unpriced_requests} unpriced)` : ""),
          ),
        ].join("\n")
      : "\nNo requests in this window.";

    const notes = [
      unpriced
        ? `${unpriced} request${unpriced === 1 ? "" : "s"} could not be priced. Those rows sum as zero, so the total above is a floor, not a total.`
        : null,
      truncated ? "The row cap bound on this range, so older requests are not counted here." : null,
      typeof s.p95_latency_ms === "number" ? `p50 ${s.p50_latency_ms ?? "—"}ms · p95 ${s.p95_latency_ms}ms` : null,
      baseNote(cfg),
    ].filter((n) => n !== null);

    return ok([head + table + (notes.length ? "\n\n" + notes.join("\n") : "")], {
      enabled: true,
      range: b.range ?? range,
      group_by: b.group_by ?? groupBy,
      summary: (b.summary ?? null) as Record<string, unknown> | null,
      groups: groups as Array<Record<string, unknown>>,
      is_floor: isFloor,
      message: null,
    });
  } catch (e) {
    return fromThrown(cfg, e);
  }
}
