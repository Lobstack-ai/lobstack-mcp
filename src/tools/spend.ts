/**
 * lobstack_spend — what this organization has spent, over a range.
 *
 * `GET /api/v1/usage` is org-scoped and takes either a browser session or an
 * API key holding the `usage:read` scope. It is a sibling of the API prefix,
 * not under it, which is why the base URL here is kept as an origin and paths
 * are composed rather than concatenated onto the API base URL.
 *
 * ONE MONEY FIGURE, AND IT IS THE CONSOLE'S
 *
 * The endpoint returns two totals of the same quantity, from two tables:
 *
 *   spend.cost_usd     the priced ledger (`token_usage`) — what the allowance
 *                      is metered from, what invoices are cut from, and what
 *                      the Console's Spend figure shows.
 *   summary.cost_usd   the request trace's own copy of each price
 *                      (`gateway_requests`), kept for older callers.
 *
 * The two are written by separate statements and can disagree: a request the
 * trace recorded but the ledger lost is in the second and not the first, a
 * ledger row whose trace is missing is the other way round, and the unpriced
 * counts are taken over different rows. This tool used to print
 * `summary.cost_usd`, so it could quote a different total from the Console for
 * the same window. It now prints `spend.cost_usd`, and falls back to the trace
 * figure only when the ledger figure is null (the ledger could not be read) or
 * absent (an older deployment) — and says so in the output when it does.
 *
 * The same rule applies per group: `ledger_cost_usd` when it is there, the
 * trace's `cost_usd` only when it is not, as the Console's breakdown does.
 *
 * WHEN THE TOTAL IS A FLOOR
 *
 * Unpriced rows sum as zero, which is the only arithmetic available and not
 * the only truth: a total built partly from unpriced rows is a FLOOR. The
 * unpriced count is taken from the same table as the total it qualifies —
 * `spend.unpriced_rows` for the ledger, `summary.unpriced_requests` for the
 * trace. A read that hit the row cap (`truncated`) is a floor for a second,
 * independent reason.
 *
 * SAVINGS: TWO FIGURES, NEVER ONE
 *
 * The endpoint computes routing savings server-side from the priced ledger, as
 * a `savings` object split in two: `named` (a measured saving against a model
 * the caller asked for) and `plan_ceiling` (a counterfactual against the
 * priciest model the plan allows, when the caller sent `auto`). This tool
 * shows each one on its own line, labels `plan_ceiling` as a comparison rather
 * than a saving, and never adds them together. It never computes a saving
 * client-side from a copy of the rate card.
 */

import { z } from "zod";
import { apiUrl } from "../config.js";
import type { Config } from "../config.js";
import { errorFrom, gwFetch } from "../gateway.js";
import { money } from "../receipt.js";
import { baseNote, fromThrown, ok, requireKey, type ToolResult } from "./shared.js";

const RANGES = ["month", "7d", "14d", "30d", "90d"] as const;
const GROUPS = ["day", "model", "key", "agent"] as const;

export const spendInput = {
  range: z
    .enum(RANGES)
    .optional()
    .describe('How far back to look. "month" is the UTC calendar month to date, the Console\'s default window. Defaults to 7d.'),
  group_by: z.enum(GROUPS).optional().describe("How to break the total down. Defaults to model."),
};

const savingsBlock = z.object({
  requests: z.number(),
  served_cost_usd: z.number(),
  baseline_cost_usd: z.number(),
  difference_usd: z.number(),
  baseline_models: z.array(z.string()),
});

export const spendOutput = {
  enabled: z.boolean().describe("False when request tracing is not enabled on this deployment."),
  range: z.string(),
  group_by: z.string(),
  cost_usd: z
    .number()
    .nullable()
    .describe(
      "The spend total. The billing ledger's figure (spend.cost_usd), the same one the Console shows, unless " +
        "cost_source says otherwise. Null when neither figure is available.",
    ),
  cost_source: z
    .enum(["ledger", "trace"])
    .nullable()
    .describe(
      '"ledger" when cost_usd is the billing ledger\'s figure, as in the Console. "trace" when the ledger figure was ' +
        "null or not reported and cost_usd fell back to the request trace's legacy copy (summary.cost_usd), which " +
        "can differ from the Console.",
    ),
  spend: z
    .record(z.unknown())
    .nullable()
    .describe("The billing ledger's spend block as the API returned it. Null when the ledger could not be read."),
  summary: z
    .record(z.unknown())
    .nullable()
    .describe("Requests, errors, tokens and latency from the request trace. Its cost_usd is the legacy figure."),
  groups: z.array(z.record(z.unknown())),
  savings: z
    .object({
      named: savingsBlock.describe("Measured: requests that named a model and were routed to a cheaper one."),
      plan_ceiling: savingsBlock.describe(
        "A comparison, not a saving: auto requests against the priciest model the plan allows, which nobody asked for.",
      ),
      unpriced_routed_requests: z.number(),
    })
    .nullable()
    .describe("Routing savings from the ledger, as two separate figures. Never add them together. Null when not reported."),
  is_floor: z
    .boolean()
    .describe("True when some rows were unpriced or the row cap bound, so the totals are a lower bound, not a total."),
  message: z.string().nullable(),
};

