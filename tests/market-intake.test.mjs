import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import * as curation from '../lib/curation-core.js';
import { createKalshiGetHeaders } from '../lib/kalshi-auth-core.js';

const file = new URL('../lib/polymarket.ts', import.meta.url);
const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
// Execute the real module declarations with injected I/O. AST removal of imports
// avoids path aliases without copying private implementation bodies into tests.
const moduleBody = stripTypeScriptTypes(source.statements
  .filter((node) => !ts.isImportDeclaration(node))
  .map((node) => node.getText(source).replace(/^export\s+/, ''))
  .join('\n'));
function load(fetch, getD1 = () => { throw new Error('No test database'); }) {
  const dependencies = { ...curation, createKalshiGetHeaders, fetch, getD1 };
  return new Function(...Object.keys(dependencies), `${moduleBody}\nreturn {
    fetchPolymarketEventPayloads, fetchKalshiEventPayloads, readJsonLimited,
    fetchIntakeJson, intakeBudget,
    syncLiveMarketCandidates, closeStaleSyncRuns, CURATION_SCHEMA,
  };`)(...Object.values(dependencies));
}

const now = new Date('2026-08-31T00:00:00.000Z');
const iso = (days) => new Date(now.getTime() + days * 86_400_000).toISOString();
function polyMarket(id, eventId) {
  return {
    id, question: `Will independent outcome ${id} occur?`, slug: `outcome-${id}`,
    description: 'Resolves according to the official outcome published by the named source.',
    resolutionSource: 'Official published result', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]',
    lastTradePrice: 0.5, volume24hr: 10_000, volumeNum: 50_000, liquidityNum: 10_000,
    startDate: iso(-10), endDate: iso(10), active: true, closed: false, acceptingOrders: true, negRisk: true,
    events: [{ id: eventId, title: `Independent event ${eventId}`, slug: `event-${eventId}`, active: true, closed: false, negRisk: true }],
  };
}
function polyEvent(id, outcomeCount) {
  return {
    id, title: `Independent event ${id}`, slug: `event-${id}`, active: true, closed: false, negRisk: true,
    markets: Array.from({ length: outcomeCount }, (_, index) => ({
      ...polyMarket(`${id}-${index}`, id), events: undefined, unusedImage: 'x'.repeat(1000),
    })),
  };
}

const sourceCategories = ['Politics', 'Economics', 'Science and Technology', 'Sports', 'Entertainment'];
const ticker = (category) => `T${sourceCategories.indexOf(category)}`;
function kalshiEvents(series, old) {
  return Array.from({ length: 4 }, (_, index) => {
    const event = `${series}-${old ? 'old' : 'new'}-${index}`;
    return {
      event_ticker: event, series_ticker: series, category: sourceCategories[Number(series[1])],
      title: `Source event ${index}`,
      markets: [{
        ticker: `${event}-Y`, event_ticker: event, title: `Will a distinct measurable outcome occur ${index}?`,
        yes_sub_title: 'Yes', rules_primary: 'Resolves Yes according to the result published by the official source.',
        status: 'active', last_price_dollars: '0.5000', volume_24h_fp: '100.00', volume_fp: '1000.00',
        open_interest_fp: '100.00', open_time: iso(-10), expected_expiration_time: iso(10), close_time: iso(14),
        unneeded_blob: 'x'.repeat(1000),
      }],
    };
  });
}
function kalshiFixture() {
  const calls = [];
  let active = 0;
  let peak = 0;
  const fetch = async (input) => {
    const url = new URL(input);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    calls.push(url.pathname + url.search);
    if (url.pathname.endsWith('/series')) {
      const series = ticker(url.searchParams.get('category'));
      return Response.json({ series: [
        { ticker: `${series}OLD`, volume_fp: '2000.00' },
        { ticker: `${series}NEW`, volume_fp: '1000.00' },
      ] });
    }
    if (url.pathname.endsWith('/events')) {
      const series = url.searchParams.get('series_ticker');
      return Response.json({ events: kalshiEvents(series.slice(0, 2), series.endsWith('OLD')) });
    }
    throw new Error(`Unexpected public request: ${url}`);
  };
  return { fetch, calls, peak: () => peak };
}

