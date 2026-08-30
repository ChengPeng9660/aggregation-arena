import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, verify, constants } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import ts from 'typescript';
import { createKalshiGetHeaders } from '../lib/kalshi-auth-core.js';
import * as curation from '../lib/curation-core.js';
import * as eventState from '../lib/event-state-core.js';

// Ephemeral local test material only; never reads credentials or calls Kalshi.
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const env = { KALSHI_API_KEY_ID: 'unit-test-key', KALSHI_API_PRIVATE_KEY: pem };
const origin = 'https://external-api.kalshi.com';
function verifies(headers, message) {
  return verify('sha256', Buffer.from(message), {
    key: pair.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
  }, Buffer.from(headers['KALSHI-ACCESS-SIGNATURE'], 'base64'));
}
function assertSignature(headers, url) {
  const prefix = `${headers['KALSHI-ACCESS-TIMESTAMP']}GET`;
  assert.equal(headers['KALSHI-ACCESS-KEY'], 'unit-test-key');
  assert.ok(verifies(headers, prefix + url.pathname));
  if (url.search) assert.equal(verifies(headers, prefix + url.pathname + url.search), false);
}

test('Kalshi signs milliseconds + GET + encoded pathname with RSA-PSS SHA256 salt32', async () => {
  const url = new URL(`${origin}/trade-api/v2/markets/A%2FB?limit=5&cursor=a%2Fb`);
  const headers = await createKalshiGetHeaders(env, () => 1788134400123)(url);
  assert.equal(headers['KALSHI-ACCESS-TIMESTAMP'], '1788134400123');
  assertSignature(headers, url);
  for (const message of [
    `1788134400123POST${url.pathname}`,
    `1788134400123GET/trade-api/v2/markets/OTHER`,
    `1788134400124GET${url.pathname}`,
  ]) assert.equal(verifies(headers, message), false);
});

test('signer refreshes timestamps after elapsed time rather than reusing stale headers', async () => {
  let clock = 1788134400000;
  const sign = createKalshiGetHeaders(env, () => clock);
  const url = new URL(`${origin}/trade-api/v2/events?limit=20`);
  const old = await sign(url);
  clock += 120_000;
  const fresh = await sign(url);
  assert.equal(fresh['KALSHI-ACCESS-TIMESTAMP'], String(clock));
  assertSignature(fresh, url);
  assert.equal(verifies(old, `${clock}GET${url.pathname}`), false);
  // No server expiry window is invented: this tests fresh client timestamps.
});

test('anonymous mode, escaped PEM newlines, and redacted invalid configuration', async () => {
  assert.deepEqual(await createKalshiGetHeaders()(`${origin}/trade-api/v2/events`), {});
  const escaped = { ...env, KALSHI_API_PRIVATE_KEY: pem.replace(/\n/g, '\\n') };
  assertSignature(await createKalshiGetHeaders(escaped)(`${origin}/trade-api/v2/events`),
    new URL(`${origin}/trade-api/v2/events`));
  for (const partial of [{ KALSHI_API_KEY_ID: 'must-not-appear' }, { KALSHI_API_PRIVATE_KEY: 'must-not-appear' }]) {
    assert.throws(() => createKalshiGetHeaders(partial), { message: 'Kalshi authentication requires both API key ID and private key' });
  }
  const bad = createKalshiGetHeaders({ ...env, KALSHI_API_PRIVATE_KEY: 'must-not-appear' });
  await assert.rejects(bad(`${origin}/trade-api/v2/events`), { message: 'Kalshi private key must be an unencrypted PKCS8 RSA PEM' });
  await assert.rejects(createKalshiGetHeaders(env, () => NaN)(`${origin}/trade-api/v2/events`), /clock is invalid/);
});

test('signer rejects unrelated origins, userinfo, ports and paths', async () => {
  const sign = createKalshiGetHeaders(env);
  for (const url of [
    'https://gamma-api.polymarket.com/trade-api/v2/events',
    'https://external-api.kalshi.com.evil.test/trade-api/v2/events',
    'http://external-api.kalshi.com/trade-api/v2/events',
    'https://user:password@external-api.kalshi.com/trade-api/v2/events',
    'https://external-api.kalshi.com:444/trade-api/v2/events',
    `${origin}/portfolio/balance`,
  ]) await assert.rejects(sign(url), /unsupported API destination/);
});

