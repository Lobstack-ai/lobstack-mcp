/**
 * lobstack_models — the catalogue, with prices.
 *
 * `GET /api/gateway/v1/models` is OpenAI-shaped with Lobstack extensions on
 * each row: `tier`, `context_window`, `price_per_mtok` and `managed`. It takes
 * no credential on lobstack.ai, and this tool sends one only if the server was
 * given one — a self-hosted deployment is entitled to put auth in front of it.
 *
 * A model whose price the registry does not know arrives with an empty or
 * partial `price_per_mtok`. It is rendered as "—", never as "$0": a catalogue
 * that shows an unpriced model as free teaches the reader that some of our
 * routing is free, which is the same lie as a $0.00 receipt one layer up.
 */

import { z } from "zod";
import { gatewayUrl } from "../config.js";
import type { Config } from "../config.js";
import { errorFrom, gwFetch } from "../gateway.js";
import { asMoney } from "../receipt.js";
import { baseNote, fromThrown, ok, type ToolResult } from "./shared.js";

const TIERS = ["nano", "small", "standard", "premium", "flagship"] as const;

export const modelsInput = {
  tier: z
    .enum(TIERS)
    .optional()
    .describe("Only models in this capability tier. Token Intelligence walks these from cheapest upward."),
  provider: z
    .string()
    .optional()
    .describe('Only models from this provider, e.g. "anthropic", "openai", "google".'),
};

const ModelRow = z.object({
  id: z.string(),
  label: z.string().nullable(),
  tier: z.string().nullable(),
  provider: z.string().nullable(),
  context_window: z.number().nullable(),
  input_usd_per_mtok: z.number().nullable().describe("Null when the registry cannot price this model."),
  output_usd_per_mtok: z.number().nullable(),
  managed: z.boolean().nullable(),
});

export const modelsOutput = {
  count: z.number(),
  unpriced_count: z.number().describe("Models the registry could not price. Their prices are null, not zero."),
  models: z.array(ModelRow),
};

interface RawModel {
  id?: string;
  label?: string;
  tier?: string;
  owned_by?: string;
  context_window?: number;
  price_per_mtok?: { input?: unknown; output?: unknown };
  managed?: boolean;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const priceCell = (v: number | null) => (v === null ? "—" : `$${v}`);

export async function runModels(cfg: Config, args: { tier?: string; provider?: string }): Promise<ToolResult> {
  try {
    const res = await gwFetch(cfg, gatewayUrl(cfg.base.origin, "/models"));
    if (!res.ok) throw await errorFrom(cfg, res);

    const body = (await res.json()) as { data?: RawModel[] };
    const all = (body.data ?? []).map((m) => ({
      id: String(m.id ?? ""),
      label: m.label ?? null,
      tier: m.tier ?? null,
      provider: m.owned_by ?? null,
      context_window: typeof m.context_window === "number" ? m.context_window : null,
      input_usd_per_mtok: asMoney(m.price_per_mtok?.input),
      output_usd_per_mtok: asMoney(m.price_per_mtok?.output),
      managed: typeof m.managed === "boolean" ? m.managed : null,
    }));

    const rows = all.filter(
      (m) =>
        (!args.tier || m.tier === args.tier) &&
        (!args.provider || (m.provider ?? "").toLowerCase() === args.provider.toLowerCase()),
    );

    const unpriced = rows.filter((m) => m.input_usd_per_mtok === null || m.output_usd_per_mtok === null).length;

    const w = Math.max(5, ...rows.map((m) => m.id.length));
    const lines = [
      `${pad("MODEL", w)}  ${pad("TIER", 9)}  ${pad("PROVIDER", 10)}  ${pad("IN/Mtok", 9)}  OUT/Mtok`,
      ...rows.map(
        (m) =>
          `${pad(m.id, w)}  ${pad(m.tier ?? "—", 9)}  ${pad(m.provider ?? "—", 10)}  ` +
          `${pad(priceCell(m.input_usd_per_mtok), 9)}  ${priceCell(m.output_usd_per_mtok)}`,
      ),
    ];

    const footer = [
      "",
      `${rows.length} model${rows.length === 1 ? "" : "s"}${rows.length !== all.length ? ` of ${all.length}` : ""}. ` +
        'Send model "auto" to lobstack_chat and the router picks one, then tells you which.',
      unpriced ? `${unpriced} of them carry no price in the registry; they are shown as — and are not free.` : null,
      baseNote(cfg),
    ]
      .filter((l) => l !== null)
      .join("\n");

    return ok([lines.join("\n") + "\n" + footer], {
      count: rows.length,
      unpriced_count: unpriced,
      models: rows,
    });
  } catch (e) {
    return fromThrown(cfg, e);
  }
}
