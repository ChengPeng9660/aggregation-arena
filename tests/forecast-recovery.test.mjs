import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { FORECAST_CONFIG_VERSION, FORECAST_JOBS_PER_BATCH } from '../lib/forecast-core.js';
import { publishedForecastSql, VALID_FORECAST_SLATES_SQL } from '../lib/forecast-pipeline-core.js';
import { normalizeDistribution } from '../lib/event-core.js';

const sources = Object.fromEntries(['forecasting', 'arena', 'polymarket'].map((name) => {
  const url = new URL(`../lib/${name}.ts`, import.meta.url);
  return [name, ts.createSourceFile(url.pathname, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true)];
}));

// Execute the actual private function bodies and query templates. AST lookup keeps
// these tests independent of whitespace and function order; no implementation copy.
function declaration(module, name) {
  let found;
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(sources[module]) === name) found = node;
    else if (!found) ts.forEachChild(node, visit);
  }
  visit(sources[module]);
  assert.ok(found, `Missing ${module}.${name}`);
  return found;
}
function evaluate(expression, dependencies = {}) {
  return new Function(...Object.keys(dependencies), `return (${expression});`)(...Object.values(dependencies));
}
function loadFunction(module, name, dependencies) {
  const source = declaration(module, name).getText(sources[module]).replace(/^export\s+/, '');
  return evaluate(stripTypeScriptTypes(source), dependencies);
}
function queryFrom(functionName, marker, dependencies = {}) {
  let template;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'prepare'
      && node.arguments[0]?.getText(sources.forecasting).includes(marker)) template = node.arguments[0];
    else if (!template) ts.forEachChild(node, visit);
  }
  visit(declaration('forecasting', functionName));
  assert.ok(template, `Missing ${functionName} query: ${marker}`);
  return evaluate(template.getText(sources.forecasting), dependencies);
}

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const [module, name] of [['arena', 'SCHEMA_STATEMENTS'], ['polymarket', 'CURATION_SCHEMA'], ['forecasting', 'FORECAST_SCHEMA']]) {
    const statements = evaluate(declaration(module, name).initializer.getText(sources[module]));
    for (const statement of statements) sqlite.exec(statement);
  }
  const db = {
    prepare(text) {
      const statement = sqlite.prepare(text);
      let bindings = [];
      return {
        bind(...values) { bindings = values; return this; },
        async all() { return { results: statement.all(...bindings) }; },
        async first() { return statement.get(...bindings) ?? null; },
        async run() { return { meta: statement.run(...bindings) }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const writes = {
    getD1: () => db,
    ensureArenaReady: async () => {},
    assertForecastAdmission: async () => {},
    syncAutomatedAggregates: async () => [],
    writeAutomatedAudit: async () => {},
    normalizeDistribution,
    ArenaError: Error,
    upsertPrediction: loadFunction('arena', 'upsertPrediction', { getD1: () => db }),
    upsertPredictionOutcomes: loadFunction('arena', 'upsertPredictionOutcomes', { getD1: () => db }),
  };
  const repair = loadFunction('forecasting', 'repairMissingForecastPredictions', {
    FORECAST_CONFIG_VERSION, FORECAST_JOBS_PER_BATCH, publishedForecastSql,
    safeJson: loadFunction('forecasting', 'safeJson'),
    errorMessage: loadFunction('forecasting', 'errorMessage'),
    recordAutomatedForecast: loadFunction('arena', 'recordAutomatedForecast', writes),
    recordAutomatedEventForecast: loadFunction('arena', 'recordAutomatedEventForecast', writes),
  });
  sqlite.prepare("INSERT INTO participants (id,name,status) VALUES ('p0','Model 0','active')").run();
  function event(id, type = 'binary') {
    sqlite.prepare('INSERT INTO events (id,title,event_type,close_time) VALUES (?,?,?,?)').run(id,id,type,'2099-09-05T00:00:00Z');
    if (type === 'categorical') for (const key of ['a', 'b']) sqlite.prepare('INSERT INTO event_outcomes(event_id,outcome_key,label) VALUES (?,?,?)').run(id,key,key);
  }
  function run(id, probabilities, version = FORECAST_CONFIG_VERSION, participant = 'p0') {
    sqlite.prepare(`INSERT INTO model_forecast_runs
      (id,context_id,event_id,participant_id,model_id,prompt_version,status,probabilities_json,created_at,completed_at)
      VALUES (?,?,?,?,?,?,'completed',?,?,?)`).run(`${id}-${participant}`,`ctx-${id}`,id,participant,'model',version,JSON.stringify(probabilities),'2026-08-31T01:00:00Z','2026-08-31T01:00:01Z');
  }
  function selected(id, market = `market-${id}`, runId = 'daily', rank = 1) {
    sqlite.prepare('INSERT INTO polymarket_candidates (market_id,source_event_id,title,category) VALUES (?,?,?,?)').run(market,id,id,'Sports');
    sqlite.prepare(`INSERT INTO selection_items (run_id,market_id,event_id,category,rank,selection_score,price_at_selection,volume_24h,total_volume,liquidity,selected_at)
      VALUES (?,?,?,'Sports',?,1,0.5,100,100,100,'2026-08-31T00:10:00Z')`).run(runId,market,id,rank);
  }
  const publication = (id) => sqlite.prepare(`SELECT ${publishedForecastSql('e', "'p0'")} AS value FROM events e WHERE e.id=?`).get(id).value;
  return { sqlite, db, repair, event, run, selected, publication };
}

function pendingQuery(modelIds = ['p0']) {
  return queryFrom('runLeasedForecastBatch', 'WITH forecast_models', {
    modelValues: modelIds.map(() => '(?, ?)').join(', '),
    dailyRunCte: `, ${VALID_FORECAST_SLATES_SQL}`,
    dailyRunJoin: 'JOIN valid_daily_runs daily_run ON daily_run.run_id=si.run_id',
    targetEventClause: '', FORECAST_CONFIG_VERSION, publishedForecastSql,
  });
}
function addSlate(f, runId = 'daily') {
  f.sqlite.prepare("INSERT INTO selection_runs(id,config_version,taxonomy_version,status,selected_count) VALUES (?,'test','test','completed',20)").run(runId);
  for (let i = 0; i < 20; i++) { f.event(`e${i}`); f.selected(`e${i}`, `m${i}`, runId, i + 1); }
}

test('actual recovery never converts missing probabilities to a published zero', async () => {
  const f = fixture();
  try {
    f.event('empty-binary'); f.run('empty-binary', {});
    f.event('null-json'); f.run('null-json', null);
    f.event('partial-vector', 'categorical'); f.run('partial-vector', { a: 0.6 });
    assert.deepEqual(await f.repair(f.db), []);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM predictions').get().n, 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM prediction_outcomes').get().n, 0);
    for (const id of ['empty-binary', 'null-json', 'partial-vector']) {
      const row = f.sqlite.prepare('SELECT status,error FROM model_forecast_runs WHERE event_id=?').get(id);
      assert.equal(row.status, 'failed');
      assert.match(row.error, /invalid or incomplete probabilities/);
      assert.equal(f.publication(id), 0);
    }
  } finally { f.sqlite.close(); }
});

test('actual recovery repairs wrong-version binary and full invalid categorical publication exactly once', async () => {
  const f = fixture();
  try {
    f.event('binary'); f.run('binary', { yes: 0.7, no: 0.3 });
    f.sqlite.prepare("INSERT INTO predictions(event_id,participant_id,participant_name,kind,version,probability) VALUES ('binary','p0','Model 0','forecaster','old',0.2)").run();
    f.event('category', 'categorical'); f.run('category', { a: 0.6, b: 0.4 });
    for (const key of ['a', 'b']) f.sqlite.prepare("INSERT INTO prediction_outcomes(event_id,participant_id,participant_name,kind,version,outcome_key,probability) VALUES ('category','p0','Model 0','forecaster',?,?,0.2)").run(FORECAST_CONFIG_VERSION,key);
    assert.equal(f.publication('binary'), 0); assert.equal(f.publication('category'), 0);
    assert.equal((await f.repair(f.db)).length, 2);
    assert.equal(f.publication('binary'), 1); assert.equal(f.publication('category'), 1);
    assert.equal(f.sqlite.prepare("SELECT probability FROM predictions WHERE event_id='binary'").get().probability, 0.7);
    assert.deepEqual(f.sqlite.prepare("SELECT probability FROM prediction_outcomes WHERE event_id='category' ORDER BY outcome_key").all().map((row) => row.probability), [0.6,0.4]);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM prediction_history').get().n, 1);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM prediction_outcome_history').get().n, 2);
    assert.deepEqual(await f.repair(f.db), []);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM prediction_history').get().n, 1);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM prediction_outcome_history').get().n, 2);
  } finally { f.sqlite.close(); }
});

