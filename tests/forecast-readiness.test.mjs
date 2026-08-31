import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { CURATION_CONFIG, dailySelectionRunId } from '../lib/curation-core.js';
import { DAILY_FORECAST_QUESTION_TARGET, FORECAST_JOBS_PER_BATCH } from '../lib/forecast-core.js';
import { FORECAST_BATCH_ELAPSED_MS, FORECAST_BATCH_LEASE_MS, FORECAST_LEASE_CLAIM_SQL, VALID_FORECAST_SLATES_SQL } from '../lib/forecast-pipeline-core.js';
import { pipelineReportedFailure } from '../lib/pipeline-status-core.js';

const source = ts.createSourceFile('forecasting.ts', readFileSync(new URL('../lib/forecasting.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
function load(name, dependencies) {
  const node = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, `Missing actual function ${name}`);
  const text = stripTypeScriptTypes(node.getText(source).replace(/^export\s+/, ''));
  return new Function(...Object.keys(dependencies), `return (${text});`)(...Object.values(dependencies));
}
const readSelection = load('getScheduledForecastSelection', {
  CURATION_CONFIG, DAILY_FORECAST_QUESTION_TARGET, VALID_FORECAST_SLATES_SQL, dailySelectionRunId,
});
const now = new Date('2026-08-31T12:00:00Z');
const runId = dailySelectionRunId(now);
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE selection_runs(id TEXT PRIMARY KEY,status TEXT,config_version TEXT,selected_count INTEGER);
    CREATE TABLE selection_items(id INTEGER PRIMARY KEY,run_id TEXT,event_id TEXT);
    CREATE INDEX selection_run_items ON selection_items(run_id);`);
  const reads = [];
  let busy = false;
  const db = { prepare(sql) {
    let bindings = [];
    return {
      bind(...values) { bindings = values; return this; },
      async first() {
        if (sql === FORECAST_LEASE_CLAIM_SQL) return busy ? null : { owner: bindings[0] };
        reads.push({ sql, bindings });
        return sqlite.prepare(sql).get(...bindings) ?? null;
      },
      async run() { return {}; },
    };
  } };
  function seed({ actual=20, stored=20, status='completed', config=CURATION_CONFIG.configVersion, id=runId, duplicate=false } = {}) {
    sqlite.prepare('INSERT INTO selection_runs VALUES(?,?,?,?)').run(id,status,config,stored);
    const insert = sqlite.prepare('INSERT INTO selection_items(run_id,event_id) VALUES(?,?)');
    for (let index=0;index<actual;index++) insert.run(id, `event-${index}`);
    if (duplicate) insert.run(id,'event-0');
  }
  return { sqlite, db, reads, seed, setBusy(value) { busy=value; } };
}

test('current readiness executes the real shared valid-slate SQL, not historical readiness or stored counts', async () => {
  const cases = [
    { seed:null, expected:{status:'missing',selected:0,quotaMet:false} },
    { seed:{actual:0,status:'incomplete'}, expected:{status:'incomplete',selected:0,quotaMet:false} },
    { seed:{actual:19}, expected:{status:'completed',selected:19,quotaMet:false} },
    { seed:{stored:19}, expected:{status:'completed',selected:20,quotaMet:false} },
    { seed:{config:'old-config'}, expected:{status:'completed',selected:20,quotaMet:false} },
    { seed:{actual:19,duplicate:true}, expected:{status:'completed',selected:19,quotaMet:false} },
    { seed:{}, expected:{status:'completed',selected:20,quotaMet:true} },
  ];
  for (const item of cases) {
    const f=fixture();
    try {
      f.seed({id:'older-valid-slate'});
      if (item.seed) f.seed(item.seed);
      assert.deepEqual(await readSelection(f.db, now), {runId,...item.expected});
      assert.equal(f.reads.length,1, 'one bounded current-run validation statement');
      assert.equal(f.reads[0].bindings.at(-1),runId);
      const plan=f.sqlite.prepare('EXPLAIN QUERY PLAN '+f.reads[0].sql).all(...f.reads[0].bindings);
      assert.equal(plan.some((row)=>/SCAN sr\b/.test(row.detail)),false, 'validate one run by primary key, not all historical selections');
    } finally { f.sqlite.close(); }
  }
});

function batch(f, work, observations) {
  return load('runForecastBatch', {
    FORECAST_JOBS_PER_BATCH, FORECAST_BATCH_ELAPSED_MS, FORECAST_BATCH_LEASE_MS, FORECAST_LEASE_CLAIM_SQL,
    ensureForecastingReady: async () => {},
    getScheduledForecastSelection: (db) => readSelection(db,now),
    runLeasedForecastBatch: async (...args) => { observations.push(args); return work; },
  });
}

test('scheduled empty work and successful old-backlog work both report a missing current slate as failed', async () => {
  for (const work of [
    {configured:true,processed:0,completed:0,outcomes:[]},
    {configured:true,processed:2,completed:2,outcomes:[{eventId:'old-a',status:'completed'},{eventId:'old-b',status:'completed'}]},
  ]) {
    const f=fixture(), observations=[];
    try {
      f.seed({id:'older-valid-slate'});
      const result=await batch(f,work,observations)({DB:f.db});
      assert.equal(observations.length,1, 'old valid backlog work is still allowed to run');
      assert.equal(result.completed,work.completed);
      assert.deepEqual(result.outcomes,work.outcomes);
      assert.equal(result.selection.quotaMet,false);
      assert.equal(result.selection.runId,runId);
      assert.match(pipelineReportedFailure(result),/Daily selection.*20 questions/);
      assert.equal(f.reads.length,1);
    } finally { f.sqlite.close(); }
  }
});

test('ready current selection permits a successful no-op and busy still reports missing current selection', async () => {
  for (const ready of [true,false]) {
    const f=fixture(), observations=[];
    try {
      if (ready) f.seed(); else f.setBusy(true);
      const result=await batch(f,{configured:true,processed:0,completed:0,outcomes:[]},observations)({DB:f.db});
      assert.equal(result.selection.quotaMet,ready);
      assert.equal(result.busy,ready ? undefined : true);
      assert.equal(observations.length,Number(ready));
      if (ready) assert.equal(pipelineReportedFailure(result),null);
      else assert.match(pipelineReportedFailure(result),/Daily selection/);
      assert.equal(f.reads.length,1);
    } finally { f.sqlite.close(); }
  }
});

test('explicit event targets remain unchanged and do not read current-day selection', async () => {
  const f=fixture(), observations=[];
  try {
    const work={configured:true,processed:1,completed:1,outcomes:[{status:'completed'}]};
    const targets=['older-approved-event'];
    const result=await batch(f,work,observations)({DB:f.db},1,targets);
    assert.strictEqual(result,work);
    assert.strictEqual(observations[0][2],targets);
    assert.equal(result.selection,undefined);
    assert.equal(f.reads.length,0);
    assert.equal(pipelineReportedFailure(result),null);
  } finally { f.sqlite.close(); }
});
