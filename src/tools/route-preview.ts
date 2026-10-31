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

/** Plan ids the endpoint accepts (PLANS in the platform's src/lib/pricing.ts, plus the legacy tiers). */
export const PLAN_TIERS = [
  "free",
  "byok",
  "developer",
  "studio",
  "scale",
  "appsumo_1",
  "appsumo_2",
  "appsumo_3",
  "starter",
  "pro",
  "performance",
  "enterprise",
] as const;

export const routePreviewInput = {
  prompt: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      "The exact prompt you are about to send to lobstack_chat, 1–8000 characters. Scored by the router's complexity " +
        "heuristic; never sent to a model and never stored.",
    ),
  requested_model: z
    .string()
    .optional()
    .describe(
      'A chat model id from lobstack_models to compare against, e.g. "claude-opus-5-5". Default "auto" (let the router ' +
        "choose; no baseline is reported). When you name a model and the router would serve a cheaper one, `baseline` " +
        "shows that model's estimated cost and the difference. An unknown id is a 400.",
    ),
  plan_tier: z
    .enum(PLAN_TIERS)
    .optional()
    .describe(
      'Plan id whose ceiling bounds which tiers the router may reach, e.g. "free", "developer", "studio", "scale". ' +
        'Default "pro". Use the plan the real key is on, or the preview can name a model the key cannot get.',
    ),
  expected_output_tokens: z
    .number()
    .int()
    .positive()
    .max(200_000)
    .optional()
    .describe(
      "Expected reply length in tokens, integer 1–200000, used only for the cost estimate. Default: half the prompt's " +
        "estimated tokens, minimum 64. Pass the max_tokens you will send to lobstack_chat for a worst-case figure.",
    ),
  conversation_length: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("How many messages are already in the conversation, integer ≥ 0. Default 0. Longer conversations score as more complex."),
};

export const routePreviewOutput = {
  requested_model: z.string().describe('What the preview compared against; "auto" when nothing was named.'),
  served_model: z.string().describe("The model this prompt would be served by. Pass it as `model` to lobstack_chat to pin it."),
  served_label: z.string().nullable(),
  provider: z.string().nullable(),
  tier: z.string().nullable(),
  complexity: z.number().nullable().describe("The router's complexity score for the prompt; higher reaches higher tiers."),
  routed: z.boolean().nullable().describe("True when the router would serve something other than what was requested."),
  reason: z.string().nullable().describe("The router's one-line reason for the tier it chose."),
  estimated_cost_usd: z.number().nullable().describe("Null when the registry cannot price the model."),
  estimated_cost_display: z.string(),
  token_estimate: z
    .record(z.unknown())
    .nullable()
    .describe("input and output token estimates (~4 characters per token) and how they were made. Estimates, not counts."),
  baseline: z
    .object({
      model: z.string(),
      label: z.string().nullable(),
      cost_usd: z.number().nullable(),
      saving_usd: z.number().nullable(),
    })
    .nullable()
    .describe('Only present when a model was named and the router moved away from it — the "named" case.'),
  managed_key_configured: z
    .boolean()
    .nullable()
    .describe("False when this deployment has no Lobstack key for the served model's provider, so a real call may route elsewhere."),
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