function sqliteFixture(fetch) {
  const sqlite = new DatabaseSync(':memory:');
  const statements = [];
  const db = {
    prepare(text) {
      let bindings = [];
      const record = () => { statements.push({ sql: text, bindings }); return sqlite.prepare(text); };
      return {
        bind(...values) { bindings = values; assert.ok(values.length <= 100, 'D1 has a 100-bind statement limit'); return this; },
        async all() { return { results: record().all(...bindings) }; },
        async first() { return record().get(...bindings) ?? null; },
        async run() { return { meta: record().run(...bindings) }; },
      };
    },
    async batch(items) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const item of items) results.push(await item.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const lib = load(fetch, () => db);
  for (const statement of lib.CURATION_SCHEMA) sqlite.exec(statement);
  return { sqlite, statements, db, lib };
}

test('market discovery hydrates all categorical siblings, skips used groups, and preserves success after another hydration fails', async () => {
  const calls = [];
  const lib = load(async (input) => {
    const url = new URL(input);
    calls.push(url.pathname + url.search);
    if (url.pathname === '/markets/keyset') return Response.json({
      markets: url.searchParams.has('volume_min') ? [polyMarket('a', 'A'), polyMarket('b', 'B'), polyMarket('c', 'C')] : [],
    });
    if (url.pathname === '/events') {
      assert.deepEqual(url.searchParams.getAll('id'), ['A', 'C']);
      assert.equal(url.searchParams.get('limit'), '2');
      return Response.json([polyEvent('A', 13), polyEvent('unrequested', 2)]);
    }
    return new Response('upstream failure', { status: 503 });
  });
  const result = await lib.fetchPolymarketEventPayloads(now, new Set(['polymarket-event:B']));
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0].markets.map((market) => market.id), Array.from({ length: 13 }, (_, index) => `A-${index}`));
  assert.ok(result.events[0].markets.every((market) => !('unusedImage' in market)));
  assert.equal(calls.filter((url) => url.startsWith('/events?')).length, 1);
  assert.ok(result.diagnostics.errors.some((error) => error.stage === 'hydrate:C'));
});

test('oversized external payloads are rejected before they can be admitted as partial events', async () => {
  const lib = load(async () => { throw new Error('No network expected'); });
  await assert.rejects(lib.readJsonLimited(new Response('x'.repeat(100)), 32), /exceeded/);
});

test('bulk parent hydration uses bounded requests while retaining every child outcome', async () => {
  const batches = [];
  const ids = Array.from({length:25}, (_, index) => `event-${index}`);
  const lib = load(async (input) => {
    const url = new URL(input);
    if (url.pathname === '/markets/keyset') return Response.json({
      markets: url.searchParams.has('volume_min') ? ids.map((id) => polyMarket(`m-${id}`, id)) : [],
    });
    assert.equal(url.pathname, '/events');
    const selectedIds = url.searchParams.getAll('id');
    batches.push(selectedIds);
    assert.equal(Number(url.searchParams.get('limit')), selectedIds.length);
    return Response.json(selectedIds.map((id) => polyEvent(id, 13)));
  });
  const result = await lib.fetchPolymarketEventPayloads(now);
  assert.equal(result.events.length,25);
  assert.equal(batches.length,3);
  assert.ok(batches.every((batch) => batch.length <= 12));
  assert.equal(result.events.flatMap((event) => event.markets).length,325);
  assert.deepEqual(result.diagnostics.errors,[]);
});

test('next-day Kalshi discovery looks past used groups and retains official categories with at most two concurrent requests', async () => {
  const fixture = kalshiFixture();
  const lib = load(fixture.fetch);
  const blocked = new Set(sourceCategories.flatMap((category) => Array.from({ length: 4 }, (_, index) =>
    `kalshi-event:${ticker(category)}-old-${index}`)));
  const result = await lib.fetchKalshiEventPayloads(now, blocked);
  assert.equal(result.events.length, 40, 'old source records may refresh, but twenty fresh groups must also be discovered');
  assert.ok(sourceCategories.every((category) => fixture.calls.some((url) => url.includes(`${ticker(category)}NEW`))));
  assert.ok(fixture.peak() <= 2);
  assert.ok(result.events.every((event) => sourceCategories.includes(event.category)));
  assert.ok(result.events.every((event) => event.markets.every((market) => !('unneeded_blob' in market))));
});

