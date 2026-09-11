/**
 * The MCP server: four tools over the Lobstack Gateway.
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
 *                           serve it. No key. The only tool that works on a
 *                           fresh install, which makes it the one that shows
 *                           what the product does before anybody has signed up.
 *   lobstack_models         the catalogue, with per-token prices and tiers.
 *   lobstack_chat           the actual completion, and the receipt for it.
 *   lobstack_spend          the ledger over a range.
 *
 * Nothing here mints, rotates or reads API keys, and nothing accepts a base URL
 * as an argument. This process holds a live credential for as long as the MCP
 * client runs; the two ways that credential gets away from you are a tool that
 * can redirect it somewhere and a tool that can hand out another one. Neither
 * exists here.
 */

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type Config } from "./config.js";
import { chatInput, chatOutput, runChat } from "./tools/chat.js";
import { modelsInput, modelsOutput, runModels } from "./tools/models.js";
import { routePreviewInput, routePreviewOutput, runRoutePreview } from "./tools/route-preview.js";
import { spendInput, spendOutput, runSpend } from "./tools/spend.js";

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

const INSTRUCTIONS = `Lobstack is a metered LLM gateway: one key reaches every major model, and every call
comes back with a receipt saying which model served it and what it cost.

- lobstack_route_preview needs NO API key. It scores a prompt against the same
  router the paid path uses and reports the model that would serve it and the
  estimated cost. Use it to choose a model, or to show what routing does.
- lobstack_chat runs the completion. Send model "auto" to let the router pick
  the cheapest model that can handle the prompt.
- Costs are reported as the gateway priced them. A null cost means the gateway
  could not price the call — it does not mean the call was free.
- A saving labelled "saved" is like-for-like: the caller named a model and got
  something cheaper. A saving labelled "vs ceiling" is measured against the most
  expensive model the plan allows, which nobody asked for. Do not describe the
  second as if it were the first.`;

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
      title: "Preview routing and cost",
      description:
        "Score a prompt and report which model the Lobstack router would serve it with, and what that would cost. " +
        "Runs no inference, spends nothing, and NEEDS NO API KEY — use it to pick a model before calling lobstack_chat, " +
        "or to show what the gateway does on a machine with no key configured. Token counts are estimates; the billed " +
        "figure comes from the provider's usage block on the real call.",
      inputSchema: routePreviewInput,
      outputSchema: routePreviewOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => runRoutePreview(cfg, args),
  );

  server.registerTool(
    "lobstack_models",
    {
      title: "List gateway models",
      description:
        "The models the Lobstack Gateway serves, with capability tier, provider, context window and USD price per " +
        "million input and output tokens. A model the registry cannot price shows a null price, not zero.",
      inputSchema: modelsInput,
      outputSchema: modelsOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => runModels(cfg, args),
  );

  server.registerTool(
    "lobstack_chat",
    {
      title: "Chat through the gateway",
      description:
        "Send a prompt or conversation through the Lobstack Gateway and get the reply plus a receipt: the model that " +
        'actually served it, token counts, USD cost, and any saving with the reason it may be claimed. Model "auto" ' +
        "(the default) lets the router pick the cheapest model that can handle the prompt. This call spends money " +
        "against the configured key's allowance.",
      inputSchema: chatInput,
      outputSchema: chatOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => runChat(cfg, args),
  );

  server.registerTool(
    "lobstack_spend",
    {
      title: "Read spend and usage",
      description:
        "What this organization has spent through the gateway over a range, broken down by day, model, key or agent, " +
        "with request counts, tokens, error counts and latency percentiles. Requires an API key with the usage:read " +
        "scope. Reports how many requests could not be priced, because a total that includes them is a floor.",
      inputSchema: spendInput,
      outputSchema: spendOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => runSpend(cfg, args),
  );

  return server;
}
