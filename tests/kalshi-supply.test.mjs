import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import ts from 'typescript';
import * as curation from '../lib/curation-core.js';
import { createKalshiGetHeaders } from '../lib/kalshi-auth-core.js';

const file = new URL('../lib/polymarket.ts', import.meta.url);
const source = ts.createSourceFile(file.pathname, readFileSync(file,'utf8'), ts.ScriptTarget.Latest, true);
// Exercise the real discovery and diversity-accounting declarations. Transport
// has its own paced/429 tests; this fixture substitutes that boundary only.
const moduleBody=stripTypeScriptTypes(source.statements.filter(node => !ts.isImportDeclaration(node)
  && !(ts.isFunctionDeclaration(node)&&node.name?.text==='fetchIntakeJson'))
  .map(node=>node.getText(source).replace(/^export\s+/,'' )).join('\n'));
function load(fetchIntakeJson) {
  const dependencies={...curation,fetchIntakeJson,createKalshiGetHeaders};
  return new Function(...Object.keys(dependencies), `${moduleBody}\nreturn {fetchKalshiEventPayloads,recordKalshiDiscoveryCandidate};`)(...Object.values(dependencies));
}
const now=new Date('2026-08-31T00:00:00Z');
const iso=days=>new Date(now.getTime()+days*86_400_000).toISOString();
function event(id,category,title) {
  return {event_ticker:id,series_ticker:id.split('-')[0],category,title,
    markets:[{ticker:`${id}-Y`,event_ticker:id,title,yes_sub_title:'Yes',
      rules_primary:'Resolves according to the final result published by the official source.',
      status:'active',last_price_dollars:'0.5000',volume_24h_fp:'100.00',volume_fp:'1000.00',
      open_interest_fp:'100.00',open_time:iso(-10),expected_expiration_time:iso(10),close_time:iso(14)}]};
}
const fillerTitles=['amber turbine becomes operational','birch research passes calibration','cobalt protocol receives approval','dahlia project reaches completion'];
const nextScience=['Will NASA confirm ice on the Moon?','Will a malaria vaccine succeed in trials?','Will Anthropic release a safety report?'];
const nextEntertainment=['Will Adele release a new album?','Who will be TIME Person of the Year?','Will Minecraft exceed its player record?'];
function fixture(blocked) {
  const calls=[];
  const transport=async(url,budget)=>{
    budget.diagnostics.requests++;
    const category=url.searchParams.get('category');
    if(url.pathname.endsWith('/series')){
      const prefix=category==='Science and Technology'?'SCI':category==='Entertainment'?'ENT':category.slice(0,3).toUpperCase();
      return {series:[{ticker:`${prefix}0`,volume_fp:'10000'},{ticker:`${prefix}1`,volume_fp:'9000'},{ticker:`${prefix}2`,volume_fp:'8000'}]};
    }
    const series=url.searchParams.get('series_ticker');calls.push(series);
    if(series==='SCI0')return {events:Array.from({length:6},(_,i)=>event(`SCI0-${i}`,'Science and Technology',`Will SpaceX launch its rocket before September ${i+1}?`))};
    if(series==='ENT0')return {events:Array.from({length:6},(_,i)=>event(`ENT0-${i}`,'Entertainment',`Movie ${i} Rotten Tomatoes score above 90?`))};
    if(series==='SCI1')return {events:nextScience.map((title,i)=>event(`SCI1-${i}`,'Science and Technology',title))};
    if(series==='ENT1')return {events:nextEntertainment.map((title,i)=>event(`ENT1-${i}`,'Entertainment',title))};
    if(series==='SCI2')return {events:[event('SCI2-0','Science and Technology','Will CERN observe a new particle?')]};
    const categories={POL:'Politics',ECO:'Economics',SPO:'Sports'};
    const sourceCategory=categories[series.slice(0,3)];
    return {events:sourceCategory?fillerTitles.map((title,i)=>event(`${series}-${i}`,sourceCategory,title)):[]};
  };
  return {lib:load(transport),calls,blocked};
}

test('different source groups with the same SpaceX or Rotten Tomatoes theme do not prematurely satisfy discovery', async()=>{
  const {lib,calls}=fixture();
  const result=await lib.fetchKalshiEventPayloads(now);
  assert.ok(calls.includes('SCI1'));
  assert.ok(calls.includes('ENT1'));
  assert.ok(!calls.includes('SCI2')&&!calls.includes('ENT2'),'stop once a compatible four-question witness exists');
  assert.equal(result.events.filter(row=>row.category==='Science and Technology').length,9,'preserve source records even when correlated');
  assert.equal(result.events.filter(row=>row.category==='Entertainment').length,9);
  assert.ok(calls.length<=24);
  for(const category of ['Science and Technology','Entertainment']){
    const selected=result.events.filter(row=>row.category===category&&!row.event_ticker.endsWith('-Y'));
    const witnesses=[selected[0],...selected.filter(row=>row.event_ticker.startsWith(category==='Entertainment'?'ENT1':'SCI1'))]
      .map(row=>curation.normalizeKalshiMarket(row,row.markets[0],now));
    const validity=curation.validateDailySlate(witnesses);
    assert.equal(witnesses.length,4);assert.equal(validity.uniqueDiversityGroups,true);assert.equal(validity.uniqueTitles,true);
  }
});

test('used groups never count toward the compatible witness, so next-day discovery continues to fresh questions', async()=>{
  const {lib,calls}=fixture();
  const result=await lib.fetchKalshiEventPayloads(now,new Set(['kalshi-event:SCI1-0']));
  assert.ok(calls.includes('SCI2'));
  assert.ok(result.events.some(row=>row.event_ticker==='SCI1-0'),'keep refresh data for blocked questions');
  assert.ok(result.events.some(row=>row.event_ticker==='SCI2-0'));
  assert.ok(calls.length<=24);
});

test('compatible discovery is bounded by the series budget when an entire category contains near clones', async()=>{
  let count=0;
  const lib=load(async(url,budget)=>{
    budget.diagnostics.requests++;
    if(url.pathname.endsWith('/series'))return {series:url.searchParams.get('category')==='Science and Technology'
      ?Array.from({length:50},(_,i)=>({ticker:`SPACE${i}`,volume_fp:String(1000-i)})):[]};
    count++;
    const ticker=url.searchParams.get('series_ticker');
    return {events:[event(ticker,'Science and Technology',`Will SpaceX launch before September ${count}?`)]};
  });
  const result=await lib.fetchKalshiEventPayloads(now);
  assert.equal(count,24);
  assert.ok(result.diagnostics.limitsReached.includes('series_request_limit'));
  assert.equal(result.events.length,24,'do not alter or discard real collected questions to inflate independence');
});
