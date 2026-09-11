/**
 * The rules, tested as pure functions.
 *
 * These are the three things this repo is not allowed to get wrong, and none of
 * them need a server to demonstrate: the apex rewrite, the null cost, and what
 * a saving may be called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBase, scrub, looksLikeApiKey, DEFAULT_BASE_URL } from '../dist/config.js';
import { asMoney, money, parseReceipt, savingsLabel, describeReceipt } from '../dist/receipt.js';

test('the default base is www, never the apex', () => {
  assert.equal(DEFAULT_BASE_URL, 'https://www.lobstack.ai/api/gateway/v1');
  // Both spellings of the same thing reduce to the origin paths compose from.
  assert.equal(resolveBase(DEFAULT_BASE_URL).origin, 'https://www.lobstack.ai');
  assert.equal(resolveBase('https://www.lobstack.ai').origin, 'https://www.lobstack.ai');
});

test('rewrites the bare apex to the host that answers, and says so', () => {
  // lobstack.ai 307s to www. RFC 9110 makes a client drop Authorization across
  // a host change, so the gateway answers a perfectly good key with "missing
  // credentials". Correcting it silently would hide a real misconfiguration.
  const apex = resolveBase('https://lobstack.ai');
  assert.equal(apex.origin, 'https://www.lobstack.ai');
  assert.equal(apex.corrected, true, 'the correction must be announced, not silent');

  const already = resolveBase('https://www.lobstack.ai/api/gateway/v1');
  assert.equal(already.corrected, false, 'nothing to announce when it is already right');

  // Someone else's host is left exactly as given: this is about one known
  // redirect, not a policy about other people's domains.
  const other = resolveBase('http://127.0.0.1:9999');
  assert.equal(other.origin, 'http://127.0.0.1:9999');
  assert.equal(other.corrected, false);
});

test('a non-URL base fails with something actionable', () => {
  assert.throws(() => resolveBase('lobstack.ai'), /not a URL/);
  assert.throws(() => resolveBase('ftp://lobstack.ai'), /http or https/);
});

test('a null cost is never a zero', () => {
  assert.equal(asMoney(null), null);
  assert.equal(asMoney(undefined), null);
  assert.equal(asMoney(''), null, 'the buffered path encodes unpriced as an empty string');
  assert.equal(asMoney('not a number'), null);
  // A genuine zero is a different fact from "we could not price it" and survives.
  assert.equal(asMoney(0), 0);
  assert.equal(asMoney(0.0011), 0.0011);
});

test('money renders unpriced as unpriced, never as $0.00', () => {
  assert.equal(money(null), 'unpriced');
  assert.equal(money(undefined), 'unpriced');
  assert.equal(money(NaN), 'unpriced');
  assert.equal(money(0), '$0.000000');
  assert.equal(money(0.0011), '$0.001100');
  assert.equal(money(1.5), '$1.5000');
});

test('baseline_reason decides what a saving may be called', () => {
  const named = parseReceipt({ savings_usd: 0.004, baseline_reason: 'named', baseline_model: 'claude-opus-5' });
  assert.equal(savingsLabel(named).label, 'saved');
  assert.equal(savingsLabel(named).named, true);

  const ceiling = parseReceipt({ savings_usd: 0.004, baseline_reason: 'plan_ceiling', baseline_model: 'gpt-5.6' });
  assert.equal(savingsLabel(ceiling).label, 'vs ceiling');
  assert.equal(savingsLabel(ceiling).named, false);

  // A missing reason is treated as unnamed. Never as the flattering case.
  const silent = parseReceipt({ savings_usd: 0.004, baseline_model: 'gpt-5.6' });
  assert.equal(savingsLabel(silent).label, 'vs ceiling');
  assert.equal(savingsLabel(silent).named, false);

  // And a nonsense reason is not "named" either.
  const bogus = parseReceipt({ savings_usd: 0.004, baseline_reason: 'whatever' });
  assert.equal(savingsLabel(bogus).named, false);

  assert.equal(savingsLabel(parseReceipt({ savings_usd: 0 })), null);
  assert.equal(savingsLabel(parseReceipt({ savings_usd: null })), null);
  assert.equal(savingsLabel(null), null);
});

test('priced is an assertion, not an inference', () => {
  // Absent `priced` must not be read as true just because a number turned up.
  assert.equal(parseReceipt({ cost_usd: 0.001 }).priced, false);
  assert.equal(parseReceipt({ cost_usd: 0.001, priced: true }).priced, true);
});

test('the receipt line says what it cannot say', () => {
  const line = describeReceipt({
    receipt: parseReceipt({ cost_usd: null, savings_usd: null, priced: false, served_model: 'x' }),
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  assert.match(line, /unpriced/);
  assert.doesNotMatch(line, /\$0\.00/);
  assert.match(line, /could not price/);

  const none = describeReceipt({ receipt: null, usage: null, model: 'x' });
  assert.match(none, /no receipt/);
});

test('the key is scrubbed out of anything on its way to a tool result', () => {
  const key = 'lsk_live_' + 'a'.repeat(8) + 'b'.repeat(48);
  assert.equal(looksLikeApiKey(key), true);
  assert.equal(looksLikeApiKey('not-a-key'), false);

  assert.match(scrub(`upstream rejected ${key}`, key), /\[redacted\]/);
  assert.doesNotMatch(scrub(`upstream rejected ${key}`, key), /aaaaaaaa/);
  // Including a key that arrived from somewhere else entirely.
  assert.doesNotMatch(scrub(`saw ${key} in a log`, null), /bbbb/);
  // And a self-hosted token that does not match the lsk_ shape.
  assert.equal(scrub('token gw_secret_zzz leaked', 'gw_secret_zzz'), 'token [redacted] leaked');
});
