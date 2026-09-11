/**
 * A stand-in Gateway, so the MCP server can be tested against real bytes.
 *
 * Modelled on `cli/test/fake-gateway.mjs` in the platform repo, and for the
 * same reason: what breaks in a gateway client is at the seams, and a fixture
 * that hands you whole frames over a mocked fetch tests none of them.
 *
 * It speaks the four shapes that matter and nothing else:
 *
 *   POST /api/gateway/v1/chat/completions   SSE whose LAST frame carries
 *                                           `x_lobstack`. The stream is written
 *                                           in two pieces with the cut landing
 *                                           mid-frame, on purpose.
 *   GET  /api/gateway/v1/models             a listing including one model with
 *                                           no price at all.
 *   POST /api/gateway/v1/route-preview      unauthenticated. Refuses outright
 *                                           if an Authorization header arrives,
 *                                           so a client that leaks a credential
 *                                           to a public endpoint fails a test.
 *   GET  /api/v1/usage                      a summary including unpriced rows.
 *
 * Every request is recorded in `.requests` so tests can assert on what was sent
 * as well as what came back.
 */
import { createServer } from 'node:http';

const RECEIPT = {
  request_id: 'req_test',
  served_model: 'claude-haiku-4-5',
  requested_model: 'claude-opus-5',
  routed: true,
  cost_usd: 0.0011,
  savings_usd: 0.0044,
  priced: true,
  // A named baseline: the caller asked for opus-5 and the router served haiku.
  // That is the like-for-like case, and the only one anything downstream is
  // allowed to print the word "saved" next to.
  baseline_reason: 'named',
  baseline_model: 'claude-opus-5',
  baseline_cost_usd: 0.0055,
};

