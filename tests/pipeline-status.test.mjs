import assert from 'node:assert/strict';
import test from 'node:test';
import { pipelineReportedFailure } from '../lib/pipeline-status-core.js';

test('fulfilled source orchestration cannot hide a failed required market', () => {
  const result = {sync:{events:24, sourceStats:{polymarket:{status:'completed'}, kalshi:{status:'failed',error:'429'}}}};
  assert.match(pipelineReportedFailure(result), /kalshi intake failed: 429/);
});

test('unavailable resolution sources are failures instead of silently successful checks', () => {
  assert.match(pipelineReportedFailure({resolution:{checked:4,resolved:1,failed:2}}), /2 selected market resolution checks failed/);
  assert.equal(pipelineReportedFailure({resolution:{checked:4,resolved:0,failed:0}}), null);
});

test('source outage does not block a complete approved daily fallback slate', () => {
  const result = { sync: { sourceStats: { kalshi: { status: 'failed', error: '429' } } },
    selection: { selected: 20, quotaMet: true } };
  assert.equal(pipelineReportedFailure(result), null);
  assert.match(pipelineReportedFailure({ ...result, selection: { selected: 19, quotaMet: false } }), /kalshi intake failed/);
  assert.match(pipelineReportedFailure({ ...result, outcomes: [{ status: 'failed', error: 'timeout' }] }), /model forecasts failed/);
});

test('zero or incomplete daily selection is a failure for combined and direct invocations', () => {
  assert.match(pipelineReportedFailure({selection:{selected:0,quotaMet:false}}), /20 questions/);
  assert.match(pipelineReportedFailure({selected:18,quotaMet:false}), /20 questions/);
  assert.equal(pipelineReportedFailure({selection:{selected:20,quotaMet:true}}), null);
});

test('partial model failure and time budget exhaustion remain visible to the scheduler', () => {
  assert.match(pipelineReportedFailure({completed:1,outcomes:[{status:'completed'},{status:'failed',error:'provider unavailable'}]}), /1 model forecasts failed/);
  assert.match(pipelineReportedFailure({timedOut:true,deferred:3}), /time budget/);
  assert.equal(pipelineReportedFailure({configured:true,busy:true,processed:0}), null);
  assert.equal(pipelineReportedFailure({completed:20,outcomes:[{status:'completed'}]}), null);
});
