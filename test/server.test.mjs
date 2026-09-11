/**
 * The MCP server, driven by a real MCP client, against a real HTTP gateway.
 *
 *   node --test test/
 *
 * Not unit tests around the handlers. What can actually break here is at the
 * seams — a frame split by the network, a receipt read off the wrong field, a
 * redirect quietly eating the key, an output schema that does not match what
 * the handler returns — and none of those show up when you call your own
 * function with an object you wrote. So: a genuine `Client` over an in-memory
 * transport (which exercises JSON-RPC framing and schema validation for real),
 * talking to a `node:http` server that speaks SSE in awkwardly-sized pieces.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../dist/server.js';
import { startFakeGateway, startRedirector } from './fake-gateway.mjs';

const KEY = 'lsk_live_' + 'a'.repeat(8) + 'b'.repeat(48);

/** A connected client/server pair pointed at `baseUrl`. */
async function connect({ baseUrl, apiKey = KEY }) {
  const server = createServer({ baseUrl, apiKey });
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

const textOf = (result) =>
  result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

/** Run one tool call against a fresh fake gateway. */
async function withGateway(opts, fn) {
  const gw = await startFakeGateway(opts);
  const { client, close } = await connect({ baseUrl: gw.url });
  try {
    return await fn(client, gw);
  } finally {
    await close();
    await gw.close();
  }
}

/* ── the surface ──────────────────────────────────────────────────────── */

test('advertises four tools, with schemas and annotations', async () => {
  await withGateway({}, async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['lobstack_chat', 'lobstack_models', 'lobstack_route_preview', 'lobstack_spend']);

    for (const t of tools) {
      assert.ok(t.inputSchema, `${t.name} has an input schema`);
      assert.ok(t.outputSchema, `${t.name} has an output schema`);
      assert.ok(t.description.length > 40, `${t.name} says what it does`);
    }

    // chat spends money; the other three do not.
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName.lobstack_chat.annotations.readOnlyHint, false);
    assert.equal(byName.lobstack_models.annotations.readOnlyHint, true);
    assert.equal(byName.lobstack_route_preview.annotations.readOnlyHint, true);
    assert.equal(byName.lobstack_spend.annotations.readOnlyHint, true);

    // No tool may take a URL: a base URL that arrives as an argument is a
    // credential redirected by whoever wrote the argument.
    for (const t of tools) {
      const props = Object.keys(t.inputSchema.properties ?? {});
      assert.ok(
        !props.some((p) => /url|endpoint|host|base/i.test(p)),
        `${t.name} must not accept a URL (${props.join(', ')})`,
      );
      // A whole segment named like a credential — `expected_output_tokens` is
      // a token count, not a token.
      const credentialish = /(^|_)(api_?key|key|token|secret|credential|password|auth|authorization|bearer)$/i;
      assert.ok(!props.some((p) => credentialish.test(p)), `${t.name} must not accept a credential`);
    }
  });
});

/* ── chat, and the receipt ────────────────────────────────────────────── */

test('streams the answer and returns the receipt the gateway sent', async () => {
  await withGateway({}, async (client, gw) => {
    const res = await client.callTool({ name: 'lobstack_chat', arguments: { prompt: 'hi' } });
    assert.notEqual(res.isError, true);

    // The fixture cuts a frame in half mid-stream. Both halves have to arrive.
    assert.equal(res.structuredContent.text, 'Hello there');

    // The answer and the receipt are separate blocks, so whatever consumes the
    // answer does not get a price line concatenated onto it.
    assert.equal(res.content[0].text, 'Hello there');
    assert.match(res.content[1].text, /claude-haiku-4-5/);

    assert.equal(res.structuredContent.receipt.cost_usd, 0.0011);
    assert.equal(res.structuredContent.receipt.cost_display, '$0.001100');
    assert.equal(res.structuredContent.receipt.priced, true);
    assert.equal(res.structuredContent.model.served, 'claude-haiku-4-5');
    assert.equal(res.structuredContent.model.routed, true);
    assert.equal(res.structuredContent.usage.prompt_tokens, 400);

    // include_usage is not optional: without it there is no trailing frame for
    // the gateway to attach x_lobstack to, and the price never arrives.
    const sent = gw.requests.find((r) => r.url.includes('/chat/completions'));
    assert.equal(sent.body.stream, true);
    assert.deepEqual(sent.body.stream_options, { include_usage: true });
    assert.equal(sent.body.model, 'auto');
    assert.equal(sent.headers['x-lobstack-client'], 'lobstack-mcp');
  });
});

