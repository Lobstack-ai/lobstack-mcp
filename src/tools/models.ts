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

const TIERS = ["router", "nano", "small", "standard", "premium", "flagship"] as const;
const PROVIDERS = ["lobstack", "anthropic", "openai", "google", "xai"] as const;

export const modelsInput = {
  type: z
    .enum(["chat", "embedding"])
    .optional()
    .describe(
      'Only chat models (for lobstack_chat) or only embedding models (for lobstack_embeddings). Default: both, chat ' +
        "models first, embedding models last.",
    ),
  tier: z
    .enum(TIERS)
    .optional()
    .describe(
      'Only chat models in this capability tier, cheapest to most capable: "nano", "small", "standard", "premium", ' +
        '"flagship". "router" is the single `auto` entry (Nex 1), which has no price of its own. Embedding models have no tier.',
    ),
  provider: z
    .enum(PROVIDERS)
    .optional()
    .describe(
      'Only models from this provider: "anthropic", "openai", "google" or "xai". "lobstack" selects the `auto` router entry.',
    ),
};

const ModelRow = z.object({
  id: z.string().describe("The value to pass as `model` to lobstack_chat or lobstack_embeddings."),
  type: z.enum(["chat", "embedding"]).describe("Which tool takes this id."),
  label: z.string().nullable(),
  tier: z.string().nullable().describe('Capability tier for chat models; "router" for auto; null for embedding models.'),
  provider: z.string().nullable(),
  context_window: z.number().nullable().describe("Max input tokens (chat). For auto, the smallest window any routed model offers."),
  dimensions: z.number().nullable().describe("Native vector length (embedding models only)."),
  input_usd_per_mtok: z
    .number()
    .nullable()
    .describe("USD per million input tokens. Null for auto (it costs whatever it routes to) and for a model the registry cannot price — never read null as free."),
  output_usd_per_mtok: z.number().nullable().describe("USD per million output tokens. 0 for embedding models, which have no output."),
  managed: z.boolean().nullable().describe("True when Lobstack's own provider key can serve it."),
});

export const modelsOutput = {
  count: z.number().describe("Rows returned after filtering."),
  unpriced_count: z
    .number()
    .describe("Rows other than auto that the registry could not price. Their prices are null, not zero."),
  models: z.array(ModelRow),
};

interface RawModel {
  id?: string;
  type?: string;
  dimensions?: number;
  label?: string;
  tier?: string;
  owned_by?: string;
  context_window?: number;
  price_per_mtok?: { input?: unknown; output?: unknown };
  managed?: boolean;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const priceCell = (v: number | null) => (v === null ? "—" : `$${v}`);

export async function runModels(
  cfg: Config,
  args: { type?: "chat" | "embedding"; tier?: string; provider?: string },
): Promise<ToolResult> {
  try {
    const res = await gwFetch(cfg, gatewayUrl(cfg.base.origin, "/models"));
    if (!res.ok) throw await errorFrom(cfg, res);

    const body = (await res.json()) as { data?: RawModel[] };
    const all = (body.data ?? []).map((m) => ({
      id: String(m.id ?? ""),
      type: (m.type === "embedding" ? "embedding" : "chat") as "chat" | "embedding",
      label: m.label ?? null,
      tier: m.tier ?? null,
      provider: m.owned_by ?? null,
      context_window: typeof m.context_window === "number" ? m.context_window : null,
      dimensions: typeof m.dimensions === "number" ? m.dimensions : null,
      input_usd_per_mtok: asMoney(m.price_per_mtok?.input),
      output_usd_per_mtok: asMoney(m.price_per_mtok?.output),
      managed: typeof m.managed === "boolean" ? m.managed : null,
    }));

    const rows = all.filter(
      (m) =>
        (!args.type || m.type === args.type) &&
        (!args.tier || m.tier === args.tier) &&
        (!args.provider || (m.provider ?? "").toLowerCase() === args.provider.toLowerCase()),
    );

    // `auto` has no price by design, not by omission: it is not counted as a gap.
    const unpriced = rows.filter(
      (m) => m.tier !== "router" && (m.input_usd_per_mtok === null || m.output_usd_per_mtok === null),
    ).length;

    const w = Math.max(5, ...rows.map((m) => m.id.length));
    const lines = [
      `${pad("MODEL", w)}  ${pad("TIER", 9)}  ${pad("PROVIDER", 10)}  ${pad("IN/Mtok", 9)}  OUT/Mtok`,
      ...rows.map(
        (m) =>
          `${pad(m.id, w)}  ${pad(m.type === "embedding" ? "embedding" : m.tier ?? "—", 9)}  ${pad(m.provider ?? "—", 10)}  ` +
          `${pad(priceCell(m.input_usd_per_mtok), 9)}  ${priceCell(m.output_usd_per_mtok)}`,
      ),
    ];

    const footer = [
      "",
      `${rows.length} model${rows.length === 1 ? "" : "s"}${rows.length !== all.length ? ` of ${all.length}` : ""}. ` +
        'Send model "auto" to lobstack_chat and Nex 1, the router, picks one and the receipt names it. ' +
        "Prices are USD per million tokens; embedding rows are for lobstack_embeddings.",
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