interface SavingsBlock {
  requests?: number;
  served_cost_usd?: number;
  baseline_cost_usd?: number;
  difference_usd?: number;
  baseline_models?: string[];
}

interface UsageBody {
  enabled?: boolean;
  message?: string;
  range?: string;
  group_by?: string;
  summary?: {
    requests?: number;
    errors?: number;
    total_tokens?: number;
    /** The trace's copy of each price. Kept by the API for older callers. */
    cost_usd?: number;
    unpriced_requests?: number;
    p50_latency_ms?: number | null;
    p95_latency_ms?: number | null;
  } | null;
  /** The billing ledger. Absent on an older deployment; null when it could not be read. */
  spend?: {
    cost_usd?: number | null;
    managed_cost_usd?: number;
    byok_cost_usd?: number;
    rows?: number;
    unpriced_rows?: number;
    truncated?: boolean;
  } | null;
  savings?: {
    named?: SavingsBlock;
    plan_ceiling?: SavingsBlock;
    unpriced_routed_requests?: number;
  } | null;
  ledger?: { unmetered_requests?: number } | null;
  groups?: Array<{
    key?: string;
    requests?: number;
    cost_usd?: number;
    unpriced_requests?: number;
    total_tokens?: number;
    ledger_cost_usd?: number;
    ledger_unpriced_rows?: number;
  }>;
  truncated?: boolean;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const padStart = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A savings block as a complete, typed object, or null when it is not there. */
function block(b: SavingsBlock | undefined): Required<SavingsBlock> | null {
  if (!b || typeof b !== "object") return null;
  return {
    requests: isNum(b.requests) ? b.requests : 0,
    served_cost_usd: isNum(b.served_cost_usd) ? b.served_cost_usd : 0,
    baseline_cost_usd: isNum(b.baseline_cost_usd) ? b.baseline_cost_usd : 0,
    difference_usd: isNum(b.difference_usd) ? b.difference_usd : 0,
    baseline_models: Array.isArray(b.baseline_models) ? b.baseline_models.filter((m) => typeof m === "string") : [],
  };
}

/** The savings lines. Each figure on its own line; there is no line that adds them. */
function savingsLines(named: Required<SavingsBlock>, ceiling: Required<SavingsBlock>, unpriced: number): string[] {
  const against = (b: Required<SavingsBlock>, fallback: string) =>
    b.baseline_models.length ? b.baseline_models.join(", ") : fallback;
  const lines: string[] = [];
  if (named.requests > 0) {
    const d = named.difference_usd;
    lines.push(
      d < 0
        ? `Models you named: routing cost ${money(-d)} more on ${plural(named.requests, "request")} ` +
            `(${money(named.served_cost_usd)} instead of ${money(named.baseline_cost_usd)} on ${against(named, "the named models")}).`
        : `Saved on models you named: ${money(d)} on ${plural(named.requests, "request")} ` +
            `(${money(named.served_cost_usd)} instead of ${money(named.baseline_cost_usd)} on ${against(named, "the named models")}).`,
    );
  }
  if (ceiling.requests > 0) {
    lines.push(
      `Compared with the best model your plan allows: ${money(ceiling.difference_usd)} on ` +
        `${plural(ceiling.requests, "auto request")}. A comparison, not a saving: nothing was named, and ` +
        `${against(ceiling, "your plan's top model")} was not requested.`,
    );
  }
  if (unpriced > 0) {
    lines.push(`${plural(unpriced, "routed request")} carry a baseline that could not be priced and ${unpriced === 1 ? "is" : "are"} in neither figure.`);
  }
  return lines.length ? ["Routing savings (two separate figures, never added together):", ...lines.map((l) => `  ${l}`)] : [];
}

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
        cost_usd: null,
        cost_source: null,
        spend: null,
        summary: null,
        groups: [],
        savings: null,
        is_floor: false,
        message: b.message ?? null,
      });
    }

    const s = b.summary ?? {};
    const spend = b.spend && typeof b.spend === "object" ? b.spend : null;

    /*
     * The Console's figure, or the legacy one and a sentence saying so. The
     * unpriced count and its denominator always come from the same table as
     * the total they qualify.
     */
    const fromLedger = spend !== null && isNum(spend.cost_usd);
    const traceCost = isNum(s.cost_usd) ? s.cost_usd : null;
    const cost = fromLedger ? (spend.cost_usd as number) : traceCost;
    const costSource: "ledger" | "trace" | null = fromLedger ? "ledger" : traceCost !== null ? "trace" : null;
    const unpriced = fromLedger ? spend.unpriced_rows ?? 0 : s.unpriced_requests ?? 0;
    const truncated = b.truncated === true || (fromLedger && spend.truncated === true);
    const isFloor = unpriced > 0 || truncated;
    const groups = b.groups ?? [];

    /* As the Console renders it: a window in which no row carried a price has
       an unknown total, not a total of zero. */
    const priceable = fromLedger ? spend.rows ?? 0 : s.requests ?? 0;
    const costText =
      cost === null ? "spend unknown" : priceable > 0 && unpriced >= priceable ? "unpriced" : money(cost);
    const shown = b.range ?? range;
    const head =
      `${shown === "month" ? "This month (UTC)" : `Last ${shown}`}  ·  ${plural(s.requests ?? 0, "request")}  ·  ` +
      costText +
      (s.total_tokens ? `  ·  ${s.total_tokens.toLocaleString("en-US")} tokens` : "") +
      (s.errors ? `  ·  ${plural(s.errors, "error")}` : "");

    /* Per group, the same rule as the Console's breakdown: the ledger's spend
       when the group carries it, the trace's copy only when it does not. */
    const groupCost = (g: (typeof groups)[number]) => (isNum(g.ledger_cost_usd) ? g.ledger_cost_usd : isNum(g.cost_usd) ? g.cost_usd : null);
    const groupUnpriced = (g: (typeof groups)[number]) =>
      isNum(g.ledger_cost_usd) ? g.ledger_unpriced_rows ?? 0 : g.unpriced_requests ?? 0;

    const w = Math.max(3, ...groups.map((g) => String(g.key ?? "").length));
    const table = groups.length
      ? [
          "",
          `${pad(String(groupBy).toUpperCase(), w)}  ${padStart("REQS", 6)}  ${padStart("COST", 11)}`,
          ...groups.map((g) => {
            const u = groupUnpriced(g);
            return (
              `${pad(String(g.key ?? ""), w)}  ${padStart(String(g.requests ?? 0), 6)}  ` +
              `${padStart(money(groupCost(g)), 11)}` +
              (u ? `  (${u} unpriced)` : "")
            );
          }),
        ].join("\n")
      : "\nNo requests in this window.";

    const named = block(b.savings?.named);
    const ceiling = block(b.savings?.plan_ceiling);
    const savings =
      named && ceiling
        ? {
            named,
            plan_ceiling: ceiling,
            unpriced_routed_requests: isNum(b.savings?.unpriced_routed_requests) ? b.savings.unpriced_routed_requests : 0,
          }
        : null;

    const unmetered = b.ledger?.unmetered_requests ?? 0;

    const notes = [
      !fromLedger
        ? spend === null && "spend" in b
          ? "The billing ledger could not be read, so this total is the request trace's copy of each price (the legacy summary.cost_usd). It can differ from the Console's Spend."
          : "This deployment does not report the billing ledger's spend, so this total is the request trace's copy of each price (the legacy summary.cost_usd). It can differ from the Console's Spend."
        : null,
      fromLedger && (spend.byok_cost_usd ?? 0) > 0
        ? `${money(spend.managed_cost_usd ?? 0)} billed by Lobstack · ${money(spend.byok_cost_usd ?? 0)} on your own provider key.`
        : null,
      unpriced
        ? `${plural(unpriced, fromLedger ? "row" : "request")} could not be priced. Those sum as zero, so the total above is a floor, not a total.`
        : null,
      truncated ? "The row cap bound on this range, so older requests are not counted here." : null,
      fromLedger && unmetered > 0
        ? `${plural(unmetered, "served request")} ${unmetered === 1 ? "has" : "have"} no billing ledger row, so ${unmetered === 1 ? "it is" : "they are"} not in this total.`
        : null,
      typeof s.p95_latency_ms === "number" ? `p50 ${s.p50_latency_ms ?? "—"}ms · p95 ${s.p95_latency_ms}ms` : null,
      baseNote(cfg),
    ].filter((n): n is string => typeof n === "string");

    const saved = savings ? savingsLines(savings.named, savings.plan_ceiling, savings.unpriced_routed_requests) : [];

    return ok([head + table + (saved.length ? "\n\n" + saved.join("\n") : "") + (notes.length ? "\n\n" + notes.join("\n") : "")], {
      enabled: true,
      range: b.range ?? range,
      group_by: b.group_by ?? groupBy,
      cost_usd: cost,
      cost_source: costSource,
      spend: (spend ?? null) as Record<string, unknown> | null,
      summary: (b.summary ?? null) as Record<string, unknown> | null,
      groups: groups as Array<Record<string, unknown>>,
      savings,
      is_floor: isFloor,
      message: null,
    });
  } catch (e) {
    return fromThrown(cfg, e);
  }
}
