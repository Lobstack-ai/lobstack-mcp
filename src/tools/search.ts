/**
 * lobstack_web_search — web results through the Lobstack API, priced per search.
 *
 * `POST /api/gateway/v1/search` takes `{ query, count? }` and answers
 * `{ query, results: [{ title, url, snippet }] }`. Results come from the Brave
 * Search API's own index on Lobstack's key, so every search is billed as a
 * managed call, per search rather than per token, whatever engine the key's
 * agent uses for models. The receipt is in the `x-lobstack-*` headers.
 *
 * The same query and count from the same payer within ten minutes may be
 * answered from a short cache: `x-lobstack-cache: hit`, cost 0, no ledger row.
 *
 * THE FALLBACK CONTRACT. A 402 or 503 means this search will not run on
 * Lobstack right now; the agent should use another search and not retry in a
 * loop. A 429 is worth one retry after Retry-After. Both are said in the
 * error text, because an agent reads that and not this comment.
 */

import { z } from "zod";
import { gatewayUrl } from "../config.js";
import type { Config } from "../config.js";
import { errorFrom, gwFetch, quotaFromHeaders, describeQuota, receiptFromHeaders } from "../gateway.js";
import { money } from "../receipt.js";
import { baseNote, fromThrown, ok, requireKey, type ToolResult } from "./shared.js";
import { clientTagArg, tagHeaders } from "./client-tag.js";

export const searchInput = {
  query: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .describe(
      'What to search the web for, 1–400 characters after trimming, e.g. "Next.js 16 middleware deprecation". ' +
        "Sent only to the search provider; Lobstack logs its length, not its text.",
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("How many results to return, integer 1–10. Default 5. Fewer may come back. The price is per search, not per result."),
  client_tag: clientTagArg,
};

export const searchOutput = {
  query: z.string().describe("The query as the API ran it."),
  count: z.number().describe("How many results came back."),
  results: z
    .array(z.object({ title: z.string(), url: z.string(), snippet: z.string() }))
    .describe("Ranked results. Snippets are plain text. Cite `url` when an answer relies on a result."),
  receipt: z
    .object({
      request_id: z.string().nullable(),
      cost_usd: z
        .number()
        .nullable()
        .describe("USD charged for this search. 0 on a cache hit. NULL — never 0 — when the API could not price it."),
      cost_display: z.string(),
      priced: z.boolean(),
      cache: z.string().nullable().describe('"hit" (served from the 10-minute cache, free) or "miss" (a fresh, billed search).'),
    })
    .describe("Read from the x-lobstack-* response headers."),
  quota: z.record(z.unknown()).nullable().describe("Allowance remaining after this call, as the API reported it."),
};

interface SearchBody {
  query?: string;
  results?: Array<{ title?: unknown; url?: unknown; snippet?: unknown }>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export async function runSearch(
  cfg: Config,
  args: { query: string; count?: number; client_tag?: string },
): Promise<ToolResult> {
  const missing = requireKey(cfg);
  if (missing) return missing;

  try {
    const res = await gwFetch(cfg, gatewayUrl(cfg.base.origin, "/search"), {
      method: "POST",
      headers: tagHeaders(args.client_tag),
      body: JSON.stringify({ query: args.query, ...(args.count !== undefined ? { count: args.count } : {}) }),
    });
    if (!res.ok) {
      throw await errorFrom(
        cfg,
        res,
        res.status === 402 || res.status === 503
          ? "Web search will not run on Lobstack right now. Use another search tool if one is available; do not retry this in a loop."
          : undefined,
      );
    }

    const receipt = receiptFromHeaders(res.headers);
    const quota = quotaFromHeaders(res.headers);
    const b = (await res.json()) as SearchBody;
    const results = (b.results ?? []).map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.snippet) }));

    const lines = [
      ...(results.length
        ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
        : ["No results."]),
      "",
      `— web-search  ·  ${results.length} result${results.length === 1 ? "" : "s"}  ·  cost ${money(receipt.cost_usd)}` +
        (receipt.cache ? `  ·  cache ${receipt.cache}` : ""),
      receipt.cost_usd === null ? "  the Lobstack API could not price this call, so no cost is claimed" : null,
      receipt.request_id ? `  request ${receipt.request_id}` : null,
      describeQuota(quota),
      baseNote(cfg),
    ]
      .filter((l): l is string => typeof l === "string")
      .join("\n");

    return ok([lines], {
      query: b.query ?? args.query,
      count: results.length,
      results,
      receipt: {
        request_id: receipt.request_id,
        cost_usd: receipt.cost_usd,
        cost_display: money(receipt.cost_usd),
        priced: receipt.priced,
        cache: receipt.cache,
      },
      quota: quota ? (quota as unknown as Record<string, unknown>) : null,
    });
  } catch (e) {
    return fromThrown(cfg, e);
  }
}
