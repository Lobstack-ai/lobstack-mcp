/**
 * 0.2.0: the tool descriptions agents choose by, the two new spending tools,
 * the wider spend window, and the API's error classes.
 *
 * Description tests are not style tests. An agent picks a tool, and decides
 * whether to retry one, from these strings alone; a description that stops
 * saying "this costs money" or "preview first" changes what agents do with a
 * live key, and that should fail a build rather than ship.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../dist/server.js';
import { startFakeGateway } from './fake-gateway.mjs';

const KEY = 'lsk_live_' + 'a'.repeat(8) + 'b'.repeat(48);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function connect({ baseUrl, apiKey = KEY }) {
  const server = createServer({ baseUrl, apiKey });
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, close: () => client.close() };
}

async function withGateway(opts, fn, { apiKey } = {}) {
  const gw = await startFakeGateway(opts);
  const { client, close } = await connect({ baseUrl: gw.url, apiKey: apiKey === undefined ? KEY : apiKey });
  try {
    return await fn(client, gw);
  } finally {
    await close();
    await gw.close();
  }
}

const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

async function tools() {
  return withGateway({}, async (client) => {
    const { tools: list } = await client.listTools();
    return Object.fromEntries(list.map((t) => [t.name, t]));
  });
}

/* ── descriptions and schemas ─────────────────────────────────────────── */

test('every tool has a title, and every parameter a real description', async () => {
  const all = await tools();
  for (const t of Object.values(all)) {
    assert.ok(t.title && t.title.length > 5, `${t.name} has a title`);
    assert.ok(t.description.length > 300, `${t.name} explains purpose, siblings and output`);
    for (const [name, prop] of Object.entries(t.inputSchema.properties ?? {})) {
      assert.ok(
        typeof prop.description === 'string' && prop.description.length >= 40,
        `${t.name}.${name} needs a description with units, default or example`,
      );
    }
  }
});

test('spending tools say they cost money; free tools say they do not', async () => {
  const all = await tools();
  for (const name of ['lobstack_chat', 'lobstack_embeddings', 'lobstack_web_search']) {
    assert.match(all[name].description, /COSTS MONEY/, `${name} must say it spends`);
    assert.equal(all[name].annotations.readOnlyHint, false);
    assert.equal(all[name].annotations.idempotentHint, false, `${name}: a repeat is billed again`);
    assert.equal(all[name].annotations.destructiveHint, false);
  }
  for (const name of ['lobstack_route_preview', 'lobstack_models', 'lobstack_spend']) {
    assert.match(all[name].description, /free|Free/, `${name} must say it is free`);
    assert.equal(all[name].annotations.readOnlyHint, true);
    assert.equal(all[name].annotations.idempotentHint, true);
  }
  for (const t of Object.values(all)) assert.equal(t.annotations.openWorldHint, true, `${t.name} calls the network`);
});

test('chat tells agents to preview with lobstack_route_preview first', async () => {
  const all = await tools();
  assert.match(all.lobstack_chat.description, /Before calling it, use lobstack_route_preview/);
  assert.match(all.lobstack_route_preview.description, /BEFORE lobstack_chat/);
});

test('each tool says when to use it rather than its siblings', async () => {
  const all = await tools();
  assert.match(all.lobstack_models.description, /Use lobstack_route_preview instead/);
  assert.match(all.lobstack_models.description, /lobstack_spend/);
  assert.match(all.lobstack_spend.description, /budget monitoring/);
  assert.match(all.lobstack_spend.description, /cost attribution/);
  assert.match(all.lobstack_spend.description, /is_floor true means the real total is\s+at least/);
  assert.match(all.lobstack_spend.description, /usage:read/);
  assert.match(all.lobstack_embeddings.description, /Use lobstack_chat/);
  assert.match(all.lobstack_web_search.description, /per search/);
  assert.match(all.lobstack_web_search.description, /do not retry/);
});

test('the enums match what the API serves', async () => {
  const all = await tools();
  const p = (tool, prop) => all[tool].inputSchema.properties[prop];
  assert.deepEqual(p('lobstack_spend', 'range').enum, ['month', '1d', '7d', '14d', '30d', '90d', '365d']);
  assert.deepEqual(p('lobstack_spend', 'group_by').enum, ['day', 'model', 'key', 'agent', 'provider', 'mode', 'client', 'app']);
  assert.deepEqual(p('lobstack_models', 'provider').enum, ['lobstack', 'anthropic', 'openai', 'google', 'xai']);
  assert.deepEqual(p('lobstack_models', 'type').enum, ['chat', 'embedding']);
  assert.deepEqual(p('lobstack_embeddings', 'model').enum, ['auto', 'text-embedding-3-small', 'text-embedding-3-large']);
  assert.equal(p('lobstack_web_search', 'count').maximum, 10);
  assert.equal(p('lobstack_web_search', 'query').maxLength, 400);
  assert.ok(p('lobstack_route_preview', 'plan_tier').enum.includes('free'));
});

