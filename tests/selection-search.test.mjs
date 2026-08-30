import assert from 'node:assert/strict';
import test from 'node:test';
import { diversityAnchors, titleSimilarity } from '../lib/curation-core.js';
import { selectStrictBalancedSlate } from '../lib/curation-selection-core.js';

const titleConflict = (a, b) => titleSimilarity(a, b) >= .72 || diversityAnchors(a).some(anchor => diversityAnchors(b).includes(anchor));

test('generic Winner does not merge unrelated competitions; shared competitions remain blocked', () => {
  const mens = '2026 Men’s US Open Winner (Tennis)';
  const womens = '2026 Women’s US Open Winner (Tennis)';
  assert.equal(titleConflict(mens, "Ballon d'Or Winner 2026"), false);
  assert.equal(titleConflict(mens, womens), true);
  assert.equal(titleConflict('Will SpaceX launch another Starship before September?', 'Will SpaceX launch more than 20 times in October?'), true);
  assert.equal(titleConflict(mens, mens), true);
});

function quotasHold(selected, categories, sourceQuotas, categoryTarget, conflicts) {
  return selected.length === Object.values(sourceQuotas).reduce((a,b)=>a+b,0)
    && categories.every(category => selected.filter(c => c.category === category).length === categoryTarget)
    && Object.entries(sourceQuotas).every(([source, count]) => selected.filter(c => c.sourcePlatform === source).length === count)
    && selected.every((candidate,index) => selected.slice(index+1).every(other =>
      (candidate.diversityGroupId || candidate.sourceEventId) !== (other.diversityGroupId || other.sourceEventId)
      && !conflicts(candidate.title, other.title)));
}

test('a provider with sparse categories still receives its complete quota within a small search budget', () => {
  const categories = ['A','B','C','D','E'];
  const counts = {polymarket:[10,1,1,4,1],kalshi:[6,30,30,30,30]};
  const candidates = Object.entries(counts).flatMap(([sourcePlatform, counts]) => categories.flatMap((category,c) =>
    Array.from({length:counts[c]}, (_,i) => ({
      title:`${sourcePlatform}-${category}-${i}`, sourcePlatform, category,
      sourceEventId:`${sourcePlatform}-${category}-${sourcePlatform==='kalshi' && category==='A' ? 'shared' : i}`,
      eligible:true, selectionScore:1-c/10-i/1000+(sourcePlatform==='polymarket' ? .5 : 0), volume24h:100,
    })),
  ));
  const conflicts = (a,b) => a===b || [a,b].every(s => ['polymarket-D-0','polymarket-D-1'].includes(s));
  const sourceQuotas = {polymarket:10,kalshi:10};
  const result = selectStrictBalancedSlate(candidates, {categories, sourceQuotas, categoryTarget:4, sourceCategoryTarget:2, conflicts, maxSearchNodes:50});
  assert.equal(quotasHold(result,categories,sourceQuotas,4,conflicts), true);
  assert.equal(result.filter(c=>c.sourcePlatform==='polymarket'&&c.category==='A').length,4);
});

// An independent exhaustive oracle checks that category-order pruning cannot
// discard a feasible set when conflict patterns change the most scarce category.
function exhaustive(candidates, options) {
  const pool=candidates.filter(c => c.eligible && !c.alreadySelected && !options.blockedGroups.includes(c.diversityGroupId)
    && !options.recentTitles.some(title => options.conflicts(title,c.title)));
  const target=Object.values(options.sourceQuotas).reduce((a,b)=>a+b,0);
  function search(start,chosen) {
    if (chosen.length===target) return quotasHold(chosen,options.categories,options.sourceQuotas,options.categoryTarget,options.conflicts);
    if (pool.length-start < target-chosen.length) return false;
    for(let i=start;i<pool.length;i++) if(search(i+1,[...chosen,pool[i]])) return true;
    return false;
  }
  return search(0,[]);
}

test('bounded search agrees with exhaustive feasible-set checks over varied small conflict graphs', () => {
  let feasibleCount=0;
  for(let seed=1;seed<=80;seed++) {
    let state=seed;
    const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
    const categories=['A','B','C'];
    const edges=new Set();
    const key=(a,b)=>[a,b].sort().join('|');
    const candidates=Array.from({length:12},(_,i)=>({
      title:`title-${i}`,sourceEventId:`event-${i}`,diversityGroupId:`group-${i===11&&seed%4===0?10:i}`,
      category:categories[i%3],sourcePlatform:i<6?'polymarket':'kalshi',
      eligible:i!==0||seed%5!==0,alreadySelected:i===1&&seed%7===0,
      selectionScore:random(),volume24h:100,
    }));
    for(let i=0;i<candidates.length;i++)for(let j=i+1;j<candidates.length;j++) {
      if(random()<.14)edges.add(key(candidates[i].title,candidates[j].title));
    }
    if(seed%6===0)edges.add(key('old title','title-2'));
    const options={categories,sourceQuotas:{polymarket:3,kalshi:3},categoryTarget:2,sourceCategoryTarget:1,
      conflicts:(a,b)=>edges.has(key(a,b)),blockedGroups:seed%8===0?['group-3']:[],recentTitles:['old title'],maxSearchNodes:10000};
    const expected=exhaustive(candidates,options);
    if(expected)feasibleCount++;
    const result=selectStrictBalancedSlate(candidates,options);
    assert.equal(quotasHold(result,categories,options.sourceQuotas,2,options.conflicts),expected,`seed ${seed}`);
    assert.ok(result.every(c=>c.eligible&&!c.alreadySelected&&!options.blockedGroups.includes(c.diversityGroupId)));
  }
  assert.ok(feasibleCount>20&&feasibleCount<80,'exercise both feasible and infeasible graphs');
});
