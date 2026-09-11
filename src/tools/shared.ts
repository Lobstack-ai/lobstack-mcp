/**
 * Turning a failure into something an agent can act on.
 *
 * Every tool in this repo answers a failure the same way: `isError: true` with
 * a sentence and, where there is one, a next step. Not a thrown McpError —
 * a protocol-level error tells the client the call was malformed, which is a
 * different claim from "your key lacks a scope", and clients surface the two
 * very differently.
 *
 * Everything that goes through here is scrubbed. The key is in this process's
 * environment and nowhere else; it must not turn up in a tool result, which is
 * transcript, which is context, which is somewhere it will be read.
 */

import { ConfigError, scrub, type Config } from "../config.js";
import { GatewayError } from "../gateway.js";
import { StreamError } from "../sse.js";

export interface ToolResult {
  /** The SDK's CallToolResult is open-ended; this keeps us assignable to it. */
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export const text = (...blocks: Array<string | null | undefined>): Array<{ type: "text"; text: string }> =>
  blocks.filter((b): b is string => typeof b === "string" && b.length > 0).map((t) => ({ type: "text" as const, text: t }));

export function ok(blocks: Array<string | null | undefined>, structured: Record<string, unknown>): ToolResult {
  return { content: text(...blocks), structuredContent: structured };
}

export function failure(cfg: Config, message: string, hint?: string): ToolResult {
  const body = hint ? `${scrub(message, cfg.apiKey)}\n\n${scrub(hint, cfg.apiKey)}` : scrub(message, cfg.apiKey);
  return { content: text(body), isError: true };
}

/** The message for a tool that needs a credential and has not been given one. */
export function requireKey(cfg: Config): ToolResult | null {
  if (cfg.apiKey) return null;
  return failure(
    cfg,
    "No Lobstack API key is configured, so this call cannot be made.",
    "Set LOBSTACK_API_KEY in this server's environment (mint a key in Console → API keys) and restart the MCP client. " +
      "lobstack_route_preview needs no key and works right now.",
  );
}

/** Turn any thrown thing into a tool result, with the key removed. */
export function fromThrown(cfg: Config, e: unknown): ToolResult {
  if (e instanceof GatewayError) {
    const hints: string[] = [];
    if (e.hint) hints.push(e.hint);
    if (e.status === 401) {
      hints.push(
        cfg.keyShapeUnrecognised
          ? "LOBSTACK_API_KEY is set but is not shaped like a Lobstack API key (lsk_live_… or lsk_test_…). Check it was copied whole."
          : "The key was rejected. It may have been revoked or have expired; mint a new one in Console → API keys.",
      );
    }
    if (e.requestId) hints.push(`Gateway request id: ${e.requestId}`);
    return failure(cfg, e.message, hints.join("\n"));
  }
  if (e instanceof ConfigError) return failure(cfg, e.message, e.hint);
  if (e instanceof StreamError) {
    return failure(cfg, `the gateway failed part-way through the answer: ${e.message}`);
  }
  return failure(cfg, e instanceof Error ? e.message : String(e));
}

/** `x-lobstack-dropped-params`, split. Empty when the header is absent. */
export function droppedParams(h: Headers): string[] {
  const raw = h.get("x-lobstack-dropped-params");
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/** A note about the apex rewrite, wherever a base URL was used. */
export function baseNote(cfg: Config): string | null {
  return cfg.base.corrected
    ? `  note: the bare apex lobstack.ai redirects and would strip your key; ${cfg.base.origin} was used instead`
    : null;
}