const FRAMES = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
  { choices: [{ index: 0, delta: { content: 'Hello' } }] },
  { choices: [{ index: 0, delta: { content: ' there' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  {
    choices: [],
    model: 'claude-haiku-4-5',
    usage: { prompt_tokens: 400, completion_tokens: 140, total_tokens: 540 },
    x_lobstack: RECEIPT,
  },
];

const MODELS = [
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', object: 'model', owned_by: 'anthropic', tier: 'small', context_window: 200000, price_per_mtok: { input: 1, output: 5 }, managed: true },
  { id: 'claude-opus-5', label: 'Claude Opus 5', object: 'model', owned_by: 'anthropic', tier: 'flagship', context_window: 1000000, price_per_mtok: { input: 5, output: 25 }, managed: true },
  { id: 'gpt-5.6', label: 'GPT-5.6 Sol', object: 'model', owned_by: 'openai', tier: 'flagship', context_window: 1050000, price_per_mtok: { input: 4, output: 20 }, managed: true },
  // No price at all. The listing has to render this without inventing a zero.
  { id: 'llama-4-scout-local', label: 'Llama 4 Scout', object: 'model', owned_by: 'groq', tier: 'small', context_window: 131072, price_per_mtok: {}, managed: false },
];

const QUOTA_HEADERS = {
  'x-lobstack-quota-meter': 'spend',
  'x-lobstack-quota-allowance-usd': '20.000000',
  'x-lobstack-quota-spent-usd': '3.250000',
  'x-lobstack-quota-remaining-usd': '16.750000',
};

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/**
 * @param {object} [o]
 * @param {boolean} [o.unpriced]         cost_usd null, priced false
 * @param {boolean} [o.ceilingBaseline]  baseline_reason plan_ceiling
 * @param {boolean} [o.noReceipt]        no x_lobstack at all, like an older gateway
 * @param {boolean} [o.noBaselineReason] savings with no reason attached
 * @param {boolean} [o.noTrailingBlank]  close without a final blank line
 * @param {boolean} [o.cutInReceipt]     put the chunk boundary INSIDE the frame
 *                                       carrying x_lobstack — the frame whose
 *                                       loss costs money rather than words
 * @param {boolean} [o.midStreamError]   a 200 whose stream carries an error
 * @param {boolean} [o.usageDisabled]    /api/v1/usage answers enabled:false
 * @param {boolean} [o.usageForbidden]   /api/v1/usage answers 403
 * @param {boolean} [o.droppedTemp]      x-lobstack-dropped-params: temperature
 * @param {number}  [o.slow]             ms between the two halves of the stream
 */
export function startFakeGateway({
  unpriced = false,
  ceilingBaseline = false,
  noReceipt = false,
  noBaselineReason = false,
  noTrailingBlank = false,
  cutInReceipt = false,
  midStreamError = false,
  usageDisabled = false,
  usageForbidden = false,
  droppedTemp = false,
  slow = 5,
} = {}) {
  /** @type {Array<{method:string,url:string,headers:object,body:any}>} */
  const requests = [];

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });

    const url = req.url ?? '';

    // Unauthenticated on purpose, and asserted: a client that attaches a
    // credential to a public endpoint has leaked it, and should fail here.
    if (url.startsWith('/api/gateway/v1/route-preview')) {
      if (req.headers.authorization) {
        return json(res, 400, { error: { message: 'route-preview received an Authorization header; it must not' } });
      }
      const prompt = body?.prompt;
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return json(res, 400, { error: { message: '`prompt` is required.', type: 'invalid_request_error' } });
      }
      const requested = body?.requested_model || 'auto';
      const inputTokens = Math.max(1, Math.round(prompt.length / 4));
      const outputTokens = body?.expected_output_tokens || Math.max(64, Math.round(inputTokens / 2));
      const routed = requested !== 'auto';
      const cost = +((inputTokens * 1 + outputTokens * 5) / 1_000_000).toFixed(6);
      const baseCost = +((inputTokens * 5 + outputTokens * 25) / 1_000_000).toFixed(6);
      return json(res, 200, {
        object: 'routing_preview',
        requested_model: requested,
        plan_tier: body?.plan_tier || 'pro',
        complexity: 12,
        tier: 'small',
        routed,
        reason: 'Simple query → small tier',
        model: {
          key: 'claude-haiku-4-5',
          label: 'Claude Haiku 4.5',
          provider: 'anthropic',
          context_window: 200000,
          price_per_mtok: { input: 1, output: 5 },
          managed_key_configured: true,
        },
        token_estimate: {
          input: inputTokens,
          output: outputTokens,
          method: '~4 characters per token; output assumed at half the prompt',
          estimated: true,
        },
        cost_usd: cost,
        // Null on "auto": there is no model anybody asked for to compare to.
        baseline: routed
          ? { model: requested, label: requested, cost_usd: baseCost, saving_usd: +(baseCost - cost).toFixed(6) }
          : null,
        note: 'Estimated from the same registry and the same selectModel() that serves /v1/chat/completions.',
      });
    }

    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer lsk_')) {
      return json(res, 401, { error: { message: 'missing credentials' } });
    }

    if (url.startsWith('/api/gateway/v1/models')) {
      return json(res, 200, { object: 'list', data: MODELS });
    }

    if (url.startsWith('/api/v1/usage')) {
      if (usageForbidden) {
        return json(res, 403, { error: 'this API key lacks the "usage:read" scope' });
      }
      if (usageDisabled) {
        return json(res, 200, {
          enabled: false,
          reason: 'request_tracing_not_migrated',
          message: 'Request tracing is not enabled on this deployment yet.',
          summary: null,
          groups: [],
          truncated: false,
        });
      }
      return json(res, 200, {
        enabled: true,
        org_id: 'org_test',
        authenticated_via: 'api_key',
        range: '7d',
        group_by: 'model',
        summary: {
          requests: 12,
          errors: 1,
          total_tokens: 54000,
          cost_usd: 0.0033,
          // Two rows the meter could not price. The total above is a floor.
          unpriced_requests: 2,
          p50_latency_ms: 410,
          p95_latency_ms: 1900,
          streamed: 9,
        },
        groups: [
          { key: 'claude-haiku-4-5', requests: 9, total_tokens: 40000, cost_usd: 0.0033, unpriced_requests: 0 },
          { key: 'llama-4-scout-local', requests: 3, total_tokens: 14000, cost_usd: 0, unpriced_requests: 2 },
        ],
        truncated: false,
      });
    }

    if (!url.startsWith('/api/gateway/v1/chat/completions')) {
      return json(res, 404, { error: { message: `no route for ${url}` } });
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'x-lobstack-request-id': 'req_test',
      'x-lobstack-model': 'claude-haiku-4-5',
      ...QUOTA_HEADERS,
      ...(droppedTemp ? { 'x-lobstack-dropped-params': 'temperature' } : {}),
    });

    if (midStreamError) {
      res.write('data: {"error":{"message":"upstream provider timed out","type":"gateway_error"}}\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const frames = FRAMES.map((f) => {
      if (!f.x_lobstack) return f;
      if (noReceipt) {
        const rest = { ...f };
        delete rest.x_lobstack;
        return rest;
      }
      if (unpriced) {
        return { ...f, x_lobstack: { ...f.x_lobstack, cost_usd: null, savings_usd: null, priced: false } };
      }
      if (ceilingBaseline) {
        // Nobody asked for the baseline model here. The receipt has to say so.
        return {
          ...f,
          x_lobstack: {
            ...f.x_lobstack,
            requested_model: 'auto',
            baseline_reason: 'plan_ceiling',
            baseline_model: 'gpt-5.6',
          },
        };
      }
      if (noBaselineReason) {
        const x = { ...f.x_lobstack };
        delete x.baseline_reason;
        return { ...f, x_lobstack: x };
      }
      return f;
    });

    let text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
    if (noTrailingBlank) {
      // A server that hangs up without the final blank line still owes us the
      // receipt frame. Drop [DONE] and the last separator entirely.
      text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('').replace(/\n\n$/, '');
    }

    // Cut mid-frame. Whole-frame writes would never exercise the buffer.
    // `cutInReceipt` aims the boundary at the middle of the LAST frame, which is
    // the one carrying the price: a buffer that is merely usually right will
    // pass a cut in the prose and still lose the receipt.
    const lastFrameStart = text.lastIndexOf('data: {"choices":[],');
    const cut = cutInReceipt && lastFrameStart !== -1
      ? lastFrameStart + Math.floor((text.length - lastFrameStart) / 2)
      : Math.floor(text.length * 0.37);
    res.write(text.slice(0, cut));
    await new Promise((r) => setTimeout(r, slow));
    res.write(text.slice(cut));
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        port: addr.port,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** A server that answers every request with a cross-host redirect. */
export function startRedirector(location = 'https://www.example.com/somewhere') {
  const server = createServer((_req, res) => {
    res.writeHead(307, { location });
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
