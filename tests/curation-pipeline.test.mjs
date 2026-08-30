import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { DAILY_CANDIDATES_SQL, DAILY_SELECTION_CLAIM_SQL, dailySelectionNeedsRetry } from '../lib/curation-pipeline-core.js';
import { CANONICAL_CATEGORIES, classifyMarket, selectDiverseSourceBalancedCandidates, validateDailySlate } from '../lib/curation-core.js';

test('missing daily selection retries and a live claim cannot be stolen', () => {
  assert.equal(dailySelectionNeedsRetry(undefined), true);
  assert.equal(dailySelectionNeedsRetry('failed'), true);
  assert.equal(dailySelectionNeedsRetry('completed'), false);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE selection_runs(id TEXT PRIMARY KEY,config_version TEXT,taxonomy_version TEXT,status TEXT,started_at TEXT,completed_at TEXT)');
    const claim = db.prepare(DAILY_SELECTION_CLAIM_SQL);
    assert.equal(claim.get('today','v2','taxonomy','2026-08-31T10:00:00Z').id,'today');
    assert.equal(claim.get('today','v2','taxonomy','2026-08-31T10:19:59Z'),undefined);
    assert.equal(claim.get('today','v2','taxonomy','2026-08-31T10:20:00Z').id,'today');
    db.exec("UPDATE selection_runs SET status='completed'");
    assert.equal(claim.get('today','v2','taxonomy','2026-08-31T11:00:00Z'),undefined);
  } finally { db.close(); }
});

test('candidate selection excludes old diversity groups and cannot reuse stale or failed intake', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE polymarket_candidates(market_id TEXT PRIMARY KEY,diversity_group_id TEXT,last_seen_at TEXT,close_time TEXT,category TEXT,selection_score REAL);
      CREATE INDEX idx_seen ON polymarket_candidates(last_seen_at);
      CREATE TABLE selection_runs(id TEXT PRIMARY KEY,status TEXT);
      CREATE TABLE selection_items(run_id TEXT,market_id TEXT);
      CREATE TABLE curation_sync_runs(id INTEGER,status TEXT,started_at TEXT);
      INSERT INTO selection_runs VALUES ('prior','completed');
      INSERT INTO curation_sync_runs VALUES (1,'completed','2026-08-31T10:00:00Z'),(2,'failed','2026-08-31T10:30:00Z');
      INSERT INTO polymarket_candidates VALUES
        ('prior-market','shared','2026-08-29T10:00:00Z','2026-09-09T00:00:00Z','Politics',1),
        ('sibling','shared','2026-08-31T10:00:00Z','2026-09-09T00:00:00Z','Politics',1),
        ('new','independent','2026-08-31T10:00:00Z','2026-09-09T00:00:00Z','Science',1),
        ('partial','partial','2026-08-31T10:30:00Z','2026-09-09T00:00:00Z','Science',1),
        ('closing','closing','2026-08-31T10:00:00Z','2026-09-01T00:00:00Z','Science',1);
      INSERT INTO selection_items VALUES ('prior','prior-market');`);
    const query = db.prepare(DAILY_CANDIDATES_SQL);
    const rows=query.all('2026-08-31T11:00:00Z','2026-09-02T11:00:00Z');
    assert.deepEqual(rows.map(r=>[r.market_id,r.already_selected]),[['sibling',1],['new',0]]);
    assert.deepEqual(query.all('2026-08-31T14:00:00Z','2026-09-02T14:00:00Z'),[]);
    const plan=db.prepare(`EXPLAIN QUERY PLAN ${DAILY_CANDIDATES_SQL}`).all('2026-08-31T11:00:00Z','2026-09-02T11:00:00Z');
    assert.ok(!plan.some(row=>String(row.detail).includes('CORRELATED')), 'history is materialized once, not per candidate');
  } finally { db.close(); }
});

test('joint quota allocation succeeds when one source cannot supply two in every category', () => {
  const terms=['albatross','banyan','cobalt','dahlia','ember','fjord','garnet','harbor','indigo','juniper','keystone','lantern','monsoon','nectar','orchid','prairie','quartz','redwood','saffron','tundra','upland','velvet','willow','xenon','yarrow','zephyr','aurora','bramble','citadel','drizzle'];
  const counts={polymarket:[4,2,3,3,1],kalshi:[1,5,4,5,5]};
  let index=0;
  const candidates=Object.entries(counts).flatMap(([sourcePlatform,byCategory])=>CANONICAL_CATEGORIES.flatMap((category,c)=>Array.from({length:byCategory[c]},()=>{
    const id=index++;
    return {marketId:`m${id}`,sourceEventId:`e${id}`,diversityGroupId:`g${id}`,sourcePlatform,category,
      title:`Will ${terms[id%terms.length]} ${id>=terms.length?'jacinth':''} resolve?`,eligible:true,selectionScore:1-id/100,volume24h:10000};
  })));
  const result=selectDiverseSourceBalancedCandidates(candidates);
  assert.equal(result.length,20);
  assert.equal(validateDailySlate(result).valid,true);
  assert.equal(result.filter(r=>r.sourcePlatform==='polymarket'&&r.category==='Entertainment').length,1);
});

test('AI model capability and release questions remain Science, while actual IPO outcomes stay Economics', () => {
  assert.equal(classifyMarket({title:'Which company has the best AI model in September?'},{}).category,'Science');
  assert.equal(classifyMarket({title:'Will a Mythos-class model release happen this year?'},{}).category,'Science');
  assert.equal(classifyMarket({title:'Will the AI model company complete an IPO?'},{}).category,'Economics');
});