test('calls a like-for-like saving "saved", and names the baseline', async () => {
  await withGateway({}, async (client) => {
    const res = await client.callTool({ name: 'lobstack_chat', arguments: { prompt: 'hi', model: 'claude-opus-5' } });
    const s = res.structuredContent.receipt.savings;
    assert.equal(s.named, true);
    assert.equal(s.label, 'saved');
    assert.equal(s.amount_usd, 0.0044);
    assert.equal(s.baseline_model, 'claude-opus-5');
    assert.match(textOf(res), /saved\s+\$0\.004400/);
  });
});

test('will not call a plan-ceiling comparison a saving', async () => {
  // `auto` has no model the caller named, so the gateway measures against the
  // most expensive model the plan allows. That is a real comparison and it is
  // not the same claim, so it must not be printed as "saved".
  await withGateway({ ceilingBaseline: true }, async (client) => {
    const res = await client.callTool({ name: 'lobstack_chat', arguments: { prompt: 'hi' } });
    const s = res.structuredContent.receipt.savings;
    assert.equal(s.named, false);
    assert.equal(s.label, 'vs ceiling');
    assert.equal(s.baseline_reason, 'plan_ceiling');

    const rendered = textOf(res);
    assert.match(rendered, /vs ceiling/);
    assert.doesNotMatch(rendered, /\bsaved\b/);
    // And it names the model it measured against, plus why.
    assert.match(rendered, /gpt-5\.6/);
    assert.match(rendered, /you sent auto/);
  });
});

test('a saving with no reason attached is not the flattering case', async () => {
  await withGateway({ noBaselineReason: true }, async (client) => {
    const res = await client.callTool({ name: 'lobstack_chat', arguments: { prompt: 'hi' } });
    assert.equal(res.structuredContent.receipt.savings.named, false);
    assert.equal(res.structuredContent.receipt.savings.label, 'vs ceiling');
    assert.doesNotMatch(textOf(res), /\bsaved\b/);
  });
});

test('an unpriced call stays unpriced and never becomes $0.00', async () => {
  // Rendering a null cost as $0.00 writes off a real charge. That exact bug ran
  // for three months in production.
  await withGateway({ unpriced: true }, async (client) => {
    const res = await client.callTool({ name: 'lobstack_chat', arguments: { prompt: 'hi' } });
    assert.equal(res.structuredContent.receipt.cost_usd, null);
    assert.equal(res.structuredContent.receipt.cost_display, 'unpriced');
    assert.equal(res.structuredContent.receipt.priced, false);
    assert.equal(res.structuredContent.receipt.savings, null);

    const rendered = textOf(res);
    assert.match(rendered, /unpriced/);
    assert.doesNotMatch(rendered, /\$0\.00/);
    assert.match(rendered, /could not price/);
  });
});

test('says so when the endpoint sent no receipt at all', async () => {
  await withGateway({ noReceipt: true }, async (client) => {
    const res = await client.callTool({ name: 'lobstack_chat', arguments: { prompt: 'hi' } });
    assert.equal(res.structuredContent.receipt, null);
    // The answer still arrives; the silence about price is stated, not hidden.
    assert.equal(res.structuredContent.text, 'Hello there');
    assert.match(textOf(res), /no receipt/);
  });
});

