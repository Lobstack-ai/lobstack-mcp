#!/usr/bin/env node
/**
 * The executable. Stdio transport, and nothing else.
 *
 * Two rules for a stdio MCP server, both easy to break by accident:
 *
 *   1. stdout is the protocol. Anything written to it that is not a JSON-RPC
 *      frame corrupts the session. Diagnostics go to stderr.
 *   2. the key is in the environment of this process. It is never printed, not
 *      at startup, not in a banner, not in an error. The startup line below
 *      says whether a key is present, which is the only part of it anybody
 *      needs to debug a config.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const server = createServer();
  await server.connect(new StdioServerTransport());

  process.stderr.write(
    `${SERVER_NAME} mcp ${SERVER_VERSION} · ${cfg.base.origin}` +
      `${cfg.base.corrected ? " (apex rewritten to www; a redirect would strip the key)" : ""}` +
      ` · key ${cfg.apiKey ? "configured" : "not set — lobstack_route_preview still works"}\n`,
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`lobstack-mcp failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
