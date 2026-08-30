/** A fulfilled orchestration promise can still contain failed required work.
 * @param {unknown} result
 * @returns {string | null}
 */
export function pipelineReportedFailure(result) {
  if (!result || typeof result !== 'object') return null;
  const value = /** @type {Record<string, unknown>} */ (result);
  if (value.configured === false) return String(value.message || 'Forecast pipeline is not configured');
  for (const stage of ['sync', 'resolution']) {
    const child = value[stage];
    if (child && typeof child === 'object' && 'status' in child && child.status === 'failed') {
      return `${stage} failed: ${'error' in child ? String(child.error) : 'unspecified error'}`;
    }
  }
  const sync = value.sync;
  if (sync && typeof sync === 'object' && 'sourceStats' in sync && sync.sourceStats && typeof sync.sourceStats === 'object') {
    for (const [source, state] of Object.entries(sync.sourceStats)) {
      if (state && typeof state === 'object' && state.status === 'failed') {
        return `${source} intake failed: ${String(state.error || 'no usable market data').slice(0, 700)}`;
      }
    }
  }
  const selection = value.selection || value;
  if (selection && typeof selection === 'object' && 'quotaMet' in selection && selection.quotaMet === false) {
    return 'Daily selection did not satisfy the required 20 questions and source/category quotas';
  }
  if (Array.isArray(value.outcomes)) {
    const failed = value.outcomes.filter((outcome) => outcome?.status === 'failed');
    if (failed.length) return `${failed.length} model forecasts failed: ${String(failed[0].error || 'see model run diagnostics').slice(0, 700)}`;
  }
  if (value.timedOut === true) return 'Forecast batch reached its time budget with work remaining';
  return null;
}
