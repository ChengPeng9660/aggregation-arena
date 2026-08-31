import test from 'node:test';
import assert from 'node:assert/strict';
import { CANONICAL_CATEGORIES, CURATION_CONFIG, evaluateDailyEligibility,
  selectDailyAvailableCandidates, validateDailySlate } from '../lib/curation-core.js';
import { selectAvailableSlate } from '../lib/curation-selection-core.js';

const now = new Date('2026-08-31T00:00:00Z');
function candidate(index, overrides = {}) {
  return { marketId: `market-${index}`, sourceEventId: `event-${index}`, diversityGroupId: `group-${index}`,
    sourcePlatform: 'polymarket', title: `unique${index}`, category: CANONICAL_CATEGORIES[index % 5],
    description: 'The official source determines the result by the specified closing date.', rules: '',
    outcomes: ['Yes', 'No'], closeTime: '2026-09-30T00:00:00Z', startTime: '2026-08-01T00:00:00Z',
    yesPrice: 0.5, volume24h: 8000, totalVolume: 40000, liquidity: 8000,
    active: true, closed: false, acceptingOrders: true, eligible: true, regularEligible: true,
    selectionScore: 1 - index / 100, ...overrides };
}

test('fallback relaxes only Polymarket daily volume and retains rejection provenance', () => {
  const fallback = candidate(0, { volume24h: 1000 });
  assert.deepEqual(evaluateDailyEligibility(fallback, now).reasons, ['low_24h_volume']);
  assert.equal(evaluateDailyEligibility(fallback, now).fallbackEligible, true);
  assert.equal(evaluateDailyEligibility(fallback, now).regularEligible, false);
  for (const invalid of [{ volume24h: 999 }, { totalVolume: 34999 }, { liquidity: 7499 },
    { closeTime: '2026-09-01T00:00:00Z' }, { startTime: '2026-08-30T23:00:00Z' },
    { yesPrice: 0.99 }, { closed: true }, { description: '', rules: '' }]) {
    assert.equal(evaluateDailyEligibility({ ...fallback, ...invalid }, now).eligible, false, JSON.stringify(invalid));
  }
  assert.equal(evaluateDailyEligibility(candidate(1, { sourcePlatform: 'kalshi', volume24h: 24 }), now).eligible, false);
});

test('full regular balanced supply preserves both source and category targets', () => {
  const selected = selectDailyAvailableCandidates(Array.from({ length: 20 }, (_, i) => candidate(i,
    { sourcePlatform: i < 10 ? 'polymarket' : 'kalshi' })));
  assert.equal(validateDailySlate(selected).valid, true);
});

test('twenty regular questions fill a source outage before considering lower-volume questions', () => {
  const pool = Array.from({ length: 20 }, (_, i) => candidate(i, { category: 'Politics' }));
  pool.push(candidate(99, { sourcePlatform: 'kalshi', category: 'Science', regularEligible: false, selectionScore: 100 }));
  const selected = selectDailyAvailableCandidates(pool);
  assert.equal(selected.length, 20);
  assert.ok(selected.every(c => c.regularEligible));
  assert.equal(validateDailySlate(selected, { requireBalance: false }).valid, true);
  assert.equal(validateDailySlate(selected).valid, false);
});

test('lower-volume questions fill only missing slots without permitting duplicates or recent questions', () => {
  const pool = Array.from({ length: 20 }, (_, i) => candidate(i,
    { regularEligible: i < 17, volume24h: i < 17 ? 8000 : 1000 }));
  pool.push(candidate(90, { title: 'recentlyseen', selectionScore: 10 }));
  pool.push(candidate(91, { diversityGroupId: 'blocked', selectionScore: 10 }));
  pool.push(candidate(92, { eligible: false, selectionScore: 10 }));
  pool.push(candidate(93, { alreadySelected: true, selectionScore: 10 }));
  const selected = selectDailyAvailableCandidates(pool,
    { recentTitles: ['recentlyseen'], blockedDiversityGroupIds: ['blocked'] });
  assert.equal(selected.length, 20);
  assert.equal(selected.filter(c => !c.regularEligible).length, 3);
  assert.equal(validateDailySlate(selected, { requireBalance: false }).valid, true);
  assert.ok(selected.every(c => Number(c.marketId.split('-')[1]) < 20));
  assert.equal(validateDailySlate(selected.slice(1), { requireBalance: false }).valid, false);
  assert.equal(validateDailySlate([...selected.slice(1), selected[1]], { requireBalance: false }).valid, false);
});

test('availability search can discard the highest-ranked conflict hub to complete twenty', () => {
  const pool = [candidate(99, { title: 'hub', selectionScore: 100 }),
    ...Array.from({ length: 20 }, (_, i) => candidate(i))];
  const chosen = selectAvailableSlate(pool, { categories: CANONICAL_CATEGORIES,
    sourceQuotas: CURATION_CONFIG.sourceQuotas, categoryTarget: 4, target: 20,
    conflicts: (a, b) => (a === 'hub' && ['unique0', 'unique1'].includes(b))
      || (b === 'hub' && ['unique0', 'unique1'].includes(a)) });
  assert.equal(chosen.length, 20);
  assert.ok(chosen.every(c => c.title !== 'hub'));
});