test('no key management: nothing creates, rotates or revokes a key', async () => {
  const all = await tools();
  for (const name of Object.keys(all)) assert.doesNotMatch(name, /key|token|secret/i);
});

test('names only the four US model providers, and never DeepSeek', async () => {
  const all = await tools();
  const blob = Object.values(all).map((t) => JSON.stringify(t)).join('\n');
  const files = [
    'README.md',
    'server.json',
    'package.json',
    ...readdirSync(`${ROOT}/src`).filter((f) => f.endsWith('.ts')).map((f) => `src/${f}`),
    ...readdirSync(`${ROOT}/src/tools`).map((f) => `src/tools/${f}`),
  ];
  const texts = [blob, ...files.map((f) => readFileSync(`${ROOT}/${f}`, 'utf8'))];
  for (const [i, t] of texts.entries()) {
    assert.doesNotMatch(t, /deepseek|mistral|qwen|groq|five providers|Token Intelligence/i, `${files[i - 1] ?? 'tool list'}`);
  }
});

/* ── lobstack_embeddings ──────────────────────────────────────────────── */

test('embeddings sends what was asked, returns vectors in input order, and the header receipt', async () => {
  await withGateway({}, async (client, gw) => {
    const res = await client.callTool({
      name: 'lobstack_embeddings',
      arguments: { input: ['refund policy', 'shipping times'], model: 'text-embedding-3-large', dimensions: 256, client_tag: 'acme' },
    });
    assert.notEqual(res.isError, true, textOf(res));
    const sent = gw.requests.find((r) => r.url.includes('/embeddings'));
    assert.deepEqual(sent.body, { input: ['refund policy', 'shipping times'], model: 'text-embedding-3-large', dimensions: 256 });
    assert.equal(sent.headers['x-lobstack-client-tag'], 'acme');
    assert.equal(sent.headers.authorization, `Bearer ${KEY}`);

    const sc = res.structuredContent;
    assert.equal(sc.count, 2);
    assert.equal(sc.dimensions, 256);
    // The fixture sends the rows reversed; index decides the order.
    assert.ok(sc.embeddings[0][0] < sc.embeddings[1][0]);
    assert.equal(sc.receipt.cost_usd, 1.4e-7);
    assert.equal(sc.receipt.priced, true);
    assert.equal(sc.usage.prompt_tokens, 14);
    assert.equal(sc.quota.remaining_usd, 16.75);
    assert.match(textOf(res), /2 vectors of 256 dimensions/);
    assert.doesNotMatch(textOf(res), /unpriced/);
  });
});

test('an unpriced embedding stays null, never $0', async () => {
  await withGateway({ embedUnpriced: true }, async (client) => {
    const res = await client.callTool({ name: 'lobstack_embeddings', arguments: { input: 'hello' } });
    assert.equal(res.structuredContent.receipt.cost_usd, null);
    assert.equal(res.structuredContent.receipt.cost_display, 'unpriced');
    assert.match(textOf(res), /could not price/);
  });
});

test('embeddings refuses more dimensions than the model has, before spending', async () => {
  await withGateway({}, async (client, gw) => {
    const res = await client.callTool({ name: 'lobstack_embeddings', arguments: { input: 'x', dimensions: 2000 } });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /at most 1536/);
    assert.equal(gw.requests.length, 0, 'nothing was sent');
  });
});

/* ── lobstack_web_search ──────────────────────────────────────────────── */

test('web search returns results and the per-search price', async () => {
  await withGateway({}, async (client, gw) => {
    const res = await client.callTool({ name: 'lobstack_web_search', arguments: { query: 'deploy rollback', count: 2 } });
    assert.notEqual(res.isError, true, textOf(res));
    const sent = gw.requests.find((r) => r.url.includes('/search'));
    assert.deepEqual(sent.body, { query: 'deploy rollback', count: 2 });
    const sc = res.structuredContent;
    assert.equal(sc.count, 2);
    assert.equal(sc.results[0].url, 'https://example.com/rollbacks');
    assert.equal(sc.receipt.cost_usd, 0.005);
    assert.equal(sc.receipt.cache, 'miss');
    assert.match(textOf(res), /cost \$0\.005000/);
  });
});

test('a cached search says so and costs 0', async () => {
  await withGateway({ searchCached: true }, async (client) => {
    const res = await client.callTool({ name: 'lobstack_web_search', arguments: { query: 'x' } });
    assert.equal(res.structuredContent.receipt.cache, 'hit');
    assert.equal(res.structuredContent.receipt.cost_usd, 0);
  });
});

