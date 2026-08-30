// Compute the exclusion set once, rather than re-scanning selection history
// for each market. The two parameters are now and the minimum close time.
export const DAILY_CANDIDATES_SQL = `
  SELECT c.*, CASE WHEN c.diversity_group_id IN (
    SELECT DISTINCT prior.diversity_group_id FROM selection_items si
    JOIN polymarket_candidates prior ON prior.market_id=si.market_id
    JOIN selection_runs sr ON sr.id=si.run_id AND sr.status='completed'
  ) THEN 1 ELSE 0 END AS already_selected
  FROM polymarket_candidates c
  WHERE c.last_seen_at=(
    SELECT started_at FROM curation_sync_runs WHERE status='completed'
      AND datetime(started_at)>=datetime(?, '-3 hours') ORDER BY id DESC LIMIT 1
  ) AND datetime(c.close_time)>datetime(?)
  ORDER BY c.category, c.selection_score DESC`;

export const DAILY_SELECTION_CLAIM_SQL = `
  INSERT INTO selection_runs (
    id, config_version, taxonomy_version, status, started_at
  ) VALUES (?, ?, ?, 'running', ?)
  ON CONFLICT(id) DO UPDATE SET status='running', started_at=excluded.started_at, completed_at=NULL
  WHERE selection_runs.status!='completed'
    AND (selection_runs.status!='running'
      OR datetime(selection_runs.started_at)<=datetime(excluded.started_at, '-20 minutes'))
  RETURNING id`;

export function dailySelectionNeedsRetry(status) {
  return status !== 'completed';
}