const source = ts.createSourceFile('polymarket.ts', readFileSync(new URL('../lib/polymarket.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const moduleBody = stripTypeScriptTypes(source.statements.filter((node) => !ts.isImportDeclaration(node))
  .map((node) => node.getText(source).replace(/^export\s+/, '')).join('\n'));
function load(fetch) {
  const dependencies = { ...curation, ...eventState, createKalshiGetHeaders, fetch };
  return new Function(...Object.keys(dependencies), `${moduleBody}\nreturn {
    fetchIntakeJson, intakeBudget, fetchKalshiEventPayloads, resolveSelectedMarkets,
  };`)(...Object.values(dependencies));
}

test('actual intake signs every attempt, disables redirects and refreshes fallback signature', async () => {
  const calls = [];
  const api = load(async (input, init) => {
    const url = new URL(input);
    assert.equal(init.redirect, 'error');
    assertSignature(init.headers, url);
    calls.push({ url, headers: init.headers });
    return calls.length === 1 ? new Response('', { status: 503 }) : Response.json({ events: [] });
  });
  let clock = 1788134400000;
  await api.fetchIntakeJson(new URL(`${origin}/trade-api/v2/events?limit=20`),
    api.intakeBudget(5), 1000, createKalshiGetHeaders(env, () => ++clock));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.origin, 'https://api.elections.kalshi.com');
  assert.notEqual(calls[0].headers['KALSHI-ACCESS-TIMESTAMP'], calls[1].headers['KALSHI-ACCESS-TIMESTAMP']);
});

test('actual Kalshi discovery forwards credentials while default stays anonymous', async () => {
  for (const credentials of [env, {}]) {
    let calls = 0;
    const api = load(async (input, init) => {
      const url = new URL(input);
      assert.equal(url.pathname, '/trade-api/v2/series');
      assert.ok(url.searchParams.has('category'));
      if (credentials === env) {
        assertSignature(init.headers, url);
        assert.equal(init.redirect, 'error');
      } else {
        assert.equal(init.headers['KALSHI-ACCESS-KEY'], undefined);
        assert.equal(init.redirect, 'follow');
      }
      calls += 1;
      return Response.json({ series: [] });
    });
    await api.fetchKalshiEventPayloads(new Date('2026-08-31T00:00:00Z'), new Set(), credentials);
    assert.equal(calls, 5);
  }
});

test('actual resolution GET receives auth without changing market resolution state', async () => {
  let calls = 0;
  const api = load(async (input, init) => {
    const url = new URL(input);
    assert.equal(url.pathname, '/trade-api/v2/markets/TEST-EVENT-YES');
    assertSignature(init.headers, url);
    assert.equal(init.redirect, 'error');
    calls += 1;
    return Response.json({ market: { status: 'active', result: '' } });
  });
  const row = { event_id: 'fixture', market_id: 'kalshi:TEST-EVENT-YES', source_platform: 'kalshi',
    status: 'locked', close_time: '2026-01-01T00:00:00Z', event_type: 'binary', source_event_id: null };
  const db = {
    async batch() { return []; },
    prepare(sql) {
      return {
        async all() { return { results: sql.includes('FROM selection_items') ? [row] : [] }; },
        async run() { return {}; },
      };
    },
  };
  const result = await api.resolveSelectedMarkets(db, env);
  assert.equal(calls, 1);
  assert.equal(result.checked, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.resolved, 0);
});

test('scheduled entrypoint forwards the optional environment to both public data stages', async () => {
  const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'runMarketScheduled');
  const body = stripTypeScriptTypes(declaration.getText(source).replace(/^export\s+/, ''));
  const calls = [];
  const dependencies = {
    ensureCurationReady: async () => {},
    syncLiveMarketCandidates: async (...args) => { calls.push(['sync', ...args]); return {}; },
    resolveSelectedMarkets: async (...args) => { calls.push(['resolve', ...args]); return {}; },
    retryIncompleteDailySelection: async () => null,
    settledValue: (value) => value.value,
  };
  const run = new Function(...Object.keys(dependencies), `return (${body});`)(...Object.values(dependencies));
  const runtime = { DB: {}, ...env };
  await run(runtime, { cron: '0 * * * *' });
  assert.equal(calls.length, 1, 'intake must not consume resolution requests in the same invocation');
  assert.equal(calls[0][1], runtime.DB);
  assert.equal(calls[0][3], runtime);
  await run(runtime, { cron: '5 * * * *' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], runtime.DB);
  assert.equal(calls[1][2], runtime);
});