test('a search 503 SEARCH_UNAVAILABLE says fall back, not retry', async () => {
  await withGateway(
    { fail: { status: 503, headers: { 'retry-after': '600' }, body: { error: 'search not configured', error_code: 'SEARCH_UNAVAILABLE', request_id: 'req_x' } } },
    async (client) => {
      const res = await client.callTool({ name: 'lobstack_web_search', arguments: { query: 'x' } });
      assert.equal(res.isError, true);
      const t = textOf(res);
      assert.match(t, /search not configured/);
      assert.match(t, /Error class: provider \(HTTP 503, SEARCH_UNAVAILABLE\)/);
      assert.match(t, /Use another search tool/);
      assert.match(t, /Do not retry in a loop/);
      assert.match(t, /Request id: req_err/);
    },
  );
});

test('spending tools need a key and say so', async () => {
  await withGateway(
    {},
    async (client, gw) => {
      for (const [name, args] of [['lobstack_embeddings', { input: 'x' }], ['lobstack_web_search', { query: 'x' }]]) {
        const res = await client.callTool({ name, arguments: args });
        assert.equal(res.isError, true);
        assert.match(textOf(res), /No Lobstack API key is configured/);
      }
      assert.equal(gw.requests.length, 0);
    },
    { apiKey: null },
  );
});

/* ── error classes ────────────────────────────────────────────────────── */

test('a 402 names the class and code, and says not to retry', async () => {
  await withGateway(
    { fail: { status: 402, body: { error: { message: 'monthly allowance exhausted', type: 'quota', code: 402, error_code: 'ALLOWANCE_EXHAUSTED', request_id: 'req_q' } } } },
    async (client) => {
      const res = await client.callTool({ name: 'lobstack_chat', arguments: { prompt: 'hi' } });
      assert.equal(res.isError, true);
      const t = textOf(res);
      assert.match(t, /Error class: quota \(HTTP 402, ALLOWANCE_EXHAUSTED\)\. Do not retry/);
      assert.match(t, /Top up or upgrade in Console → Billing/);
      assert.match(t, /Request id: req_err/);
    },
  );
});

test('a 429 says retry, after the stated wait', async () => {
  await withGateway(
    { fail: { status: 429, headers: { 'retry-after': '23' }, body: { error: { message: 'rate limit', type: 'quota', code: 429, error_code: 'RATE_LIMITED' } } } },
    async (client) => {
      const res = await client.callTool({ name: 'lobstack_embeddings', arguments: { input: 'x' } });
      assert.match(textOf(res), /Retry after 23s \(Retry-After\)/);
      assert.match(textOf(res), /per-key rate limit/);
    },
  );
});

test('a 400 says fix the arguments', async () => {
  await withGateway(
    { fail: { status: 400, body: { error: { message: 'count must be an integer from 1 to 10', type: 'validation', code: 400, error_code: 'INVALID_PARAMETER' } } } },
    async (client) => {
      const res = await client.callTool({ name: 'lobstack_web_search', arguments: { query: 'x' } });
      assert.match(textOf(res), /Error class: validation/);
      assert.match(textOf(res), /fix the arguments/);
    },
  );
});

/* ── spend: the wider window ──────────────────────────────────────────── */

test('spend passes range, group_by and client through, and returns history and credit', async () => {
  await withGateway({}, async (client, gw) => {
    const res = await client.callTool({
      name: 'lobstack_spend',
      arguments: { range: '90d', group_by: 'client', client: 'acme' },
    });
    assert.notEqual(res.isError, true, textOf(res));
    const sent = gw.requests.find((r) => r.url.startsWith('/api/v1/usage'));
    const q = new URL(sent.url, 'http://x').searchParams;
    assert.equal(q.get('range'), '90d');
    assert.equal(q.get('group_by'), 'client');
    assert.equal(q.get('client'), 'acme');
    assert.equal(res.structuredContent.history.limited, true);
    assert.equal(res.structuredContent.credit.welcome.remaining_usd, 4.5);
    assert.match(textOf(res), /keeps 30 days of history/);
  });
});

test('spend rejects a window the API would silently answer as 7d', async () => {
  await withGateway({}, async (client, gw) => {
    let refused = false;
    try {
      const res = await client.callTool({ name: 'lobstack_spend', arguments: { range: '5d' } });
      refused = res.isError === true;
    } catch {
      refused = true;
    }
    assert.ok(refused, 'an unknown range must not reach the API');
    assert.equal(gw.requests.length, 0);
  });
});

test('instructions describe all six tools and the preview-first workflow', async () => {
  const gw = await startFakeGateway();
  const server = createServer({ baseUrl: gw.url, apiKey: KEY });
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const ins = client.getInstructions();
    for (const n of ['route_preview', 'models', 'chat', 'embeddings', 'web_search', 'spend']) {
      assert.match(ins, new RegExp(`lobstack_${n}`));
    }
    assert.match(ins, /Anthropic, OpenAI,\s+Google and xAI/);
    assert.match(ins, /Before a lobstack_chat call/);
  } finally {
    await client.close();
    await gw.close();
  }
});