test('an old prompt response is not published and does not block the real queue or run claim', async () => {
  const f = fixture();
  try {
    addSlate(f); f.run('e0', { yes: 0.8, no: 0.2 }, 'old');
    assert.deepEqual(await f.repair(f.db), []);
    assert.equal(f.publication('e0'), 0);
    const jobs = f.sqlite.prepare(pendingQuery()).all('p0',0,'test',20,20);
    assert.equal(jobs.length, 20);
    assert.ok(jobs.some((job) => job.id === 'e0'));
    const claim = f.sqlite.prepare(queryFrom('forecastEvent', 'INSERT INTO model_forecast_runs'));
    const claimed = claim.run('new-run','ctx-e0','e0','p0','model',FORECAST_CONFIG_VERSION,'2026-08-31T02:00:00Z');
    assert.equal(claimed.changes, 1);
    const current = f.sqlite.prepare("SELECT status,prompt_version,probabilities_json FROM model_forecast_runs WHERE event_id='e0'").get();
    assert.equal(current.status, 'running'); assert.equal(current.prompt_version, FORECAST_CONFIG_VERSION);
    assert.equal(current.probabilities_json, null); assert.equal(f.publication('e0'), 0);
  } finally { f.sqlite.close(); }
});

test('pending selection returns at most one job per event/model despite duplicate event items', () => {
  const f = fixture();
  try {
    addSlate(f);
    f.selected('e0', 'extra-market', 'daily', 21);
    f.sqlite.prepare("INSERT INTO selection_runs(id,config_version,taxonomy_version,status,selected_count) VALUES ('overlap','test','test','completed',20)").run();
    for (let i = 0; i < 20; i++) f.selected(`e${i}`, `overlap-${i}`, 'overlap', i + 1);
    const jobs = f.sqlite.prepare(pendingQuery()).all('p0',0,'test',20,20);
    assert.equal(jobs.length, 20);
    assert.equal(new Set(jobs.map((job) => `${job.id}/${job.target_participant_id}`)).size, 20);
    assert.ok(jobs.every((job) => job.run_id === 'daily'));
  } finally { f.sqlite.close(); }
});

