import { DAILY_FORECAST_QUESTION_TARGET, FORECAST_CONFIG_VERSION, FORECAST_JOBS_PER_BATCH } from './forecast-core.js';

export const FORECAST_BATCH_ELAPSED_MS = 8 * 60_000;
export const FORECAST_BATCH_LEASE_MS = 1200 * 1000;
export const FORECAST_MODEL_TIMEOUT_MS = 90_000;
export const FORECAST_SEARCH_TIMEOUT_MS = 30_000;

// Both placeholders are bound by the caller: curation config, question target.
// No age/latest restriction: still-open work survives the next UTC daily slate.
export const VALID_FORECAST_SLATES_SQL = `valid_daily_runs(run_id) AS (
  SELECT sr.id FROM selection_runs sr
  WHERE sr.status='completed' AND sr.config_version=? AND sr.selected_count=?
    AND (SELECT COUNT(DISTINCT si.event_id) FROM selection_items si WHERE si.run_id=sr.id)=sr.selected_count
)`;

export const FORECAST_LEASE_CLAIM_SQL = `
  INSERT INTO forecast_batch_lease (id, owner, acquired_at, expires_at)
  VALUES ('forecast', ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,
    acquired_at=excluded.acquired_at, expires_at=excluded.expires_at
  WHERE datetime(forecast_batch_lease.expires_at)<=datetime(excluded.acquired_at)
  RETURNING owner`;

// Inputs are fixed SQL aliases/expressions supplied by source, never user text.
export function publishedForecastSql(eventAlias, participantExpression) {
  const version = FORECAST_CONFIG_VERSION.replaceAll("'", "''");
  return `(
    (${eventAlias}.event_type!='categorical' AND EXISTS (
      SELECT 1 FROM predictions pf WHERE pf.event_id=${eventAlias}.id
      AND pf.participant_id=${participantExpression} AND pf.kind='forecaster'
      AND pf.version='${version}' AND pf.probability BETWEEN 0 AND 1
    )) OR (${eventAlias}.event_type='categorical'
      AND EXISTS (SELECT 1 FROM event_outcomes eo WHERE eo.event_id=${eventAlias}.id)
      AND NOT EXISTS (
        SELECT 1 FROM event_outcomes eo WHERE eo.event_id=${eventAlias}.id
        AND NOT EXISTS (SELECT 1 FROM prediction_outcomes pf
          WHERE pf.event_id=eo.event_id AND pf.outcome_key=eo.outcome_key
          AND pf.participant_id=${participantExpression} AND pf.kind='forecaster'
          AND pf.version='${version}' AND pf.probability BETWEEN 0 AND 1)
      )
      AND ABS((SELECT SUM(pf.probability) FROM prediction_outcomes pf
        JOIN event_outcomes eo ON eo.event_id=pf.event_id AND eo.outcome_key=pf.outcome_key
        WHERE pf.event_id=${eventAlias}.id AND pf.participant_id=${participantExpression}
        AND pf.kind='forecaster' AND pf.version='${version}')-1)<0.000001
    )
  )`;
}

/** @param {{utcDate:string,runId:string|null,selectionStatus:string|null,selectedQuestions:number,models:Array<{participantId:string,participantName:string,modelId:string}>,rows:Array<Record<string,any>>,now?:number}} input */
export function summarizeDailyForecasts(input) {
  const now = input.now ?? Date.now();
  const target = DAILY_FORECAST_QUESTION_TARGET;
  const perModel = input.models.map((model) => {
    const events = new Map();
    for (const row of input.rows) {
      if (row.participant_id !== model.participantId) continue;
      const prior = events.get(row.event_id);
      if (!prior || Date.parse(row.latest_created_at || '') > Date.parse(prior.latest_created_at || '')) events.set(row.event_id, row);
    }
    let completed=0, running=0, failed=0, missed=0;
    let latestError=null;
    for (const row of events.values()) {
      if (Number(row.published) === 1) { completed++; continue; }
      const closes = row.close_time ? Date.parse(row.close_time) : Infinity;
      if (row.event_status !== 'open' || closes <= now) { missed++; continue; }
      const fresh = Date.parse(row.latest_created_at || '') > now - FORECAST_BATCH_LEASE_MS;
      if (row.latest_status === 'running' && fresh) running++;
      else if (row.latest_status === 'failed' || row.latest_status === 'running' || row.latest_status === 'completed') {
        failed++;
        latestError = row.latest_error || (row.latest_status === 'completed' ? 'Completed model response is missing its published forecast' : 'Forecast run stopped before completion');
      }
    }
    return { participantId:model.participantId, modelId:model.modelId, name:model.participantName,
      target, completed, running, failed, missed,
      unattempted:Math.max(0,target-completed-running-failed-missed), latestError };
  });
  const sum = (key) => perModel.reduce((n, row) => n + row[key], 0);
  const modelEventTarget = target * input.models.length;
  const completed = sum('completed');
  const blockedSelection = input.selectionStatus !== 'completed' || input.selectedQuestions !== target;
  const status = !input.models.length ? 'paused' : blockedSelection ? 'blocked_selection'
    : completed === modelEventTarget ? 'completed' : sum('missed') ? 'missed_deadline'
      : sum('failed') ? 'retrying' : sum('running') ? 'running' : 'queued';
  const blockedReason = blockedSelection
    ? `The ${input.utcDate} UTC daily slate is ${input.selectionStatus || 'missing'} (${input.selectedQuestions}/${target} questions).`
    : sum('missed') ? `${sum('missed')} model-event forecasts missed the event deadline.` : null;
  return { utcDate:input.utcDate, runId:input.runId, selectionStatus:input.selectionStatus,
    questionTarget:target, selectedQuestions:input.selectedQuestions, activeModelCount:input.models.length,
    modelEventTarget, completed, pending:Math.max(0,modelEventTarget-completed),
    running:sum('running'), failed:sum('failed'), missed:sum('missed'), unattempted:sum('unattempted'),
    status, blockedReason, perModel, jobsPerHourlyBatch:FORECAST_JOBS_PER_BATCH };
}

/** @param {number} milliseconds @param {AbortSignal | undefined} signal */
export function waitForForecast(milliseconds, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(undefined); };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once:true });
  });
}
