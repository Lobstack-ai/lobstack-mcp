/**
 * The MCP server: six tools over the Lobstack API.
 *
 * Exported as a factory rather than wired straight to stdio so the tests can
 * drive it over an in-memory transport with a real MCP client on the other end,
 * against a fake gateway speaking real HTTP. What breaks in a thing like this
 * is at the seams — a frame split by the network, a receipt read off the wrong
 * field, a redirect quietly eating the key — and none of that shows up when you
 * call your own parser with a string you wrote.
 *
 * THE TOOL SET, AND WHY IT IS THIS ONE
 *
 *   lobstack_route_preview  scores a prompt and names the model that would
 *                           serve it. No key, no cost. The step before chat.
 *   lobstack_models         the catalogue, chat and embedding, with prices.
 *   lobstack_chat           a completion, and the receipt for it. Spends.
 *   lobstack_embeddings     vectors for text, and the receipt. Spends.
 *   lobstack_web_search     web results, priced per search. Spends.
 *   lobstack_spend          the billing ledger over a range, as the Console
 *                           shows it, with routing savings split in two.
 *
 * Every tool maps to an endpoint the platform serves today: /route-preview,
 * /models, /chat/completions, /embeddings and /search under /api/gateway/v1,
 * and /api/v1/usage. There is no key-introspection endpoint a key can call, so
 * there is no whoami tool; the allowance rides on every spending call's
 * headers (`quota`) and on lobstack_spend's `credit`.
 *
 * Nothing here mints, rotates or reads API keys, and nothing accepts a base URL
 * as an argument. This process holds a live credential for as long as the MCP
 * client runs; the two ways that credential gets away from you are a tool that
 * can redirect it somewhere and a tool that can hand out another one. Neither
 * exists here. Key management stays in the Console.
 */

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type Config } from "./config.js";
import { chatInput, chatOutput, runChat } from "./tools/chat.js";
import { modelsInput, modelsOutput, runModels } from "./tools/models.js";
import { routePreviewInput, routePreviewOutput, runRoutePreview } from "./tools/route-preview.js";
import { spendInput, spendOutput, runSpend } from "./tools/spend.js";
import { embeddingsInput, embeddingsOutput, runEmbeddings } from "./tools/embeddings.js";
import { searchInput, searchOutput, runSearch } from "./tools/search.js";

export const SERVER_NAME = "lobstack";

/**
 * Read from package.json, not typed here.
 *
 * This is the version the server announces over MCP `initialize`, and it was a
 * literal sitting beside a `version` field in the manifest — two places to bump
 * and one to forget. `npm version` writes the manifest and nothing else, so a
 * release would have shipped announcing the previous version to every client.
 */
