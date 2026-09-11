/**
 * The receipt, and the two rules about rendering one.
 *
 * These rules are not local style. They are the same rules as
 * `cli/src/render.mjs` in the platform repo, and the reason there is one copy
 * per client rather than one copy per renderer is that a rule about overstating
 * savings drifts the moment it is restated.
 */

/** `baseline_reason` as the Gateway sends it. See `src/lib/gateway/stream.ts`. */
export type BaselineReason = "named" | "plan_ceiling";

export interface Receipt {
  request_id: string | null;
  served_model: string | null;
  requested_model: string | null;
  routed: boolean | null;
  /** Null, never 0, for a call the Gateway could not price. */
  cost_usd: number | null;
  savings_usd: number | null;
  priced: boolean;
  baseline_model: string | null;
  /** Missing is treated as unnamed. Never as the flattering case. */
  baseline_reason: BaselineReason | null;
  baseline_cost_usd: number | null;
}

/**
 * A number, or null. Never a zero standing in for "we do not know".
 *
 * `cost_usd: null` means the Gateway could not price the call. A real zero —
 * a request that produced no billable tokens — is a different fact and is kept
 * as a zero. Collapsing the two is the bug this whole module exists to prevent.
 */
export function asMoney(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // A JSON number that arrived as a string still prices; "" and null do not.
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Format money for a human.
 *
 * "unpriced" for null, never "$0.00". That exact substitution ran for three
 * months in production and wrote off real charges as free.
 */
export function money(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "unpriced";
  return n >= 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(6)}`;
}

/** Coerce whatever came off the trailing frame into a receipt, or null. */
export function parseReceipt(raw: unknown): Receipt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const reason = r.baseline_reason;
  return {
    request_id: typeof r.request_id === "string" ? r.request_id : null,
    served_model: typeof r.served_model === "string" ? r.served_model : null,
    requested_model: typeof r.requested_model === "string" ? r.requested_model : null,
    routed: typeof r.routed === "boolean" ? r.routed : null,
    cost_usd: asMoney(r.cost_usd),
    savings_usd: asMoney(r.savings_usd),
    // `priced` is an assertion the seller makes. Absent, assume nothing: a
    // receipt with no price is not a priced receipt.
    priced: r.priced === true,
    baseline_model: typeof r.baseline_model === "string" ? r.baseline_model : null,
    baseline_reason: reason === "named" || reason === "plan_ceiling" ? reason : null,
    baseline_cost_usd: asMoney(r.baseline_cost_usd),
  };
}

export interface Savings {
  label: string;
  named: boolean;
  amount: number;
  baseline_model: string | null;
  baseline_reason: BaselineReason | null;
}

/**
 * Whether a saving may be called a saving, in one place.
 *
 * `baseline_reason` decides.
 *
 *   "named"        the caller asked for a model and got something cheaper. A
 *                  like-for-like comparison, and the only case that may be
 *                  labelled `saved`.
 *   "plan_ceiling" the caller sent `auto`, so the Gateway measured against the
 *                  most expensive model their plan allows. Real, and not
 *                  something anybody asked for: `vs ceiling`.
 *   missing        treated as unnamed. A receipt that does not say where its
 *                  baseline came from does not get the flattering reading.
 *
 * Matches `savingsLabel()` in `cli/src/render.mjs` exactly.
 */
export function savingsLabel(receipt: Receipt | null): Savings | null {
  const amount = receipt?.savings_usd;
  if (typeof amount !== "number" || !(amount > 0)) return null;
  const named = receipt?.baseline_reason === "named";
  return {
    label: named ? "saved" : "vs ceiling",
    named,
    amount,
    baseline_model: receipt?.baseline_model ?? null,
    baseline_reason: receipt?.baseline_reason ?? null,
  };
}

export interface ReceiptLineInput {
  receipt: Receipt | null;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
  /** The model the stream frames named, when the receipt did not. */
  model?: string | null;
  /** Parameters the Gateway dropped, from `x-lobstack-dropped-params`. */
  droppedParams?: string[];
}

/**
 * The receipt as a human reads it: one line, then whatever needs saying.
 *
 * This is returned as its own content block, separate from the answer, for the
 * same reason the CLI writes it to stderr — so the thing you asked for and the
 * thing it cost do not end up concatenated in whatever consumes the answer.
 */
export function describeReceipt({ receipt, usage, model, droppedParams }: ReceiptLineInput): string {
  const served = receipt?.served_model || model || "unknown";
  const parts: string[] = [`model ${served}`];

  if (receipt?.requested_model && receipt.routed) parts.push(`asked ${receipt.requested_model}`);
  if (usage) parts.push(`tokens ${usage.prompt_tokens}/${usage.completion_tokens}`);
  parts.push(`cost ${money(receipt?.cost_usd ?? null)}`);

  const saving = savingsLabel(receipt);
  if (saving) parts.push(`${saving.label} ${money(saving.amount)}`);

  const lines = [`— ${parts.join("  ·  ")}`];

  if (saving && !saving.named && saving.baseline_reason === "plan_ceiling" && saving.baseline_model) {
    lines.push(
      `  measured against ${saving.baseline_model}, the priciest model your plan allows — you sent auto, not that model`,
    );
  }
  if (receipt && !receipt.priced) {
    lines.push("  the gateway could not price this model, so no cost is claimed");
  }
  if (!receipt) {
    lines.push("  no receipt on this response — the endpoint did not send one");
  }
  if (droppedParams?.length) {
    lines.push(`  the served model does not accept ${droppedParams.join(", ")}; it was dropped`);
  }
  if (receipt?.request_id) lines.push(`  request ${receipt.request_id}`);

  return lines.join("\n");
}
