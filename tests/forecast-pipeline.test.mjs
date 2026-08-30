import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { FORECAST_CONFIG_VERSION } from '../lib/forecast-core.js';
import {
  FORECAST_LEASE_CLAIM_SQL, VALID_FORECAST_SLATES_SQL, publishedForecastSql,
  summarizeDailyForecasts, waitForForecast,
} from '../lib/forecast-pipeline-core.js';

const models = Array.from({length:12}, (_,i)=>({participantId:`p${i}`,participantName:`Model ${i}`,modelId:`m${i}`}));
const utcDate='2026-08-31';
const now=Date.parse(`${utcDate}T10:00:00Z`);
const base={utcDate,runId:'today',selectionStatus:'completed',selectedQuestions:20,models,now};
const jobs = () => models.flatMap(model=>Array.from({length:20},(_,i)=>({
  participant_id:model.participantId,event_id:`e${i}`,event_status:'open',close_time:'2026-09-05T00:00:00Z',published:0,
})));

test('the goal is each model on the same twenty events, not twenty calls',()=>{
  const rows=jobs();
  rows.slice(0,20).forEach(row=>{row.published=1;});
  const result=summarizeDailyForecasts({...base,rows});
  assert.equal(result.modelEventTarget,240);
  assert.equal(result.completed,20);
  assert.equal(result.pending,220);
  assert.equal(result.perModel[0].completed,20);
  assert.equal(result.perModel[1].completed,0);
  assert.equal(result.status,'queued');
  rows.forEach(row=>{row.published=1;});
  assert.equal(summarizeDailyForecasts({...base,rows}).status,'completed');
});

test('missing and partial current-day slates remain blocked with a real deficit',()=>{
  for(const [selectionStatus,selectedQuestions] of [[null,0],['incomplete',0],['completed',19]]) {
    const result=summarizeDailyForecasts({...base,runId:null,selectionStatus,selectedQuestions,rows:[]});
    assert.equal(result.status,'blocked_selection');
    assert.equal(result.pending,240);
    assert.equal(result.utcDate,'2026-08-31');
    assert.ok(result.blockedReason.includes('2026-08-31'));
    assert.equal(result.perModel[11].unattempted,20);
  }
});

test('failure, stale running and missed deadline are visible; recovery clears errors',()=>{
  const rows=jobs().map(row=>({...row,published:1}));
  Object.assign(rows[0],{published:0,latest_status:'failed',latest_error:'gateway timeout'});
  Object.assign(rows[1],{published:0,latest_status:'running',latest_created_at:'2026-08-31T09:00:00Z'});
  Object.assign(rows[2],{published:0,latest_status:'running',latest_created_at:'2026-08-31T09:59:00Z'});
  Object.assign(rows[3],{published:0,close_time:'2026-08-31T10:00:00Z'});
  const state=summarizeDailyForecasts({...base,rows});
  assert.equal(state.completed,236);
  assert.equal(state.failed,2);
  assert.equal(state.running,1);
  assert.equal(state.missed,1);
  assert.equal(state.status,'missed_deadline');
  assert.equal(state.perModel.length,12);
  rows.forEach(row=>{row.published=1;});
  const recovered=summarizeDailyForecasts({...base,rows});
  assert.equal(recovered.status,'completed');
  assert.equal(recovered.failed,0);
  assert.equal(recovered.perModel[0].latestError,null);
});

test('valid slate SQL keeps yesterday open work but rejects wrong config and corrupt counts',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE selection_runs(id TEXT,status TEXT,config_version TEXT,selected_count INTEGER); CREATE TABLE selection_items(run_id TEXT,event_id TEXT); CREATE TABLE events(id TEXT,status TEXT,close_time TEXT);');
    const insertRun=db.prepare('INSERT INTO selection_runs VALUES (?,?,?,?)');
    const insertItem=db.prepare('INSERT INTO selection_items VALUES (?,?)');
    const insertEvent=db.prepare('INSERT INTO events VALUES (?,?,?)');
    for(const [id,config,n] of [['yesterday','current',20],['today','current',20],['corrupt','current',19],['legacy','old',20]]) {
      insertRun.run(id,'completed',config,20);
      for(let i=0;i<n;i++) {insertItem.run(id,`${id}-${i}`);insertEvent.run(`${id}-${i}`,i===0?'locked':'open','2026-09-05T00:00:00Z');}
    }
    const rows=db.prepare(`WITH ${VALID_FORECAST_SLATES_SQL} SELECT DISTINCT si.run_id FROM selection_items si JOIN valid_daily_runs v ON v.run_id=si.run_id JOIN events e ON e.id=si.event_id WHERE e.status='open' AND datetime(e.close_time)>datetime(?) ORDER BY si.run_id`).all('current',20,'2026-08-31T10:00:00Z');
    assert.deepEqual(rows.map(r=>r.run_id),['today','yesterday']);
  } finally {db.close();}
});