test('a provider rate limit stops further discovery and honors its cooldown without switching hostnames', async () => {
  const calls = [];
  const earliestRetry = Date.now() + 3_600_000;
  const lib = load(async (input) => {
    calls.push(new URL(input));
    return new Response('{"error":{"code":"too_many_requests"}}', {status:429,headers:{'retry-after':'3600'}});
  });
  await assert.rejects(lib.fetchKalshiEventPayloads(now), (error) => {
    const diagnostics = JSON.parse(error.message);
    assert.ok(diagnostics.limitsReached.includes('source_rate_limited'));
    assert.ok(Date.parse(diagnostics.retryAfter) >= earliestRetry);
    assert.ok(diagnostics.errors.some((item) => item.error.includes('returned 429; retry after')));
    return true;
  });
  assert.ok(calls.length <= 2, 'only the already-started requests may finish');
  assert.ok(calls.every((url) => url.hostname === 'external-api.kalshi.com'));
});

test('concurrent callers obey the shared request pace and cannot overrun the source request budget', async () => {
  const starts = [];
  const lib = load(async () => {
    starts.push(Date.now());
    return Response.json({ events: [] });
  });
  const budget = lib.intakeBudget(3, 30);
  const outcomes = await Promise.allSettled(Array.from({length: 5}, () =>
    lib.fetchIntakeJson(new URL('https://external-api.kalshi.com/trade-api/v2/events'), budget)));
  assert.equal(starts.length, 3);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 3);
  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(starts[index] - starts[index - 1] >= 30, 'concurrency must not create a burst');
  }
  assert.ok(budget.diagnostics.limitsReached.includes('source_request_budget'));
});

test('real sync SQL stores complete outcomes across bounded multirow batches and timeout diagnostics preserve progress', async () => {
  const kalshi = kalshiFixture();
  const fixture = sqliteFixture(async (input) => {
    const url = new URL(input);
    if (url.hostname.includes('polymarket')) {
      if (url.pathname === '/markets/keyset') return Response.json({ markets: url.searchParams.has('volume_min') ? [polyMarket('a', 'A')] : [] });
      if (url.pathname === '/events') return Response.json([polyEvent('A', 97)]);
    }
    return kalshi.fetch(input);
  });
  try {
    const result = await fixture.lib.syncLiveMarketCandidates(fixture.db, now);
    // Near-identical fixture titles do not stop discovery after the first
    // series: retain both series' actual source rows without counting them as
    // independent daily questions.
    const expectedRows = 97 + sourceCategories.length * 8;
    assert.equal(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM polymarket_candidates').get().n, expectedRows);
    assert.equal(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM market_snapshots').get().n, expectedRows);
    assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS n FROM polymarket_candidates WHERE source_event_id='A'").get().n, 97);
    const upserts = fixture.statements.filter((statement) => statement.sql.includes('INSERT INTO polymarket_candidates'));
    assert.ok(upserts.length < expectedRows / 2, 'upserts must batch rows, not issue one query per candidate');
    assert.ok(upserts.every((statement) => statement.bindings.length <= 100));
    assert.ok(fixture.statements.some((statement) => statement.sql.includes('$.lastStage') && statement.bindings.includes('persisting')));
    assert.ok(result.sourceStats.polymarket.underTargetCategories.includes('Science'), 'insufficient supply remains visible regardless of status label');
    fixture.sqlite.prepare("INSERT INTO curation_sync_runs(status,started_at,detail_json) VALUES ('running','2000-01-01',?)").run(
      JSON.stringify({ lastStage: 'persisting', sourceProgress: { kalshi: { requests: 6 } } }),
    );
    await fixture.lib.closeStaleSyncRuns(fixture.db, now);
    const detail = JSON.parse(fixture.sqlite.prepare("SELECT detail_json FROM curation_sync_runs WHERE started_at='2000-01-01'").get().detail_json);
    assert.equal(detail.lastStage, 'persisting');
    assert.equal(detail.sourceProgress.kalshi.requests, 6);
    assert.equal(detail.timedOut, true);
  } finally { fixture.sqlite.close(); }
});
