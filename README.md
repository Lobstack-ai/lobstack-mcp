# @lobstack-ai/mcp

An MCP server for the [Lobstack API](https://www.lobstack.ai/api-platform). One
API key reaches [chat models from Anthropic, OpenAI, Google and xAI](https://www.lobstack.ai/models),
plus embeddings and web search, and every call comes back with a receipt: which
model served it, how many tokens, what it cost.

Works in Claude Desktop, Claude Code, Cursor, Zed, or anything else that speaks
the Model Context Protocol over stdio.

## Try it without a key

`lobstack_route_preview` is unauthenticated. Install the server with no
credential at all and an agent can still ask "which model would this prompt go
to, and what would it cost":

```
npx -y @lobstack-ai/mcp
```

Add it to your client using one of the blocks below, leave `env` out, and ask:

> Preview how Lobstack would route: "summarise this changelog into three bullets"

`lobstack_models` also works without a key on www.lobstack.ai. The other four
tools need one, minted in Console → API keys.

## Install

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "lobstack": {
      "command": "npx",
      "args": ["-y", "@lobstack-ai/mcp"],
      "env": {
        "LOBSTACK_API_KEY": "lsk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

Restart Claude Desktop. The six `lobstack_*` tools appear under the tools menu.

### Cursor

`~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` for one:

```json
{
  "mcpServers": {
    "lobstack": {
      "command": "npx",
      "args": ["-y", "@lobstack-ai/mcp"],
      "env": {
        "LOBSTACK_API_KEY": "lsk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add lobstack --env LOBSTACK_API_KEY=lsk_live_... -- npx -y @lobstack-ai/mcp
```

### Zed

In `settings.json`, under `context_servers`:

```json
{
  "context_servers": {
    "lobstack": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "@lobstack-ai/mcp"],
      "env": {
        "LOBSTACK_API_KEY": "lsk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

## Tools

| Tool | Costs money | Needs a key | Endpoint |
| --- | --- | --- | --- |
| `lobstack_route_preview` | No | No | `POST /api/gateway/v1/route-preview` |
| `lobstack_models` | No | No | `GET /api/gateway/v1/models` |
| `lobstack_chat` | Yes, per token | `inference` scope | `POST /api/gateway/v1/chat/completions` |
| `lobstack_embeddings` | Yes, per input token | `inference` scope | `POST /api/gateway/v1/embeddings` |
| `lobstack_web_search` | Yes, per search | `inference` scope | `POST /api/gateway/v1/search` |
| `lobstack_spend` | No | `usage:read` scope | `GET /api/v1/usage` |

The intended order for an agent: `lobstack_route_preview` with the prompt it is
about to send (free), then `lobstack_chat`. `lobstack_models` when it needs a
model id or a rate. `lobstack_spend` to check what has already been spent.

Every tool description states its cost, what it needs, when to use a sibling
instead, and how to read its output, and every parameter has a description with
its range, default and an example. The annotations are accurate: the three
spending tools are `readOnlyHint: false, idempotentHint: false` (a repeat is
billed again), the other three are read-only and idempotent, and none is
destructive.

There is no tool for creating, rotating or revoking API keys. That stays in the
Console. There is also no "who am I" tool, because no key-authenticated
endpoint reports it; the allowance comes back as `quota` on every spending call
and as `credit` on `lobstack_spend`.

There is no streaming switch either. The server streams from the API (that is
how the chat receipt arrives), but an MCP tool result is one message, so the
agent gets the whole answer at once.

### `lobstack_route_preview`

Scores a prompt against the same router the paid path uses and reports the model
that would serve it, the capability tier, the complexity score, and the
estimated cost. Runs no inference and spends nothing. **Needs no API key.**
Rate-limited to ten a minute per IP address.

| argument | type | notes |
| --- | --- | --- |
| `prompt` | string, required | The prompt you are about to send. 1 to 8000 characters. Scored, never sent to a model. |
| `requested_model` | string | A chat model id to compare against. Default `auto`. An unknown id is a 400. |
| `plan_tier` | enum | `free`, `byok`, `developer`, `studio`, `scale`, `appsumo_1`..`3`, or the legacy `starter`, `pro`, `performance`, `enterprise`. Default `pro`. Sets the ceiling the router may reach. |
| `expected_output_tokens` | integer 1 to 200000 | Default half the prompt's estimated tokens, at least 64. |
| `conversation_length` | integer ≥ 0 | Messages already in the conversation. Default 0. |

Token counts are estimates, roughly four characters per token. The billed
figure always comes from the provider's own usage block on the real request,
and the tool says so in every answer. A `baseline` is returned only when you
named a model and the router moved away from it; on `auto` it is `null`.

### `lobstack_models`

The catalogue: model id, type (`chat` or `embedding`), label, tier, provider,
context window, embedding dimensions, and USD per million input and output
tokens.

| argument | type | notes |
| --- | --- | --- |
| `type` | `chat` \| `embedding` | Default both: chat rows first, embedding rows last. |
| `tier` | `router` \| `nano` \| `small` \| `standard` \| `premium` \| `flagship` | Chat models only. |
| `provider` | `anthropic` \| `openai` \| `google` \| `xai` \| `lobstack` | `lobstack` is the `auto` row. |

**The first entry is `auto`, which is Nex 1, the router.** It carries
`tier: "router"` and a null price on purpose: its cost is whichever model it
picks. It is not counted in `unpriced_count`. Every other null price is a gap:
the registry cannot price that model, and it renders as `—`, not as free.
Embedding rows have an output price of 0 because embeddings have no output
tokens. The full catalogue is also public at <https://www.lobstack.ai/models>.

### `lobstack_chat`

Sends a prompt or a conversation and returns the reply plus the receipt.
**Costs money** on input and output tokens.

| argument | type | notes |
| --- | --- | --- |
| `prompt` | string | A single user message. Use this **or** `messages`. |
| `messages` | array | `{ role, content }`, oldest first, role `system`/`user`/`assistant`. Use this **or** `prompt`. |
| `model` | string | Default `auto`, which is **Nex 1**, the router. Any chat id from `lobstack_models`. |
| `system` | string | Sent first, ahead of the conversation. |
| `max_tokens` | integer 1 to 200000 | Default 4096 (8192 for OpenAI GPT-5 and o-series models). Caps the worst-case cost. |
| `temperature` | number 0 to 2 | Not sent unless set. Some models do not accept it; `dropped_params` says when it was dropped. |
| `client_tag` | string | Who the call is for, for cost attribution. See [Client tags](#client-tags). |

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

### `lobstack_embeddings`

Vectors for text, from OpenAI `text-embedding-3-small` (default, 1536
dimensions) or `text-embedding-3-large` (3072). **Costs money** on input
tokens. Not routed: `auto` means the small model, because vectors from
different models cannot be compared.

| argument | type | notes |
| --- | --- | --- |
| `input` | string, or array of 1 to 64 strings | Required. Each string is embedded separately and returned in the same order. |
| `model` | `auto` \| `text-embedding-3-small` \| `text-embedding-3-large` | Default the small model. |
| `dimensions` | integer | Shorten each vector. At most the model's own length; refused before any call if larger. |
| `client_tag` | string | See [Client tags](#client-tags). |

The API takes up to 2,048 inputs per call. This tool takes 64, because every
vector comes back into the agent's context. For bulk indexing, call the HTTP API
directly. The receipt is read from the `x-lobstack-*` headers: an empty
`x-lobstack-cost-usd` is reported as `cost_usd: null`, never 0.

### `lobstack_web_search`

Web results from Brave Search's index through the Lobstack API: title, URL and
a plain-text snippet each. **Costs money, per search**, not per token or per
result: Brave's published price inside your plan's included usage and on the
Free plan's credit, and that times the Lobstack rate past it. The current figure
is on <https://www.lobstack.ai/docs/gateway/search>.

| argument | type | notes |
| --- | --- | --- |
| `query` | string, required | 1 to 400 characters after trimming. Lobstack logs its length, not its text. |
| `count` | integer 1 to 10 | Default 5. Fewer may come back. |
| `client_tag` | string | See [Client tags](#client-tags). |

The same query and count from the same organization within ten minutes may be
answered from a short cache: `receipt.cache` is `"hit"` and the cost is 0. A
402 or 503 means search will not run on Lobstack right now; the error text
tells the agent to use another search rather than retry in a loop.

### `lobstack_spend`

What the organization has spent. Read-only and free. Requires a key holding the
`usage:read` scope.

| argument | type | notes |
| --- | --- | --- |
| `range` | `month` \| `1d` \| `7d` \| `14d` \| `30d` \| `90d` \| `365d` | Default `7d`. `month` is the UTC calendar month to date, the Console's default. A window longer than the plan's history starts where the history does, and `history.limited` says so. |
| `group_by` | `day` \| `model` \| `key` \| `agent` \| `provider` \| `mode` \| `client` \| `app` | Default `model`. `client` is the client tag; `mode` splits managed from your own provider key; `app` is the calling application. |
| `client` | string | Only calls for this client tag. `__untagged__` selects calls with none. |

Use it for budget monitoring (how much of the month is gone, which model or key
drives it) and for cost attribution (spend per client tag or per agent).

**The total is the Console's figure.** `/api/v1/usage` returns two totals from
two tables: `spend.cost_usd`, from the billing ledger that the allowance and
invoices are read from and that the Console's Spend shows, and
`summary.cost_usd`, the request trace's own copy of each price, kept for older
callers. They are written separately and can disagree. This tool reports
`spend.cost_usd` (and each group's `ledger_cost_usd`) as `cost_usd`, with
`cost_source: "ledger"`. Only when the ledger figure is null or missing does it
fall back to `summary.cost_usd`, set `cost_source: "trace"`, and say so in the
output.

**`is_floor` means "at least".** Unpriced rows sum as zero, the only arithmetic
available, so a total that includes one is a lower bound. So is a total whose
read hit the row cap. When `is_floor` is true, report the figure as "at least
$X", never as the bill.

**Routing savings are two figures, never one.** When the API sends `savings`,
the tool shows `named` (saved on models you asked for, measured) and
`plan_ceiling` (what `auto` requests would have cost on the best model your
plan allows: a comparison, not a saving) on separate lines. It never adds them
together, and it never computes a saving client-side from a copy of the rate
card.

`credit` is passed through from the API: on a spend-metered plan, the Free
plan's weekly credit, any welcome credit and when it expires, included usage
this period, and purchased credit left.

### Client tags

`lobstack_chat`, `lobstack_embeddings` and `lobstack_web_search` take an
optional `client_tag`: who the call is for, sent as `x-lobstack-client-tag`.
1 to 64 characters of lowercase `a-z`, `0-9`, `.`, `_` or `-`, starting with a
letter or digit. Read it back with `lobstack_spend` `group_by: "client"`. A tag
set on the API key itself wins over the argument. A client with a hard monthly
budget that is spent refuses the call with 402 `CLIENT_BUDGET_EXHAUSTED`.

## Errors

A failed call returns `isError: true` with the API's message, then a line
naming the error class, the HTTP status, the `error_code` when there is one,
and whether a retry can help:

```
monthly allowance exhausted

Error class: quota (HTTP 402, ALLOWANCE_EXHAUSTED). Do not retry: the allowance or a budget is spent until it is raised or resets.
The plan's included usage and credit are used. Top up or upgrade in Console → Billing.
Request id: 8f2b1e0c-...
```

| Class | Status | Retry? |
| --- | --- | --- |
| `auth` | 401, 403 | No. Fix the key or its scopes. |
| `quota` | 402, 429 | 402 no. 429 yes, after `Retry-After`. |
| `validation` | 400, 409, 422 | No. Fix the arguments. |
| `provider` | 502, 503, other 5xx | Yes, with backoff, except `SEARCH_UNAVAILABLE`, `MANAGED_DISABLED` and `PROVIDER_ACCOUNT_UNAVAILABLE`: use a fallback. |
| `timeout` | 408, 504 | Yes. The first attempt may have completed and been billed. |
| `internal` | 500 | Once, then report the request id. |

The full list is at <https://www.lobstack.ai/docs/gateway/errors>.

## Two rules about the numbers

**A null cost is not zero.** `cost_usd: null` means the API could not price
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
| `LOBSTACK_BASE_URL` | `https://www.lobstack.ai/api/gateway/v1` | The Lobstack API base URL. Change it only to point at a staging deployment. |

**Use `www`, not the bare apex.** `lobstack.ai` redirects to `www.lobstack.ai`,
and [RFC 9110 §15.4](https://www.rfc-editor.org/rfc/rfc9110#section-15.4)
requires a client to drop `Authorization` across a host change — so the API
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

## Publishing to the MCP Registry

`server.json` is what the [Official MCP Registry](https://registry.modelcontextprotocol.io)
stores. PulseMCP lists a server once that registry accepts it, so this is the
publish that puts `@lobstack-ai/mcp` there. The registry stores metadata only.
`.github/workflows/release.yml` publishes the npm tarball when a `v*` tag is
pushed, and the registry then reads `mcpName` out of that tarball.

The registry name is `io.github.Lobstack-ai/lobstack-mcp` in both places GitHub
authentication checks: `name` in `server.json`, and `mcpName` in `package.json`.
A GitHub login can only publish under `io.github.Lobstack-ai/`. `version` in
`server.json`, the npm package entry inside it, and `package.json` are the same
string. The package is `@lobstack-ai/mcp` on `https://registry.npmjs.org`,
stdio, invoked as `npx -y @lobstack-ai/mcp`. `LOBSTACK_API_KEY` is optional
(`isRequired: false`, `isSecret: true`) because `lobstack_route_preview` runs
with no key.

### One click

`.github/workflows/publish-mcp.yml` runs when a GitHub Release is published, and
from the Actions tab with **Run workflow**. It refuses to publish when the
versions disagree, waits until that version is on npm, then runs:

```bash
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
./mcp-publisher login github-oidc
./mcp-publisher publish
```

`login github-oidc` is why the workflow has `id-token: write`. There is no
registry token to store.

On a laptop the publisher commands are the same, with the device-code login in
place of OIDC:

```bash
./mcp-publisher login github
./mcp-publisher publish
```

The registry reads `mcpName` from the tarball already on npm, not from this
checkout. `0.1.3` was published before `mcpName` existed, and npm will not
accept a second upload of that version, so the first publish that succeeds is
the next one: bump `package.json` and `server.json` together, push the `v*` tag,
then publish the GitHub Release.

## Licence

MIT