// The runtime schema supplies the actual admission triggers. Exercise the real
// upsert functions and D1-style transactional batch; no trigger SQL is copied.
for (const eventType of ['binary', 'categorical']) {
  for (const race of ['locked', 'expired', 'ownership_changed']) {
    test(`${eventType}: ${race} after precheck rolls back completion, forecast and history`, async () => {
      const f = fixture();
      try {
        f.event('guarded', eventType);
        f.run('guarded', eventType === 'binary' ? {yes:0.2,no:0.8} : {a:0.2,b:0.8});
        const runId = 'guarded-p0';
        const table = eventType === 'binary' ? 'predictions' : 'prediction_outcomes';
        const history = eventType === 'binary' ? 'prediction_history' : 'prediction_outcome_history';
        const insert = eventType === 'binary'
          ? `INSERT INTO predictions(event_id,participant_id,participant_name,kind,version,probability,components_json) VALUES ('guarded','p0','Model 0','forecaster',?,0.2,'{}')`
          : `INSERT INTO prediction_outcomes(event_id,participant_id,participant_name,kind,version,outcome_key,probability,components_json) VALUES ('guarded','p0','Model 0','forecaster',?,'a',0.2,'{}')`;
        f.sqlite.prepare(insert).run(FORECAST_CONFIG_VERSION);
        f.sqlite.prepare("UPDATE model_forecast_runs SET status='running',completed_at=NULL WHERE id=?").run(runId);
        // Model code has already observed an admissible event and owned run.
        assert.equal(f.sqlite.prepare("SELECT status FROM events WHERE id='guarded'").get().status,'open');
        assert.equal(f.sqlite.prepare('SELECT status FROM model_forecast_runs WHERE id=?').get(runId).status,'running');
        if (race === 'locked') f.sqlite.exec("UPDATE events SET status='locked' WHERE id='guarded'");
        else if (race === 'expired') f.sqlite.exec("UPDATE events SET close_time='2000-01-01T00:00:00Z' WHERE id='guarded'");
        else f.sqlite.prepare('UPDATE model_forecast_runs SET id=? WHERE id=?').run('replacement-run',runId);
        const completion = f.db.prepare(queryFrom('forecastEvent', "SET status='completed'"))
          .bind(0.7,0.3,JSON.stringify({yes:0.7,no:0.3}),'late rationale','[]','{}',1,new Date().toISOString(),runId);
        const options = {db:f.db,precedingStatements:[completion]};
        const components = JSON.stringify({runId});
        const write = eventType === 'binary'
          ? loadFunction('arena','upsertPrediction',{getD1:()=>f.db})(
            'guarded',{participantId:'p0',participantName:'Model 0',probability:0.7,rationale:'late'},
            'forecaster',FORECAST_CONFIG_VERSION,components,options)
          : loadFunction('arena','upsertPredictionOutcomes',{getD1:()=>f.db})(
            'guarded','p0','Model 0',{a:0.7,b:0.3},'late','forecaster',FORECAST_CONFIG_VERSION,components,options);
        await assert.rejects(write);
        assert.deepEqual(f.sqlite.prepare(`SELECT probability FROM ${table} WHERE event_id='guarded'`).all().map(row=>row.probability),[0.2]);
        assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${history}`).get().n,0);
        const currentId = race === 'ownership_changed' ? 'replacement-run' : runId;
        const current = f.sqlite.prepare('SELECT status,completed_at FROM model_forecast_runs WHERE id=?').get(currentId);
        assert.equal(current.status,'running');
        assert.equal(current.completed_at,null);
      } finally { f.sqlite.close(); }
    });
  }
}

test('admission triggers preserve open manual forecasts and resolved aggregate backfills', async () => {
  const f = fixture();
  try {
    f.event('manual');
    const write=loadFunction('arena','upsertPrediction',{getD1:()=>f.db});
    const row={participantId:'p0',participantName:'Model 0',probability:0.6,rationale:null};
    await write('manual',row,'forecaster',FORECAST_CONFIG_VERSION,'{}',{db:f.db});
    f.sqlite.exec("UPDATE events SET status='resolved' WHERE id='manual'");
    await assert.rejects(write('manual',{...row,probability:0.7},'forecaster',FORECAST_CONFIG_VERSION,'{}',{db:f.db}));
    await write('manual',{...row,participantId:'aggregate-0'},'aggregate','arena-v1','{}',{db:f.db});
    assert.equal(f.sqlite.prepare("SELECT probability FROM predictions WHERE participant_id='p0'").get().probability,0.6);
    assert.equal(f.sqlite.prepare("SELECT probability FROM predictions WHERE participant_id='aggregate-0'").get().probability,0.6);
  } finally {f.sqlite.close();}
});