test('keeps the receipt when the stream ends without a trailing blank line', async () => {
  // The last frame is the one carrying the price. A reader that only flushes on
  // a blank-line boundary drops exactly the frame that matters.
  await withGateway({ noTrailingBlank: true }, async (client) => {
    const res = await client.callTool({ name: 'lobstack_chat', arguments: { prompt: 'hi' } });
    assert.equal(res.structuredContent.text, 'Hello there');
    assert.equal(res.structuredContent.receipt.cost_usd, 0.0011);
  });
});

test('keeps the receipt when the chunk boundary lands inside the receipt frame', async () => {
  // The frame carrying x_lobstack is the one whose loss costs money rather than
  // words. A splitter that buffers across reads has to survive a cut here, not
  // only a cut in the prose.
  await withGateway({ cutInReceipt: true }, async (client) => {
    const res = await client.callTool({ name: 'lobstack_chat', arguments: { prompt: 'hi' } });
    assert.equal(res.structuredContent.text, 'Hello there');
    assert.equal(res.structuredContent.receipt.cost_usd, 0.0011);
    assert.equal(res.structuredContent.usage.total_tokens, 540);
  });
});

test('reports the allowance the gateway put on the response', async () => {
  await withGateway({}, async (client) => {
    const res = await client.callTool({ name: 'lobstack_chat', arguments: { prompt: 'hi' } });
    assert.equal(res.structuredContent.quota.meter, 'spend');
    assert.equal(res.structuredContent.quota.remaining_usd, 16.75);
    assert.match(textOf(res), /allowance \$16\.7500 remaining of \$20\.00/);
  });
});

test('says when a parameter was dropped rather than letting it look applied', async () => {
  await withGateway({ droppedTemp: true }, async (client) => {
    const res = await client.callTool({
      name: 'lobstack_chat',
      arguments: { prompt: 'hi', temperature: 0.2 },
    });
    assert.deepEqual(res.structuredContent.dropped_params, ['temperature']);
    assert.match(textOf(res), /does not accept temperature/);
  });
});

test('surfaces a mid-stream error instead of returning a truncated answer', async () => {
  await withGateway({ midStreamError: true }, async (client) => {
    const res = await client.callTool({ name: 'lobstack_chat', arguments: { prompt: 'hi' } });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /upstream provider timed out/);
  });
});

test('refuses prompt and messages together rather than guessing', async () => {
  await withGateway({}, async (client) => {
    const res = await client.callTool({
      name: 'lobstack_chat',
      arguments: { prompt: 'hi', messages: [{ role: 'user', content: 'no, hi' }] },
    });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /not both/);
  });
});

