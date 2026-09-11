# @lobstack/mcp

An MCP server for the [Lobstack](https://www.lobstack.ai) Gateway. One API key
reaches every major model, and every call comes back with a receipt: which model
served it, how many tokens, what it cost.

Works in Claude Desktop, Claude Code, Cursor, Zed, or anything else that speaks
the Model Context Protocol over stdio.

## Try it without a key

`lobstack_route_preview` is unauthenticated. Install the server with no
credential at all and an agent can still ask "which model would this prompt go
to, and what would it cost":

```
npx -y @lobstack/mcp
```

Add it to your client using one of the blocks below, leave `env` out, and ask:

> Preview how Lobstack would route: "summarise this changelog into three bullets"

The other three tools need a key, minted in Console → API keys.

## Install

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "lobstack": {
      "command": "npx",
      "args": ["-y", "@lobstack/mcp"],
      "env": {
        "LOBSTACK_API_KEY": "lsk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

Restart Claude Desktop. The four `lobstack_*` tools appear under the tools menu.

### Cursor

`~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` for one:

```json
{
  "mcpServers": {
    "lobstack": {
      "command": "npx",
      "args": ["-y", "@lobstack/mcp"],
      "env": {
        "LOBSTACK_API_KEY": "lsk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add lobstack --env LOBSTACK_API_KEY=lsk_live_... -- npx -y @lobstack/mcp
```

### Zed

In `settings.json`, under `context_servers`:

```json
{
  "context_servers": {
    "lobstack": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "@lobstack/mcp"],
      "env": {
        "LOBSTACK_API_KEY": "lsk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

## Tools

### `lobstack_route_preview`

Scores a prompt against the same router the paid path uses and reports the model
that would serve it, the capability tier, the complexity score, and the
estimated cost. Runs no inference and spends nothing. **Needs no API key.**

| argument | type | notes |
| --- | --- | --- |
| `prompt` | string, required | Scored, never sent to a model. Max 8000 characters. |
| `requested_model` | string | A model to compare against. Defaults to `auto`. |
| `plan_tier` | string | Plan id, which sets the ceiling the router may reach. |
| `expected_output_tokens` | integer | Defaults to half the prompt. |
| `conversation_length` | integer | Messages already in the conversation. |

Token counts are estimates — roughly four characters per token. The billed
figure always comes from the provider's own usage block on the real request, and
the tool says so in every answer.

A `baseline` is returned only when you named a model and the router moved away
from it. On `auto` it is `null`: there is no model you asked for to compare
against.

### `lobstack_models`

The catalogue: model key, label, tier, provider, context window, and USD per
million input and output tokens. Optional `tier` and `provider` filters.

A model the registry cannot price comes back with `null` prices and renders as
`—`. It is not free.

### `lobstack_chat`

Sends a prompt or a conversation and returns the reply plus the receipt.

| argument | type | notes |
| --- | --- | --- |
| `prompt` | string | A single user message. Use this **or** `messages`. |
| `messages` | array | `{ role, content }`, OpenAI-shaped. Use this **or** `prompt`. |
| `model` | string | Defaults to `auto` — the router picks the cheapest capable model. |
| `system` | string | Prepended to the conversation. |
| `max_tokens` | integer | Cap on the reply. |
| `temperature` | number | Some models do not accept it; the receipt says when it was dropped. |

The reply and the receipt come back as two separate content blocks, so whatever
consumes the answer does not get a price line concatenated onto it. The
structured result carries:

```json
{
  "text": "...",
  "model": { "requested": "claude-opus-5", "served": "claude-haiku-4-5", "routed": true },
  "usage": { "prompt_tokens": 400, "completion_tokens": 140, "total_tokens": 540 },
  "receipt": {
    "request_id": "req_...",
    "cost_usd": 0.0011,
    "cost_display": "$0.001100",
    "priced": true,
    "savings": {
      "amount_usd": 0.0044,
      "label": "saved",
      "named": true,
      "baseline_model": "claude-opus-5",
      "baseline_reason": "named"
    }
  },
  "quota": { "meter": "spend", "remaining_usd": 16.75 },
  "dropped_params": []
}
```

### `lobstack_spend`

What the organization has spent over `7d`, `14d`, `30d` or `90d`, grouped by
`day`, `model`, `key` or `agent`, with request counts, tokens, errors and
latency percentiles. Requires a key holding the `usage:read` scope.

It also reports `unpriced_requests` and sets `is_floor`. The endpoint sums an
unpriced row as zero — the only arithmetic available — so a total that includes
one is a lower bound, not a total, and this tool says which.

It does **not** report a savings total. `/api/v1/usage` does not compute one,
and adding up savings client-side would mean pricing the org's tokens against a
copy of the rate card. Savings are reported per call, by `lobstack_chat`, where
the gateway sends them with the reason attached.

## Two rules about the numbers

**A null cost is not zero.** `cost_usd: null` means the gateway could not price
the call. It renders as `unpriced`, never as `$0.00`. Rendering it as `$0.00`
writes off a real charge, and that exact substitution ran for three months in
production.

**`baseline_reason` decides what a saving may be called.**

- `named` — you asked for a model and got something cheaper. Like-for-like, and
  the only case labelled `saved`.
- `plan_ceiling` — you sent `auto`, so the comparison is against the most
  expensive model your plan allows. Real, and not something you asked for:
  labelled `vs ceiling`, with the baseline model named next to it.
- missing — treated as unnamed. A receipt that does not say where its baseline
  came from does not get the flattering reading.

## Configuration

| variable | default | notes |
| --- | --- | --- |
| `LOBSTACK_API_KEY` | none | Read once at startup. Never logged, never in a tool result. |
| `LOBSTACK_BASE_URL` | `https://www.lobstack.ai/api/gateway/v1` | For staging and self-hosted deployments. |

**Use `www`, not the bare apex.** `lobstack.ai` redirects to `www.lobstack.ai`,
and [RFC 9110 §15.4](https://www.rfc-editor.org/rfc/rfc9110#section-15.4)
requires a client to drop `Authorization` across a host change — so the gateway
answers a perfectly good key with "missing credentials". This server rewrites
the apex and tells you it did, and refuses to follow any other 3xx rather than
send a request whose credential has been stripped.

### The key

`LOBSTACK_API_KEY` is read from this process's environment and from nowhere
else. No tool takes a key, a token, or a base URL as an argument: a base URL
that can arrive as a tool argument is a credential that can be redirected by
whoever wrote the argument. Error text is scrubbed on the way out, including
text that came back from upstream.

This process holds a live credential for as long as your MCP client runs. The
dependency list is the MCP SDK, zod, and what those two bring with them.

## Development

```bash
npm install
npm run build
npm test
```

The tests run a real MCP client against the server over an in-memory transport,
and the server against a fake gateway over real HTTP. The fake gateway writes
its SSE stream in two pieces with the cut landing mid-frame, serves a model with
no price, and refuses any request to `/route-preview` that arrives carrying an
`Authorization` header — so a client that leaks a credential to a public
endpoint fails a test rather than shipping.

## Licence

MIT
