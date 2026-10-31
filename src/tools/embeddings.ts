/**
 * lobstack_embeddings — vectors for text, and what they cost.
 *
 * `POST /api/gateway/v1/embeddings` is OpenAI-shaped and is NOT routed: the
 * model is the one named, or text-embedding-3-small for `auto` and for nothing,
 * because vectors from different models are not comparable and choosing per
 * request would corrupt the caller's index. OpenAI models only, today.
 *
 * It answers in one JSON body, so the receipt is in the `x-lobstack-*`
 * headers, not a stream frame. An empty `x-lobstack-cost-usd` means the call
 * could not be priced and is reported as null, never as zero.
 *
 * Inputs are capped lower here than the API's 2,048: every vector comes back
 * into the agent's context, and 2,048 × 3,072 floats is not something an agent
 * can read. A caller indexing a corpus should use the HTTP API directly.
 */

import { z } from "zod";
import { gatewayUrl } from "../config.js";
import type { Config } from "../config.js";
import { errorFrom, gwFetch, quotaFromHeaders, describeQuota, receiptFromHeaders } from "../gateway.js";
import { money } from "../receipt.js";
import { baseNote, failure, fromThrown, ok, requireKey, type ToolResult } from "./shared.js";
import { clientTagArg, tagHeaders } from "./client-tag.js";

/** The embedding models the API serves (src/lib/gateway/embeddings.ts in the platform). */
export const EMBEDDING_MODELS = ["text-embedding-3-small", "text-embedding-3-large"] as const;
const NATIVE_DIMENSIONS: Record<string, number> = { "text-embedding-3-small": 1536, "text-embedding-3-large": 3072 };
export const MCP_MAX_EMBEDDING_INPUTS = 64;

export const embeddingsInput = {
  input: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(MCP_MAX_EMBEDDING_INPUTS)])
    .describe(
      `The text to embed: one non-empty string, or an array of 1–${MCP_MAX_EMBEDDING_INPUTS} non-empty strings ` +
        '(each embedded separately, returned in the same order). Example: "Why did the deploy roll back?" or ' +
        '["refund policy", "shipping times"]. Billed on input tokens, so longer text costs more.',
    ),
  model: z
    .enum(["auto", ...EMBEDDING_MODELS])
    .optional()
    .describe(
      'Embedding model. "text-embedding-3-small" (default; 1536 dimensions, cheapest) or "text-embedding-3-large" ' +
        '(3072 dimensions, higher quality, a higher per-token price; lobstack_models with type "embedding" lists both rates). "auto" means text-embedding-3-small — there is no ' +
        "routing for embeddings. Use the SAME model for every vector you intend to compare. Chat model ids are refused.",
    ),
  dimensions: z
    .number()
    .int()
    .positive()
    .max(3072)
    .optional()
    .describe(
      "Optional: shorten each vector to this many dimensions (integer ≥ 1, at most 1536 for the small model and 3072 " +
        "for the large). Default: the model's full length. Does not change the price.",
    ),
  client_tag: clientTagArg,
};

export const embeddingsOutput = {
  model: z.string().nullable().describe("The embedding model that produced the vectors."),
  dimensions: z.number().nullable().describe("Length of each vector."),
  count: z.number().describe("How many vectors came back; equals the number of inputs."),
  embeddings: z
    .array(z.array(z.number()))
    .describe("One vector per input, in input order. Compare with cosine similarity; only against vectors from the same model."),
  usage: z
    .object({ prompt_tokens: z.number(), total_tokens: z.number() })
    .nullable()
    .describe("Input tokens billed. Embeddings have no output tokens."),
  receipt: z
    .object({
      request_id: z.string().nullable(),
      cost_usd: z.number().nullable().describe("USD charged. NULL — never 0 — when the API could not price the call."),
      cost_display: z.string().describe('Human form; "unpriced" when cost_usd is null.'),
      priced: z.boolean(),
      metered: z.boolean().nullable().describe("True when the ledger row was written."),
    })
    .describe("Read from the x-lobstack-* response headers."),
  quota: z.record(z.unknown()).nullable().describe("Allowance remaining after this call, as the API reported it."),
};

interface EmbeddingsBody {
  data?: Array<{ index?: number; embedding?: unknown }>;
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

export async function runEmbeddings(
  cfg: Config,
  args: { input: string | string[]; model?: string; dimensions?: number; client_tag?: string },
): Promise<ToolResult> {
  const missing = requireKey(cfg);
  if (missing) return missing;

  const modelKey = !args.model || args.model === "auto" ? "text-embedding-3-small" : args.model;
  const native = NATIVE_DIMENSIONS[modelKey];
  if (args.dimensions !== undefined && native !== undefined && args.dimensions > native) {
    return failure(cfg, `dimensions must be at most ${native} for "${modelKey}".`);
  }

  try {
    const res = await gwFetch(cfg, gatewayUrl(cfg.base.origin, "/embeddings"), {
      method: "POST",
      headers: tagHeaders(args.client_tag),
      body: JSON.stringify({
        input: args.input,
        ...(args.model ? { model: args.model } : {}),
        ...(args.dimensions !== undefined ? { dimensions: args.dimensions } : {}),
      }),
    });
    if (!res.ok) throw await errorFrom(cfg, res);

    const receipt = receiptFromHeaders(res.headers);
    const quota = quotaFromHeaders(res.headers);
    const b = (await res.json()) as EmbeddingsBody;
    const rows = [...(b.data ?? [])].sort((x, y) => (x.index ?? 0) - (y.index ?? 0));
    const vectors = rows.map((r) => (Array.isArray(r.embedding) ? (r.embedding as unknown[]).map(Number) : []));
    const dims = vectors[0]?.length ?? null;
    const usage =
      b.usage && typeof b.usage.prompt_tokens === "number"
        ? { prompt_tokens: b.usage.prompt_tokens, total_tokens: b.usage.total_tokens ?? b.usage.prompt_tokens }
        : null;
    const model = receipt.model ?? b.model ?? modelKey;

    const lines = [
      `${vectors.length} vector${vectors.length === 1 ? "" : "s"} of ${dims ?? "?"} dimensions from ${model}.`,
      vectors[0]?.length ? `  first: [${vectors[0].slice(0, 4).map((v) => v.toFixed(4)).join(", ")}, …] (full vectors in the structured result)` : null,
      `— cost ${money(receipt.cost_usd)}${usage ? `  ·  ${usage.prompt_tokens} input tokens` : ""}`,
      receipt.cost_usd === null ? "  the Lobstack API could not price this call, so no cost is claimed" : null,
      receipt.request_id ? `  request ${receipt.request_id}` : null,
      describeQuota(quota),
      baseNote(cfg),
    ]
      .filter((l): l is string => typeof l === "string")
      .join("\n");

    return ok([lines], {
      model,
      dimensions: dims,
      count: vectors.length,
      embeddings: vectors,
      usage,
      receipt: {
        request_id: receipt.request_id,
        cost_usd: receipt.cost_usd,
        cost_display: money(receipt.cost_usd),
        priced: receipt.priced,
        metered: receipt.metered,
      },
      quota: quota ? (quota as unknown as Record<string, unknown>) : null,
    });
  } catch (e) {
    return fromThrown(cfg, e);
  }
}