test('sends a system prompt ahead of the conversation', async () => {
  await withGateway({}, async (client, gw) => {
    await client.callTool({
      name: 'lobstack_chat',
      arguments: { messages: [{ role: 'user', content: 'hi' }], system: 'be terse', max_tokens: 64 },
    });
    const sent = gw.requests.find((r) => r.url.includes('/chat/completions'));
    assert.deepEqual(sent.body.messages, [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(sent.body.max_tokens, 64);
  });
});

/* ── the redirect that eats the key ───────────────────────────────────── */

test('fails loudly on a 3xx instead of losing the key to it', async () => {
  // A redirect that changes host makes every conforming client drop
  // Authorization, and the gateway then answers a perfectly good key with
  // "missing credentials". Failing loudly beats reporting an auth error for a
  // credential that was never sent.
  const redirector = await startRedirector();
  const { client, close } = await connect({ baseUrl: redirector.url });
  try {
    for (const name of ['lobstack_models', 'lobstack_chat', 'lobstack_spend', 'lobstack_route_preview']) {
      const args = name === 'lobstack_chat' ? { prompt: 'hi' } : name === 'lobstack_route_preview' ? { prompt: 'hi' } : {};
      const res = await client.callTool({ name, arguments: args });
      assert.equal(res.isError, true, `${name} must not follow a redirect`);
      assert.match(textOf(res), /redirected \(307\)/, name);
      assert.match(textOf(res), /strips the Authorization header/, name);
    }
  } finally {
    await close();
    await redirector.close();
  }
});

/* ── models ───────────────────────────────────────────────────────────── */

test('lists models with prices, and does not price the unpriced one at zero', async () => {
  await withGateway({}, async (client) => {
    const res = await client.callTool({ name: 'lobstack_models', arguments: {} });
    assert.equal(res.structuredContent.count, 4);
    assert.equal(res.structuredContent.unpriced_count, 1);

    const opus = res.structuredContent.models.find((m) => m.id === 'claude-opus-5');
    assert.equal(opus.input_usd_per_mtok, 5);
    assert.equal(opus.output_usd_per_mtok, 25);
    assert.equal(opus.tier, 'flagship');
    assert.equal(opus.provider, 'anthropic');

    const unpriced = res.structuredContent.models.find((m) => m.id === 'llama-4-scout-local');
    assert.equal(unpriced.input_usd_per_mtok, null, 'no price means null, not zero');
    assert.equal(unpriced.output_usd_per_mtok, null);

    const rendered = textOf(res);
    assert.match(rendered, /claude-opus-5/);
    assert.match(rendered, /\$5/);
    assert.match(rendered, /—/, 'the unpriced model renders as a dash');
    assert.doesNotMatch(rendered, /llama-4-scout-local.*\$0/);
    assert.match(rendered, /are not free/);
  });
});

test('filters the catalogue by tier and provider', async () => {
  await withGateway({}, async (client) => {
    const byTier = await client.callTool({ name: 'lobstack_models', arguments: { tier: 'flagship' } });
    assert.equal(byTier.structuredContent.count, 2);

    const byProvider = await client.callTool({ name: 'lobstack_models', arguments: { provider: 'openai' } });
    assert.deepEqual(
      byProvider.structuredContent.models.map((m) => m.id),
      ['gpt-5.6'],
    );
  });
});

/* ── route preview: the one that needs no key ─────────────────────────── */

test('previews routing with no credential attached at all', async () => {
  const gw = await startFakeGateway();
  // No key anywhere. This is the fresh-install case, and it is the whole point
  // of the tool: the product is demonstrable before anybody signs up.
  const { client, close } = await connect({ baseUrl: gw.url, apiKey: null });
  try {
    const res = await client.callTool({
      name: 'lobstack_route_preview',
      arguments: { prompt: 'what is the capital of France?' },
    });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.served_model, 'claude-haiku-4-5');
    assert.equal(res.structuredContent.tier, 'small');
    assert.equal(res.structuredContent.estimated, true);
    assert.ok(res.structuredContent.estimated_cost_usd > 0);

    // The fake gateway 400s if an Authorization header shows up here.
    const sent = gw.requests.find((r) => r.url.includes('/route-preview'));
    assert.equal(sent.headers.authorization, undefined, 'a public endpoint must not receive the key');

    const rendered = textOf(res);
    assert.match(rendered, /needs no API key/);
    assert.match(rendered, /Estimated, not billed/);
  } finally {
    await close();
    await gw.close();
  }
});

test('a preview against a named model reports the like-for-like difference', async () => {
  await withGateway({}, async (client) => {
    const res = await client.callTool({
      name: 'lobstack_route_preview',
      arguments: { prompt: 'a'.repeat(400), requested_model: 'claude-opus-5', expected_output_tokens: 200 },
    });
    assert.equal(res.structuredContent.routed, true);
    assert.equal(res.structuredContent.baseline.model, 'claude-opus-5');
    assert.ok(res.structuredContent.baseline.saving_usd > 0);
    assert.match(textOf(res), /cheaper than claude-opus-5, which you named/);
  });
});

test('a preview on auto claims no baseline at all', async () => {
  await withGateway({}, async (client) => {
    const res = await client.callTool({ name: 'lobstack_route_preview', arguments: { prompt: 'hello' } });
    assert.equal(res.structuredContent.baseline, null, 'on auto there is no model anybody asked for');
    assert.doesNotMatch(textOf(res), /cheaper than/);
  });
});

/* ── spend ────────────────────────────────────────────────────────────── */

test('reports spend, and says the total is a floor when rows are unpriced', async () => {
  await withGateway({}, async (client) => {
    const res = await client.callTool({ name: 'lobstack_spend', arguments: { range: '30d', group_by: 'model' } });
    assert.equal(res.structuredContent.enabled, true);
    assert.equal(res.structuredContent.is_floor, true);
    assert.equal(res.structuredContent.summary.unpriced_requests, 2);

    const rendered = textOf(res);
    assert.match(rendered, /12 requests/);
    assert.match(rendered, /a floor, not a total/);
    assert.match(rendered, /2 unpriced/);
    assert.match(rendered, /p95 1900ms/);
  });
});

test('a deployment without tracing is told apart from a deployment with no spend', async () => {
  await withGateway({ usageDisabled: true }, async (client) => {
    const res = await client.callTool({ name: 'lobstack_spend', arguments: {} });
    assert.notEqual(res.isError, true, 'not an error: it is a true answer to a different question');
    assert.equal(res.structuredContent.enabled, false);
    assert.match(textOf(res), /not enabled on this deployment/);
    assert.doesNotMatch(textOf(res), /\$0\.00/);
  });
});

test('names the missing scope on a 403 rather than saying "forbidden"', async () => {
  await withGateway({ usageForbidden: true }, async (client) => {
    const res = await client.callTool({ name: 'lobstack_spend', arguments: {} });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /usage:read/);
  });
});