test('publication predicate requires the full current-version categorical vector',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE events(id TEXT,event_type TEXT); CREATE TABLE predictions(event_id TEXT,participant_id TEXT,kind TEXT,version TEXT,probability REAL); CREATE TABLE event_outcomes(event_id TEXT,outcome_key TEXT); CREATE TABLE prediction_outcomes(event_id TEXT,participant_id TEXT,kind TEXT,version TEXT,outcome_key TEXT,probability REAL); INSERT INTO events VALUES ('binary','binary'),('category','categorical'); INSERT INTO event_outcomes VALUES ('category','yes'),('category','no');`);
    const query=db.prepare(`SELECT e.id,${publishedForecastSql('e',"'p0'")} AS published FROM events e ORDER BY e.id`);
    db.prepare('INSERT INTO predictions VALUES (?,?,?,?,?)').run('binary','p0','forecaster','old',0.6);
    db.prepare('INSERT INTO prediction_outcomes VALUES (?,?,?,?,?,?)').run('category','p0','forecaster',FORECAST_CONFIG_VERSION,'yes',0.6);
    assert.deepEqual(query.all().map(r=>r.published),[0,0]);
    db.prepare('UPDATE predictions SET version=?').run(FORECAST_CONFIG_VERSION);
    db.prepare('INSERT INTO prediction_outcomes VALUES (?,?,?,?,?,?)').run('category','p0','forecaster',FORECAST_CONFIG_VERSION,'no',0.4);
    assert.deepEqual(query.all().map(r=>r.published),[1,1]);
  } finally {db.close();}
});

test('lease admits one owner, recovers at actual expiry, and rejects old-owner release',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE forecast_batch_lease(id TEXT PRIMARY KEY,owner TEXT NOT NULL,acquired_at TEXT NOT NULL,expires_at TEXT NOT NULL)');
    const claim=db.prepare(FORECAST_LEASE_CLAIM_SQL);
    assert.equal(claim.get('a','2026-08-31T10:00:00Z','2026-08-31T10:20:00Z').owner,'a');
    assert.equal(claim.get('b','2026-08-31T10:19:59Z','2026-08-31T10:39:59Z'),undefined);
    assert.equal(claim.get('b','2026-08-31T10:20:00Z','2026-08-31T10:40:00Z').owner,'b');
    db.prepare("DELETE FROM forecast_batch_lease WHERE id='forecast' AND owner=?").run('a');
    assert.equal(db.prepare('SELECT owner FROM forecast_batch_lease').get().owner,'b');
  } finally {db.close();}
});

test('abort cancels provider pacing promptly',async()=>{
  const controller=new AbortController();
  const pending=waitForForecast(10_000,controller.signal);
  controller.abort(new Error('batch elapsed'));
  await assert.rejects(pending,/batch elapsed/);
});

test('gateway forwards cancellation to the actual AI binding and does not retry an aborted batch',async()=>{
  let source=stripTypeScriptTypes(readFileSync(new URL('../lib/model-gateway.ts',import.meta.url),'utf8'));
  source=source.replace('@/lib/forecast-core.js',new URL('../lib/forecast-core.js',import.meta.url).href)
    .replace('@/lib/forecast-pipeline-core.js',new URL('../lib/forecast-pipeline-core.js',import.meta.url).href);
  const {runModelGateway}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const controller=new AbortController();
  let calls=0;
  const AI={run:async(_model,_request,options)=>new Promise((_resolve,reject)=>{
    calls++; assert.ok(options.signal instanceof AbortSignal);
    options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
    queueMicrotask(()=>controller.abort(new Error('batch elapsed')));
  })};
  await assert.rejects(runModelGateway({AI,PROPHET_CLOUDFLARE_MODEL_ID_MAP:'{"test":"provider/test"}'},
    {modelId:'test',messages:[],maxTokens:1,temperature:0.1,seed:1,signal:controller.signal}),/batch elapsed/);
  assert.equal(calls,1);
});
