/**
 * lobstack_route_preview — where a prompt would go, and what it would cost,
 * without spending a token and without a key.
 *
 * `POST /api/gateway/v1/route-preview` is unauthenticated on purpose: it runs
 * no inference, calls no provider, writes nothing and reads no per-user state.
 * It runs the same `selectModel()` and the same price registry the paid path
 * uses, so the answer is the decision rather than a simulation of it.
 *
 * This tool therefore sends NO Authorization header — `anonymous: true` below.
 * That is not an oversight, it is the point: an MCP client with this server
 * installed and no key at all can still answer "which model would this go to
 * and what would it cost", which is the whole product visible before anybody
 * signs up.
 *
 * Two honesty constraints carried over from the endpoint.
 *
 * Token counts are ESTIMATES — roughly four characters per token, with output
 * assumed at half the prompt unless the caller says otherwise. The response
 * says so in `token_estimate.estimated` and so does the text here. The billed
 * figure always comes from the provider's own usage block on the real call.
 *
 * `baseline` exists only when the caller named a model and the router went
 * somewhere else. On "auto" it is null, because there is no model anybody asked
 * for to compare against, and inventing one — against the flagship, say — is
 * how every savings claim in this category gets manufactured.
 */

import { z } from "zod";
import { gatewayUrl } from "../config.js";
import type { Config } from "../config.js";
import { errorFrom, gwFetch } from "../gateway.js";
import { asMoney, money } from "../receipt.js";
import { baseNote, fromThrown, ok, type ToolResult } from "./shared.js";

export const routePreviewInput = {
  prompt: z.string().min(1).max(8000).describe("The prompt to score. Scored, never sent to a model."),
  requested_model: z
    .string()
    .optional()
    .describe('A model key to compare against, e.g. "claude-opus-5". Defaults to "auto".'),
  plan_tier: z
    .string()
    .optional()
    .describe("Plan id, which sets the ceiling the router may reach. Defaults to the pro ceiling."),
  expected_output_tokens: z
    .number()
    .int()
    .positive()
    .max(200_000)
    .optional()
    .describe("How long the reply is expected to be. Defaults to half the prompt, which is the common chat ratio."),
  conversation_length: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Messages already in the conversation; it feeds the complexity score."),
};

export const routePreviewOutput = {
  requested_model: z.string(),
  served_model: z.string().describe("The model this prompt would actually be routed to."),
  served_label: z.string().nullable(),
  provider: z.string().nullable(),
  tier: z.string().nullable(),
  complexity: z.number().nullable(),
  routed: z.boolean().nullable().describe("True when the router would serve something other than what was requested."),
  reason: z.string().nullable(),
  estimated_cost_usd: z.number().nullable().describe("Null when the registry cannot price the model."),
  estimated_cost_display: z.string(),
  token_estimate: z.record(z.unknown()).nullable(),
  baseline: z
    .object({
      model: z.string(),
      label: z.string().nullable(),
      cost_usd: z.number().nullable(),
      saving_usd: z.number().nullable(),
    })
    .nullable()
    .describe('Only present when a model was named and the router moved away from it — the "named" case.'),
  managed_key_configured: z.boolean().nullable(),
  estimated: z.literal(true).describe("Always true. These are estimates, not a bill."),
};

interface PreviewBody {
  requested_model?: string;
  tier?: string;
  complexity?: number;
  routed?: boolean;
  reason?: string;
  model?: {
    key?: string;
    label?: string;
    provider?: string;
    context_window?: number;
    price_per_mtok?: { input?: number; output?: number };
    managed_key_configured?: boolean;
  };
  token_estimate?: Record<string, unknown>;
  cost_usd?: unknown;
  baseline?: { model?: string; label?: string; cost_usd?: unknown; saving_usd?: unknown } | null;
  note?: string;
}

export async function runRoutePreview(
  cfg: Config,
  args: {
    prompt: string;
    requested_model?: string;
    plan_tier?: string;
    expected_output_tokens?: number;
    conversation_length?: number;
  },
): Promise<ToolResult> {
  try {
    const res = await gwFetch(cfg, gatewayUrl(cfg.base.origin, "/route-preview"), {
      method: "POST",
      // No credential. This endpoint needs none, and sending one anyway would
      // turn a public demonstration into an authenticated call for no reason.
      anonymous: true,
      body: JSON.stringify({
        prompt: args.prompt,
        ...(args.requested_model ? { requested_model: args.requested_model } : {}),
        ...(args.plan_tier ? { plan_tier: args.plan_tier } : {}),
        ...(args.expected_output_tokens ? { expected_output_tokens: args.expected_output_tokens } : {}),
        ...(args.conversation_length !== undefined ? { conversation_length: args.conversation_length } : {}),
      }),
    });
    if (!res.ok) throw await errorFrom(cfg, res);

    const b = (await res.json()) as PreviewBody;
    const cost = asMoney(b.cost_usd);
    const served = b.model?.key ?? "unknown";
    const baselineCost = asMoney(b.baseline?.cost_usd);
    const baselineSaving = asMoney(b.baseline?.saving_usd);

    const structured = {
      requested_model: b.requested_model ?? args.requested_model ?? "auto",
      served_model: served,
      served_label: b.model?.label ?? null,
      provider: b.model?.provider ?? null,
      tier: b.tier ?? null,
      complexity: typeof b.complexity === "number" ? b.complexity : null,
      routed: typeof b.routed === "boolean" ? b.routed : null,
      reason: b.reason ?? null,
      estimated_cost_usd: cost,
      estimated_cost_display: money(cost),
      token_estimate: b.token_estimate ?? null,
      baseline: b.baseline?.model
        ? {
            model: b.baseline.model,
            label: b.baseline.label ?? null,
            cost_usd: baselineCost,
            saving_usd: baselineSaving,
          }
        : null,
      managed_key_configured: b.model?.managed_key_configured ?? null,
      estimated: true as const,
    };

    const est = b.token_estimate as { input?: number; output?: number; method?: string } | undefined;
    const lines = [
      `This prompt would be served by ${served}${b.model?.label ? ` (${b.model.label})` : ""}` +
        `${b.tier ? `, ${b.tier} tier` : ""}${b.model?.provider ? `, via ${b.model.provider}` : ""}.`,
      b.reason ? `  why: ${b.reason}${typeof b.complexity === "number" ? ` (complexity ${b.complexity})` : ""}` : null,
      `  estimated cost ${money(cost)}` +
        (est?.input !== undefined ? ` on ~${est.input} in / ~${est.output} out tokens` : ""),
      // A saving is only ever quoted here for a model the caller named. The
      // endpoint returns null on "auto" for exactly that reason.
      structured.baseline && baselineSaving !== null && baselineSaving > 0
        ? `  ${money(baselineSaving)} cheaper than ${structured.baseline.model}, which you named` +
          (baselineCost !== null ? ` and which would have cost ${money(baselineCost)}` : "")
        : null,
      b.model?.managed_key_configured === false
        ? `  note: no managed provider key for ${b.model?.provider ?? "this provider"} is configured on this deployment, so a real call may route elsewhere`
        : null,
      "",
      `  Estimated, not billed. ${est?.method ? `Tokens: ${est.method}. ` : ""}` +
        "The charged figure comes from the provider's own usage block on the real request.",
      "  This preview needs no API key.",
      baseNote(cfg),
    ]
      .filter((l) => l !== null)
      .join("\n");

    return ok([lines], structured);
  } catch (e) {
    return fromThrown(cfg, e);
  }
}
