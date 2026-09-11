/**
 * lobstack_chat — one completion, and what it cost.
 *
 * WHY THIS STREAMS WHEN NOTHING IS STREAMED TO
 *
 * An MCP tool result is a single message; there is no partial delivery to an
 * agent mid-call. So the whole answer is accumulated here before it is
 * returned, and `stream: true` looks pointless.
 *
 * It is not. On the buffered path the Gateway reports the price in response
 * HEADERS, and on the streamed path it reports it in the trailing SSE frame as
 * `x_lobstack`. The frame is the better source: the streaming path meters
 * *before* emitting that frame, so the figure is the ledger's, not an estimate,
 * and it arrives as one structured object rather than eight headers, three of
 * which encode "unpriced" as an empty string. Requesting SSE and reading it to
 * the end is how this tool returns a receipt it did not compute itself.
 *
 * `stream_options.include_usage` is not optional: without it the Gateway has no
 * trailing frame to attach `x_lobstack` to, and the price never arrives.
 */

import { z } from "zod";
import { gatewayUrl } from "../config.js";
import type { Config } from "../config.js";
import { gwFetch, errorFrom, quotaFromHeaders, describeQuota } from "../gateway.js";
import { consume } from "../sse.js";
import { describeReceipt, money, parseReceipt, savingsLabel } from "../receipt.js";
import { baseNote, droppedParams, failure, fromThrown, ok, requireKey, type ToolResult } from "./shared.js";

const Message = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

export const chatInput = {
  prompt: z
    .string()
    .min(1)
    .optional()
    .describe("A single user message. Use this or `messages`, not both."),
  messages: z
    .array(Message)
    .min(1)
    .optional()
    .describe("A full conversation, OpenAI-shaped. Use this or `prompt`, not both."),
  model: z
    .string()
    .optional()
    .describe(
      'Lobstack model key, e.g. "claude-sonnet-5". Defaults to "auto", which lets Token Intelligence pick the cheapest model that can handle the prompt. lobstack_models lists the keys.',
    ),
  system: z.string().optional().describe("System prompt, prepended to the conversation."),
  max_tokens: z.number().int().positive().max(200_000).optional().describe("Cap on the reply length."),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe("Sampling temperature. Some served models do not accept it; the receipt says when it was dropped."),
};

export const chatOutput = {
  text: z.string().describe("The assistant's reply."),
  model: z.object({
    requested: z.string().nullable(),
    served: z.string().nullable().describe("The model that actually answered."),
    routed: z.boolean().nullable().describe("True when the served model differs from the one requested."),
  }),
  usage: z
    .object({ prompt_tokens: z.number(), completion_tokens: z.number(), total_tokens: z.number() })
    .nullable(),
  receipt: z
    .object({
      request_id: z.string().nullable(),
      cost_usd: z
        .number()
        .nullable()
        .describe("USD the caller owes. NULL — never 0 — when the gateway could not price the call."),
      cost_display: z.string().describe('Human form. "unpriced" when cost_usd is null.'),
      priced: z.boolean(),
      savings: z
        .object({
          amount_usd: z.number(),
          label: z.string().describe('"saved" for a like-for-like comparison, "vs ceiling" otherwise.'),
          named: z
            .boolean()
            .describe("True only when the caller asked for baseline_model and got something cheaper."),
          baseline_model: z.string().nullable(),
          baseline_reason: z.string().nullable(),
        })
        .nullable(),
    })
    .nullable()
    .describe("Null when the endpoint sent no receipt at all."),
  quota: z.record(z.unknown()).nullable().describe("Allowance remaining, as the gateway reported it."),
  dropped_params: z.array(z.string()),
};

type ChatArgs = {
  prompt?: string;
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model?: string;
  system?: string;
  max_tokens?: number;
  temperature?: number;
};

export async function runChat(cfg: Config, args: ChatArgs): Promise<ToolResult> {
  const missing = requireKey(cfg);
  if (missing) return missing;

  if (!args.prompt && !args.messages?.length) {
    return failure(cfg, "Give either `prompt` (a single message) or `messages` (a conversation).");
  }
  if (args.prompt && args.messages?.length) {
    return failure(cfg, "Give either `prompt` or `messages`, not both — it is ambiguous which one to send.");
  }

  const messages = [
    ...(args.system ? [{ role: "system" as const, content: args.system }] : []),
    ...(args.messages ?? [{ role: "user" as const, content: args.prompt as string }]),
  ];
  const requestedModel = args.model?.trim() || "auto";

  try {
    const res = await gwFetch(cfg, gatewayUrl(cfg.base.origin, "/chat/completions"), {
      method: "POST",
      body: JSON.stringify({
        model: requestedModel,
        messages,
        stream: true,
        // Without this there is no trailing frame, and so no price.
        stream_options: { include_usage: true },
        ...(args.max_tokens !== undefined ? { max_tokens: args.max_tokens } : {}),
        ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
      }),
    });

    if (!res.ok || !res.body) {
      throw await errorFrom(
        cfg,
        res,
        res.status === 402
          ? "The allowance on this key is exhausted. Top up or wait for the reset in Console → Billing."
          : res.status === 403
            ? 'This key needs the "inference" scope. Mint one in Console → API keys.'
            : undefined,
      );
    }

    const quota = quotaFromHeaders(res.headers);
    const dropped = droppedParams(res.headers);
    const stream = await consume(res.body);
    const receipt = parseReceipt(stream.receipt);
    const saving = savingsLabel(receipt);

    const structured = {
      text: stream.text,
      model: {
        requested: receipt?.requested_model ?? requestedModel,
        served: receipt?.served_model ?? stream.model,
        routed: receipt?.routed ?? null,
      },
      usage: stream.usage,
      receipt: receipt
        ? {
            request_id: receipt.request_id,
            // Null stays null all the way out. A consumer that wants a number
            // has to decide for itself what "we could not price this" means.
            cost_usd: receipt.cost_usd,
            cost_display: money(receipt.cost_usd),
            priced: receipt.priced,
            savings: saving
              ? {
                  amount_usd: saving.amount,
                  label: saving.label,
                  named: saving.named,
                  baseline_model: saving.baseline_model,
                  baseline_reason: saving.baseline_reason,
                }
              : null,
          }
        : null,
      quota: quota ? (quota as unknown as Record<string, unknown>) : null,
      dropped_params: dropped,
    };

    // Two blocks, not one. The answer is the thing that was asked for; the
    // receipt is a fact about the call. Concatenating them puts a price line
    // into whatever consumes the answer — the same reason the CLI puts the
    // receipt on stderr.
    const receiptBlock = [
      describeReceipt({ receipt, usage: stream.usage, model: stream.model, droppedParams: dropped }),
      describeQuota(quota),
      baseNote(cfg),
    ]
      .filter(Boolean)
      .join("\n");

    return ok([stream.text, receiptBlock], structured);
  } catch (e) {
    return fromThrown(cfg, e);
  }
}