/* ── the credential ───────────────────────────────────────────────────── */

test('says what to do when there is no key, without breaking the keyless tool', async () => {
  const gw = await startFakeGateway();
  const { client, close } = await connect({ baseUrl: gw.url, apiKey: null });
  try {
    for (const name of ['lobstack_chat', 'lobstack_spend']) {
      const res = await client.callTool({ name, arguments: name === 'lobstack_chat' ? { prompt: 'hi' } : {} });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /LOBSTACK_API_KEY/);
      assert.match(textOf(res), /route_preview needs no key/);
    }
    const preview = await client.callTool({ name: 'lobstack_route_preview', arguments: { prompt: 'hi' } });
    assert.notEqual(preview.isError, true, 'the keyless tool must still work');
  } finally {
    await close();
    await gw.close();
  }
});

test('never echoes the key, not even when the gateway does', async () => {
  const gw = await startFakeGateway();
  const { client, close } = await connect({ baseUrl: gw.url, apiKey: KEY });
  try {
    // The fake gateway 404s an unknown path; ask for something that fails, and
    // check every byte that comes back.
    const results = await Promise.all([
      client.callTool({ name: 'lobstack_chat', arguments: { prompt: 'hi' } }),
      client.callTool({ name: 'lobstack_models', arguments: {} }),
      client.callTool({ name: 'lobstack_spend', arguments: {} }),
      client.callTool({ name: 'lobstack_route_preview', arguments: { prompt: 'hi' } }),
    ]);
    for (const r of results) {
      const blob = JSON.stringify(r);
      assert.doesNotMatch(blob, /lsk_live/, 'no tool result may contain the key');
      assert.doesNotMatch(blob, /bbbbbbbb/);
    }
  } finally {
    await close();
    await gw.close();
  }
});

test('a rejected key produces a diagnosis, not the key', async () => {
  const gw = await startFakeGateway();
  // Shaped wrong on purpose: the gateway 401s it, and the hint has to name the
  // shape problem without printing the value.
  const { client, close } = await connect({ baseUrl: gw.url, apiKey: 'totally-not-a-key' });
  try {
    const res = await client.callTool({ name: 'lobstack_models', arguments: {} });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /missing credentials/);
    assert.match(textOf(res), /not shaped like a Lobstack API key/);
    assert.doesNotMatch(textOf(res), /totally-not-a-key/);
  } finally {
    await close();
    await gw.close();
  }
});