export const SERVER_VERSION: string = ((): string => {
  try {
    return (
      JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { version?: string }
    ).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const INSTRUCTIONS = `The Lobstack API is a metered LLM gateway: one key reaches chat models from Anthropic, OpenAI,
Google and xAI, plus embeddings and web search, and every call comes back with a receipt saying
which model served it and what it cost.

How to use these tools:
- Before a lobstack_chat call that matters for cost, call lobstack_route_preview with the same
  prompt. It is free, needs no API key, and returns the model the router would serve and the
  estimated USD cost.
- lobstack_models lists valid model ids and per-million-token prices. Call it when you need an id
  or a price, not before every chat.
- lobstack_chat, lobstack_embeddings and lobstack_web_search spend money from the key's allowance.
  Call them once per need; do not retry a 402. lobstack_route_preview, lobstack_models and
  lobstack_spend spend nothing.
- lobstack_spend reads what the organization has already spent (needs the usage:read scope).
- A null cost means the API could not price the call. It does not mean the call was free.
- A saving labelled "saved" is like-for-like: the caller named a model and got something
  cheaper. "vs ceiling" is measured against the most expensive model the plan allows, which
  nobody asked for. Do not describe the second as if it were the first.
- Results stream from the API but arrive here as one message: an MCP tool result cannot be
  delivered in parts, so there is no streaming switch.`;

export interface CreateServerOptions {
  /** Overrides LOBSTACK_BASE_URL. Process configuration; never a tool argument. */
  baseUrl?: string | null;
  /** Overrides LOBSTACK_API_KEY. */
  apiKey?: string | null;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const cfg: Config = loadConfig(options);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "lobstack_route_preview",
    {
      title: "Preview routing and cost (free, no key)",
      description:
        "Estimate which model the Lobstack router (Nex 1) would serve a prompt with, and what it would cost, WITHOUT " +
        "running it. Free: runs no inference, writes nothing, and needs NO API key. Use it BEFORE lobstack_chat to check " +
        "the cost or the chosen model, to compare against a named model (requested_model), or to demonstrate routing on " +
        "a machine with no key. Use lobstack_models instead to list every model and price; use lobstack_chat to actually " +
        "get an answer. Output: served_model (the id to pin in lobstack_chat if you want it), tier and reason, " +
        "estimated_cost_usd (null = unpriceable, not free), and baseline (only when you named a model and the router " +
        "would serve a cheaper one: that model's cost and the saving). Token counts are ~4 characters per token " +
        "estimates; the bill comes from the real call's usage. Rate-limited to ten previews a minute per IP address.",
      inputSchema: routePreviewInput,
      outputSchema: routePreviewOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => runRoutePreview(cfg, args),
  );

  server.registerTool(
    "lobstack_models",
    {
      title: "List models and prices",
      description:
        "List the model ids the Lobstack API serves, with type (chat or embedding), capability tier " +
        "(nano < small < standard < premium < flagship), provider (anthropic, openai, google, xai), context window, and " +
        "USD per million input and output tokens. Read-only and free; works without a key on www.lobstack.ai. Use it " +
        "when you need a valid `model` id for lobstack_chat or lobstack_embeddings, or a per-token price. Use " +
        "lobstack_route_preview instead to learn which model a specific prompt would get and what it would cost; use " +
        "lobstack_spend for money already spent. The first row is `auto` (Nex 1, the router): its price is null because " +
        "it costs whatever model it routes to. Any other null price means the registry cannot price that model — not " +
        "that it is free. Filter with type, tier and provider.",
      inputSchema: modelsInput,
      outputSchema: modelsOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => runModels(cfg, args),
  );

  server.registerTool(
    "lobstack_chat",
    {
      title: "Chat completion (spends money)",
      description:
        "Send a prompt or conversation to a chat model through the Lobstack API and get the reply plus a receipt. " +
        "COSTS MONEY: every call is billed on input and output tokens against the API key's allowance; it is not " +
        "idempotent, so a repeat is billed again. Requires LOBSTACK_API_KEY with the inference scope. " +
        "Before calling it, use lobstack_route_preview with the same prompt to see the model and estimated cost for free, " +
        "and lobstack_models if you need a model id. Use lobstack_embeddings for vectors and lobstack_web_search for " +
        'web results instead. With model "auto" (default), Nex 1 picks the cheapest model that can handle the prompt. ' +
        "Output: text (the reply), model.served (who answered), usage (tokens), receipt.cost_usd (USD charged; null " +
        'means unpriced, never free), receipt.savings (label "saved" only when you named a model and got a cheaper one; ' +
        '"vs ceiling" is a comparison against the priciest model your plan allows, not a saving), quota (allowance left), ' +
        "and dropped_params. Errors name their class (auth, quota, validation, provider, timeout, internal) and whether a " +
        "retry can help; a 402 means the allowance or a budget is spent — do not retry it.",
      inputSchema: chatInput,
      outputSchema: chatOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => runChat(cfg, args),
  );

  server.registerTool(
    "lobstack_embeddings",
    {
      title: "Embed text (spends money)",
      description:
        "Turn text into embedding vectors through the Lobstack API (OpenAI text-embedding-3-small or -large), for " +
        "semantic search, clustering or similarity. COSTS MONEY: billed on input tokens against the key's allowance " +
        "(small is the cheaper model; lobstack_models with type \"embedding\" lists both rates). Requires " +
        "LOBSTACK_API_KEY with the inference scope. Not routed: the model is the one you name, so vectors stay comparable; " +
        "always compare vectors from the same model. Use lobstack_chat for generated text and lobstack_web_search to find " +
        "pages. Output: embeddings (one float vector per input, in order), dimensions, usage.prompt_tokens, and a receipt " +
        "with cost_usd (null = unpriced, not free). Up to 64 inputs per call; vectors are returned in full, so keep " +
        "batches small.",
      inputSchema: embeddingsInput,
      outputSchema: embeddingsOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => runEmbeddings(cfg, args),
  );

  server.registerTool(
    "lobstack_web_search",
    {
      title: "Search the web (spends money)",
      description:
        "Search the web through the Lobstack API (Brave Search's index) and get ranked results with title, URL and a " +
        "plain-text snippet. COSTS MONEY: priced per search, not per result or token — Brave's published price " +
        "($0.005 a search when last checked) inside the plan's included usage, and that times the Lobstack rate past it; " +
        "see https://www.lobstack.ai/docs/gateway/search. The same query and count within ten minutes may be served " +
        "from cache for free (receipt.cache \"hit\"). Requires LOBSTACK_API_KEY with the inference scope. Use it when an " +
        "answer needs current information from the web; use lobstack_chat to reason over results and cite each `url` " +
        "you rely on. On a 402 or 503 the search will not run on Lobstack: use another search tool and do not retry in " +
        "a loop. On a 429, retry once after the stated wait.",
      inputSchema: searchInput,
      outputSchema: searchOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => runSearch(cfg, args),
  );

  server.registerTool(
    "lobstack_spend",
    {
      title: "Read spend and usage (read-only)",
      description:
        "Report what this organization has already spent through the Lobstack API over a window, broken down by day, " +
        "model, key, agent, provider, mode, client tag or app. Read-only and free. Requires LOBSTACK_API_KEY with the " +
        "usage:read scope (a key with only inference gets a 403). Use it for budget monitoring (how much is left this " +
        "month, which model or key is driving cost) and cost attribution (spend per client tag or per agent). Use " +
        "lobstack_route_preview for the cost of a call you have not made, and the receipt on lobstack_chat for the cost " +
        "of one you just made. How to read it: cost_usd is the billing ledger's total, the same figure as the Console's " +
        'Spend (cost_source "ledger"; "trace" means a fallback that can differ). is_floor true means the real total is ' +
        "at least cost_usd because some rows were unpriced or the row cap bound: report it as \"at least\". savings has " +
        "two figures that must never be added: named (measured, against models you asked for) and plan_ceiling (a " +
        "comparison for auto requests, not a saving). credit shows allowance credit left on spend-metered plans.",
      inputSchema: spendInput,
      outputSchema: spendOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => runSpend(cfg, args),
  );

  return server;
}
