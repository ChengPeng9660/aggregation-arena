import { getD1 } from "@/db";
import {
  ensureArenaReady,
  recordAutomatedEventForecast,
  recordAutomatedForecast,
  syncAggregates,
} from "@/lib/arena";
import {
  DAILY_FORECAST_QUESTION_TARGET,
  FORECAST_CONFIG_VERSION,
  FORECAST_JOBS_PER_BATCH,
  FORECAST_MODELS,
  buildProphetPredictionPrompt,
  buildSearchQuery,
  normalizeSources,
  dailyForecastJobTarget,
  getActiveForecastModels,
} from "@/lib/forecast-core.js";
import { CURATION_CONFIG, dailySelectionRunId } from "@/lib/curation-core.js";
import { parseEventPredictionResponse } from "@/lib/event-core.js";
import { modelGatewayConfigurationProblem, runModelGateway } from "@/lib/model-gateway";

import {
  FORECAST_BATCH_ELAPSED_MS, FORECAST_BATCH_LEASE_MS, FORECAST_SEARCH_TIMEOUT_MS,
  FORECAST_LEASE_CLAIM_SQL, VALID_FORECAST_SLATES_SQL,
  publishedForecastSql, summarizeDailyForecasts, waitForForecast,
} from "@/lib/forecast-pipeline-core.js";

type ForecastEnv = {
  DB: D1Database;
  AI?: Ai;
  TAVILY_API_KEY?: string;
  PROPHET_MODEL_GATEWAY_MODE?: string;
  PROPHET_AI_GATEWAY_ID?: string;
  PROPHET_CLOUDFLARE_MODEL_ID_MAP?: string;
  PROPHET_DISABLED_MODEL_IDS?: string;
};

type ForecastEvent = {
  id: string;
  title: string;
  description: string;
  category: string;
  closeTime: string | null;
  rules: string;
  selectionRunId: string;
  sourcePlatform: "polymarket" | "kalshi";
  sourceUrl: string;
  selectedAt: string;
  latestObservedAt: string;
  yesPriceAtSelection: number;
  selectionVolume24h: number;
  selectionTotalVolume: number;
  selectionLiquidity: number;
  latestYesPrice: number;
  latestVolume24h: number;
  latestTotalVolume: number;
  latestLiquidity: number;
  eventType: "binary" | "categorical";
  outcomes: { key: string; label: string; marketId?: string; sourceUrl?: string; priceAtSelection?: number }[];
};

type ResearchSource = {
  rank: number;
  title: string;
  url: string;
  content: string;
  publishedDate: string | null;
  score: number | null;
};

type ForecastModel = (typeof FORECAST_MODELS)[number];

const FORECAST_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS forecast_batch_lease (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS research_contexts (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    selection_run_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    search_query TEXT NOT NULL,
    search_prompt_version TEXT NOT NULL,
    sources_json TEXT NOT NULL,
    market_snapshot_json TEXT NOT NULL,
    source_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ready',
    error TEXT,
    as_of_time TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, search_prompt_version)
  )`,
  `CREATE TABLE IF NOT EXISTS model_forecast_runs (
    id TEXT PRIMARY KEY,
    context_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    status TEXT NOT NULL,
    yes_probability REAL,
    no_probability REAL,
    probabilities_json TEXT,
    rationale TEXT,
    cited_sources_json TEXT NOT NULL DEFAULT '[]',
    raw_response TEXT,
    latency_ms INTEGER,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    UNIQUE(context_id, participant_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_research_context_event ON research_contexts(event_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_model_forecast_event ON model_forecast_runs(event_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_model_forecast_status ON model_forecast_runs(status, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_model_forecast_participant_version ON model_forecast_runs(event_id, participant_id, prompt_version, created_at DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_model_forecast_created ON model_forecast_runs(created_at DESC, id DESC)",
  // Triggers run inside the same transaction as completion, publication and history.
  `CREATE TRIGGER IF NOT EXISTS guard_predictions_insert_admission
BEFORE INSERT ON predictions WHEN NEW.kind='forecaster'
BEGIN
  SELECT RAISE(ABORT, 'forecast_event_closed') WHERE NOT EXISTS (
    SELECT 1 FROM events e WHERE e.id=NEW.event_id AND e.status='open'
      AND (e.close_time IS NULL OR datetime(e.close_time)>datetime('now'))
  );
  SELECT RAISE(ABORT, 'forecast_run_ownership_changed')
  WHERE json_extract(IIF(json_valid(NEW.components_json), NEW.components_json, '{}'), '$.runId') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM model_forecast_runs r
      WHERE r.id=json_extract(NEW.components_json, '$.runId')
        AND r.event_id=NEW.event_id AND r.participant_id=NEW.participant_id
        AND r.prompt_version=NEW.version AND r.status='completed'
    );
END`,
  `CREATE TRIGGER IF NOT EXISTS guard_predictions_update_admission
BEFORE UPDATE ON predictions WHEN NEW.kind='forecaster'
BEGIN
  SELECT RAISE(ABORT, 'forecast_event_closed') WHERE NOT EXISTS (
    SELECT 1 FROM events e WHERE e.id=NEW.event_id AND e.status='open'
      AND (e.close_time IS NULL OR datetime(e.close_time)>datetime('now'))
  );
  SELECT RAISE(ABORT, 'forecast_run_ownership_changed')
  WHERE json_extract(IIF(json_valid(NEW.components_json), NEW.components_json, '{}'), '$.runId') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM model_forecast_runs r
      WHERE r.id=json_extract(NEW.components_json, '$.runId')
        AND r.event_id=NEW.event_id AND r.participant_id=NEW.participant_id
        AND r.prompt_version=NEW.version AND r.status='completed'
    );
END`,
  `CREATE TRIGGER IF NOT EXISTS guard_prediction_outcomes_insert_admission
BEFORE INSERT ON prediction_outcomes WHEN NEW.kind='forecaster'
BEGIN
  SELECT RAISE(ABORT, 'forecast_event_closed') WHERE NOT EXISTS (
    SELECT 1 FROM events e WHERE e.id=NEW.event_id AND e.status='open'
      AND (e.close_time IS NULL OR datetime(e.close_time)>datetime('now'))
  );
  SELECT RAISE(ABORT, 'forecast_run_ownership_changed')
  WHERE json_extract(IIF(json_valid(NEW.components_json), NEW.components_json, '{}'), '$.runId') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM model_forecast_runs r
      WHERE r.id=json_extract(NEW.components_json, '$.runId')
        AND r.event_id=NEW.event_id AND r.participant_id=NEW.participant_id
        AND r.prompt_version=NEW.version AND r.status='completed'
    );
END`,
  `CREATE TRIGGER IF NOT EXISTS guard_prediction_outcomes_update_admission
BEFORE UPDATE ON prediction_outcomes WHEN NEW.kind='forecaster'
BEGIN
  SELECT RAISE(ABORT, 'forecast_event_closed') WHERE NOT EXISTS (
    SELECT 1 FROM events e WHERE e.id=NEW.event_id AND e.status='open'
      AND (e.close_time IS NULL OR datetime(e.close_time)>datetime('now'))
  );
  SELECT RAISE(ABORT, 'forecast_run_ownership_changed')
  WHERE json_extract(IIF(json_valid(NEW.components_json), NEW.components_json, '{}'), '$.runId') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM model_forecast_runs r
      WHERE r.id=json_extract(NEW.components_json, '$.runId')
        AND r.event_id=NEW.event_id AND r.participant_id=NEW.participant_id
        AND r.prompt_version=NEW.version AND r.status='completed'
    );
END`,
];

let forecastingSchemaReady = false;

export async function ensureForecastingReady(db: D1Database = getD1(), disabledModelIds?: string) {
  await ensureArenaReady(db, disabledModelIds);
  if (!forecastingSchemaReady) {
    await db.batch(FORECAST_SCHEMA.map((statement) => db.prepare(statement)));
    forecastingSchemaReady = true;
  }
}

export async function runForecastBatch(
  env: ForecastEnv,
  jobLimit = FORECAST_JOBS_PER_BATCH,
  requestedEventIds: string[] = [],
) {
  const deadline = Date.now() + FORECAST_BATCH_ELAPSED_MS;
  const scheduledDailySlate = !requestedEventIds.some((value) => String(value).trim());
  // Report today's readiness after useful work, even when an older valid slate
  // supplied the jobs. Explicit event-targeted calls retain their current scope.
  const finish = async <Result extends object>(result: Result) => scheduledDailySlate
    ? { ...result, selection: await getScheduledForecastSelection(env.DB) }
    : result;
  await ensureForecastingReady(env.DB, env.PROPHET_DISABLED_MODEL_IDS);
  const startedAt = new Date();
  if (startedAt.getTime() >= deadline) return finish({ configured:true, processed:0, completed:0, deferred:true });
  const owner = crypto.randomUUID();
  const lease = await env.DB.prepare(FORECAST_LEASE_CLAIM_SQL).bind(
    owner, startedAt.toISOString(), new Date(startedAt.getTime()+FORECAST_BATCH_LEASE_MS).toISOString(),
  ).first<{ owner:string }>();
  if (lease?.owner !== owner) return finish({ configured:true, processed:0, completed:0, busy:true });
  try {
    if (Date.now() >= deadline) return finish({ configured:true, processed:0, completed:0, deferred:true });
    const signal = AbortSignal.timeout(Math.max(1, deadline-Date.now()));
    return await finish(await runLeasedForecastBatch(env, jobLimit, requestedEventIds, signal));
  } finally {
    await env.DB.prepare("DELETE FROM forecast_batch_lease WHERE id='forecast' AND owner=?").bind(owner).run();
  }
}

async function getScheduledForecastSelection(db: D1Database, now = new Date()) {
  const runId = dailySelectionRunId(now);
  const selection = await db.prepare(`
    WITH ${VALID_FORECAST_SLATES_SQL}
    SELECT sr.status,
      (SELECT COUNT(DISTINCT si.event_id) FROM selection_items si WHERE si.run_id=sr.id) AS actual_questions,
      EXISTS(SELECT 1 FROM valid_daily_runs valid WHERE valid.run_id=sr.id) AS quota_met
    FROM selection_runs sr WHERE sr.id=?
  `).bind(CURATION_CONFIG.configVersion, DAILY_FORECAST_QUESTION_TARGET, runId)
    .first<{ status:string; actual_questions:number; quota_met:number }>();
  return {
    runId,
    status: selection?.status || "missing",
    selected: Number(selection?.actual_questions || 0),
    quotaMet: Number(selection?.quota_met || 0) === 1,
  };
}

async function runLeasedForecastBatch(
  env:ForecastEnv, jobLimit:number, requestedEventIds:string[], signal:AbortSignal,
) {
  signal.throwIfAborted();
  const repairedStaleRuns = await repairStaleForecastRuns(env.DB);
  signal.throwIfAborted();
  const repairedForecasts = await repairMissingForecastPredictions(env.DB);
  signal.throwIfAborted();
  const repairedAggregates = await repairMissingAggregates(env.DB);
  signal.throwIfAborted();
  const gatewayProblem = modelGatewayConfigurationProblem(env);
  if (!env.TAVILY_API_KEY || gatewayProblem) {
    return {
      configured: false,
      repairedStaleRuns,
      repairedForecasts,
      repairedAggregates,
      processed: 0,
      completed: 0,
      message: !env.TAVILY_API_KEY ? "TAVILY_API_KEY is not configured" : gatewayProblem,
    };
  }

  const batchJobLimit = Math.max(1, Math.min(FORECAST_JOBS_PER_BATCH, Math.floor(jobLimit) || FORECAST_JOBS_PER_BATCH));
  const targetEventIds = [...new Set(requestedEventIds.map((value) => String(value).trim()).filter(Boolean))].slice(0, 20);
  const scheduledDailySlate = targetEventIds.length === 0;
  const dailyRunCte = scheduledDailySlate ? `, ${VALID_FORECAST_SLATES_SQL}` : "";
  const dailyRunJoin = scheduledDailySlate
    ? "JOIN valid_daily_runs daily_run ON daily_run.run_id=si.run_id"
    : "";
  const targetEventClause = targetEventIds.length
    ? `AND e.id IN (${targetEventIds.map(() => "?").join(", ")})`
    : "";
  const activeModels = getActiveForecastModels(env.PROPHET_DISABLED_MODEL_IDS);
  if (!activeModels.length) {
    return {
      configured: true,
      repairedStaleRuns,
      repairedForecasts,
      repairedAggregates,
      jobLimit: batchJobLimit,
      targetEventIds,
      processedEvents: 0,
      processed: 0,
      completed: 0,
      message: "No forecast models are enabled",
    };
  }
  const modelValues = activeModels.map(() => "(?, ?)").join(", ");
  const modelBindings = activeModels.flatMap((model, index) => [model.participantId, index]);
  const scopeBindings = scheduledDailySlate
    ? [CURATION_CONFIG.configVersion, DAILY_FORECAST_QUESTION_TARGET]
    : [];
  const rows = await env.DB.prepare(`
    WITH forecast_models(participant_id, model_order) AS (VALUES ${modelValues})
    ${dailyRunCte},
    pending_jobs AS (
      SELECT e.id AS event_id, MIN(si.id) AS selection_item_id, fm.participant_id, fm.model_order,
        CASE WHEN EXISTS (
          SELECT 1 FROM model_forecast_runs prior_run
          WHERE prior_run.event_id=e.id AND prior_run.participant_id=fm.participant_id
        ) THEN 1 ELSE 0 END AS previously_attempted
      FROM events e
      JOIN selection_items si ON si.event_id=e.id
      ${dailyRunJoin}
      CROSS JOIN forecast_models fm
      WHERE e.status='open'
        AND (e.close_time IS NULL OR datetime(e.close_time) > datetime('now'))
        ${targetEventClause}
        AND NOT ${publishedForecastSql("e", "fm.participant_id")}
        AND NOT EXISTS (
        SELECT 1 FROM model_forecast_runs completed_run
        WHERE completed_run.event_id=e.id
          AND completed_run.participant_id=fm.participant_id
          AND completed_run.prompt_version='${FORECAST_CONFIG_VERSION}'
          AND completed_run.status='completed'
      )
      AND NOT EXISTS (
        SELECT 1 FROM model_forecast_runs recent_failure
        WHERE recent_failure.event_id=e.id
          AND recent_failure.participant_id=fm.participant_id
          AND recent_failure.prompt_version='${FORECAST_CONFIG_VERSION}'
          AND recent_failure.status='failed'
          AND datetime(recent_failure.completed_at) > datetime('now', '-15 minutes')
      )
      AND NOT EXISTS (
        SELECT 1 FROM model_forecast_runs active_run
        WHERE active_run.event_id=e.id
          AND active_run.participant_id=fm.participant_id
          AND active_run.prompt_version='${FORECAST_CONFIG_VERSION}'
          AND active_run.status='running'
          AND datetime(active_run.created_at) > datetime('now', '-20 minutes')
      )
      GROUP BY e.id, fm.participant_id, fm.model_order
      ORDER BY previously_attempted, MIN(e.close_time), MIN(si.selected_at), MIN(si.category), MIN(si.rank), e.id, fm.model_order
      LIMIT ?
    )
    SELECT e.id, e.title, e.description, e.category, e.close_time, e.event_type,
      pc.rules, pc.source_platform, pc.source_url, pc.last_seen_at, pc.yes_price AS latest_yes_price,
      pc.volume_24h AS latest_volume_24h, pc.total_volume AS latest_total_volume,
      pc.liquidity AS latest_liquidity, si.run_id, si.selected_at,
      si.price_at_selection, si.volume_24h, si.total_volume, si.liquidity,
      pj.participant_id AS target_participant_id,
      (SELECT json_group_array(json_object(
        'key', eo.outcome_key, 'label', eo.label, 'marketId', eo.market_id,
        'sourceUrl', eo.source_url, 'priceAtSelection', eo.price_at_selection
      )) FROM event_outcomes eo WHERE eo.event_id=e.id ORDER BY eo.display_order) AS event_outcomes_json
    FROM pending_jobs pj
    JOIN events e ON e.id=pj.event_id
    JOIN selection_items si ON si.id=pj.selection_item_id
    JOIN polymarket_candidates pc ON pc.market_id=si.market_id
    ORDER BY pj.previously_attempted, e.close_time, si.selected_at, si.category, si.rank, e.id, pj.model_order
  `).bind(...modelBindings, ...scopeBindings, ...targetEventIds, batchJobLimit).all<Record<string, unknown>>();

  const jobs = rows.results.flatMap((row) => {
    const event = rowToForecastEvent(row);
    const model = activeModels.find((candidate) => candidate.participantId === row.target_participant_id);
    return model ? [{ event, model }] : [];
  });
  const contextPromises = new Map<string, Promise<Awaited<ReturnType<typeof getOrCreateContext>>>>();
  const providerLane = createProviderLane(signal);
  const outcomes = await mapWithConcurrency(jobs, 2, async ({ event, model }) => {
    if (signal.aborted) return { eventId:event.id, modelId:model.modelId, status:"deferred" };
    try {
      let contextPromise = contextPromises.get(event.id);
      if (!contextPromise) {
        contextPromise = getOrCreateContext(env, event, signal);
        contextPromises.set(event.id, contextPromise);
      }
      const context = await contextPromise;
      return await providerLane.run(model.modelId, () => forecastEvent(env, event, model, context, signal));
    } catch (error) {
      await env.DB.prepare(`
        INSERT INTO audit_log (action, entity_type, entity_id, detail_json, actor, created_at)
        VALUES ('forecast.pipeline_failed', 'event', ?, ?, 'forecast-cron', ?)
      `).bind(
        event.id,
        JSON.stringify({ modelId: model.modelId, error: errorMessage(error).slice(0, 800) }),
        new Date().toISOString(),
      ).run();
      return { eventId: event.id, modelId: model.modelId, status: "failed", error: errorMessage(error) };
    }
  });
  return {
    configured: true,
    repairedStaleRuns,
    repairedForecasts,
    repairedAggregates,
    jobLimit: batchJobLimit,
    targetEventIds,
    scheduledDailySlate,
    dailyQuestionTarget: DAILY_FORECAST_QUESTION_TARGET,
    dailyModelEventTarget: dailyForecastJobTarget(activeModels.length),
    processedEvents: new Set(outcomes.map((item) => item.eventId)).size,
    processed: outcomes.length,
    completed: outcomes.filter((item) => item.status === "completed").length,
    deferred: outcomes.filter((item) => item.status === "deferred").length,
    timedOut: signal.aborted,
    outcomes,
  };
}

async function repairStaleForecastRuns(db: D1Database) {
  const completedAt = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE model_forecast_runs
    SET status='failed',
      error='Recovered stale running forecast after worker termination',
      completed_at=?
    WHERE status='running'
      AND datetime(created_at) <= datetime('now', '-20 minutes')
  `).bind(completedAt).run();
  return Number(result.meta?.changes || 0);
}

async function repairMissingForecastPredictions(db: D1Database) {
  const rows = await db.prepare(`
    SELECT mfr.id, mfr.context_id, mfr.event_id, mfr.participant_id, mfr.model_id,
      mfr.prompt_version, mfr.yes_probability, mfr.probabilities_json, mfr.rationale,
      mfr.cited_sources_json, mfr.created_at, mfr.completed_at,
      e.event_type, p.name AS participant_name,
      (SELECT json_group_array(eo.outcome_key) FROM event_outcomes eo
       WHERE eo.event_id=e.id) AS outcome_keys_json
    FROM model_forecast_runs mfr
    JOIN events e ON e.id=mfr.event_id
    JOIN participants p ON p.id=mfr.participant_id
    WHERE mfr.status='completed' AND mfr.prompt_version=?
      AND p.status='active'
      AND e.status='open'
      AND (e.close_time IS NULL OR datetime(e.close_time) > datetime('now'))
      AND NOT ${publishedForecastSql("e", "mfr.participant_id")}
    ORDER BY mfr.completed_at, mfr.created_at
    LIMIT ${FORECAST_JOBS_PER_BATCH}
  `).bind(FORECAST_CONFIG_VERSION).all<Record<string, unknown>>();
  const repaired: { eventId: string; modelId: string }[] = [];
  for (const row of rows.results) {
    const eventId = String(row.event_id);
    const modelId = String(row.model_id);
    const probabilities = safeJson(String(row.probabilities_json || "{}"), {}) as Record<string, number>;
    const outcomeKeys = safeJson(String(row.outcome_keys_json || "[]"), []) as string[];
    const probability = probabilities?.yes ?? row.yes_probability;
    const validProbability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
    const validPayload = String(row.event_type) === "categorical"
      ? outcomeKeys.length > 0
        && outcomeKeys.every((key) => validProbability(probabilities?.[key]))
        && Math.abs(outcomeKeys.reduce((sum, key) => sum + probabilities[key], 0) - 1) < 0.000001
      : validProbability(probability);
    if (!validPayload) {
      // A response that cannot be published must not block a fresh model run forever.
      // Do not convert missing probabilities to zero or silently complete missing outcomes.
      await db.prepare(`
        UPDATE model_forecast_runs SET status='failed', error=?, completed_at=?
        WHERE id=? AND status='completed' AND prompt_version=?
      `).bind(
        "Completed model response has invalid or incomplete probabilities; new forecast required",
        new Date().toISOString(), String(row.id), FORECAST_CONFIG_VERSION,
      ).run();
      continue;
    }
    const components = {
      contextId: String(row.context_id),
      modelId,
      citedSourceRanks: safeJson(String(row.cited_sources_json || "[]"), []),
      recoveredFromCompletedRun: true,
      runId: String(row.id),
    };
    const options = {
      db,
      recordedAt: String(row.completed_at || row.created_at || new Date().toISOString()),
      deferAggregateErrors: true,
      recovered: true,
    };
    try {
      if (String(row.event_type) === "categorical") {
        await recordAutomatedEventForecast({
          eventId,
          participantId: String(row.participant_id),
          participantName: String(row.participant_name),
          probabilities,
          rationale: String(row.rationale || ""),
          version: String(row.prompt_version),
          components,
        }, options);
      } else {
        await recordAutomatedForecast({
          eventId,
          participantId: String(row.participant_id),
          participantName: String(row.participant_name),
          probability: probability as number,
          rationale: String(row.rationale || ""),
          version: String(row.prompt_version),
          components,
        }, options);
      }
      repaired.push({ eventId, modelId });
    } catch (error) {
      console.error(JSON.stringify({
        message: "completed forecast recovery failed",
        eventId,
        modelId,
        error: errorMessage(error),
      }));
    }
  }
  return repaired;
}

async function repairMissingAggregates(db: D1Database) {
  const rows = await db.prepare(`
    SELECT e.id
    FROM events e
    WHERE e.status='open'
      AND (e.close_time IS NULL OR datetime(e.close_time) > datetime('now'))
      AND (
      (
        e.event_type='categorical'
        AND (SELECT COUNT(DISTINCT participant_id) FROM prediction_outcomes
             WHERE event_id=e.id AND kind='forecaster') >= 2
        AND (SELECT COUNT(DISTINCT participant_id) FROM prediction_outcomes
             WHERE event_id=e.id AND kind='aggregate') < 6
      ) OR (
        e.event_type!='categorical'
        AND (SELECT COUNT(DISTINCT participant_id) FROM predictions
             WHERE event_id=e.id AND kind='forecaster') >= 2
        AND (SELECT COUNT(DISTINCT participant_id) FROM predictions
             WHERE event_id=e.id AND kind='aggregate') < 6
      )
    )
    ORDER BY e.created_at
    LIMIT 15
  `).all<{ id: string }>();
  const repaired = [];
  for (const row of rows.results) {
    const aggregates = await syncAggregates(row.id);
    if (aggregates.length) repaired.push({ eventId: row.id, aggregateCount: aggregates.length });
  }
  return repaired;
}

async function forecastEvent(
  env: ForecastEnv,
  event: ForecastEvent,
  model: ForecastModel,
  context: Awaited<ReturnType<typeof getOrCreateContext>>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const admissible = await env.DB.prepare(`
    SELECT id FROM events WHERE id=? AND status='open'
      AND (close_time IS NULL OR datetime(close_time)>datetime('now'))
  `).bind(event.id).first();
  if (!admissible) return { eventId:event.id, modelId:model.modelId, status:"expired" };
  signal.throwIfAborted();
  const runId = `run-${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();
  const claim = await env.DB.prepare(`
    INSERT INTO model_forecast_runs (
      id, context_id, event_id, participant_id, model_id, prompt_version, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
    ON CONFLICT(context_id, participant_id) DO UPDATE SET
      id=excluded.id, model_id=excluded.model_id, prompt_version=excluded.prompt_version,
      status='running', yes_probability=NULL, no_probability=NULL, probabilities_json=NULL,
      rationale=NULL, cited_sources_json='[]', raw_response=NULL, latency_ms=NULL,
      error=NULL, created_at=excluded.created_at, completed_at=NULL
    WHERE (model_forecast_runs.status!='completed' OR model_forecast_runs.prompt_version!=excluded.prompt_version)
      AND (model_forecast_runs.status!='running' OR model_forecast_runs.prompt_version!=excluded.prompt_version
        OR datetime(model_forecast_runs.created_at)<=datetime(excluded.created_at, '-20 minutes'))
  `).bind(
    runId,
    context.id,
    event.id,
    model.participantId,
    model.modelId,
    model.promptVersion,
    startedAt,
  ).run();

  if (!Number(claim.meta?.changes || 0)) return { eventId:event.id, modelId:model.modelId, status:"skipped" };
  const prompt = buildProphetPredictionPrompt(context);
  const requestStarted = Date.now();
  let raw: unknown;
  try {
    let parsed;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const gatewayResult = await runModelGateway(env, {
        modelId: model.modelId,
        signal,
        messages: [
          {
            role: "system",
            content: "Return valid JSON only. The top-level object must include both probabilities and rationale. Never omit probabilities. Calibrate carefully.",
          },
          { role: "user", content: attempt ? `${prompt}\n\nYour prior response was invalid. Return the required JSON object only.` : prompt },
        ],
        maxTokens: 700,
        temperature: 0.1,
        seed: deterministicSeed(`${event.id}-${model.participantId}-${attempt}`),
      });
      signal.throwIfAborted();
      raw = gatewayResult.payload;
      try {
        parsed = parseEventPredictionResponse(raw, event.outcomes);
        break;
      } catch (parseError) {
        if (attempt === 1) throw parseError;
      }
    }
    if (!parsed) throw new Error("Model response could not be parsed");
    signal.throwIfAborted();
    const owned = await env.DB.prepare("SELECT id FROM model_forecast_runs WHERE id=? AND status='running'")
      .bind(runId).first();
    if (!owned) throw new Error("Forecast run ownership changed; discarded late response");
    signal.throwIfAborted();
    const completedAt = new Date().toISOString();
    const latencyMs = Date.now() - requestStarted;
    const completionStatement = env.DB.prepare(`
      UPDATE model_forecast_runs SET status='completed', yes_probability=?, no_probability=?,
        probabilities_json=?, rationale=?, cited_sources_json=?, raw_response=?, latency_ms=?, completed_at=?,
        error=NULL WHERE id=? AND status='running'
    `).bind(
      parsed.probabilities.yes ?? null,
      parsed.probabilities.no ?? null,
      JSON.stringify(parsed.probabilities),
      parsed.rationale,
      JSON.stringify(parsed.citedSourceRanks),
      parsed.rawText.slice(0, 12000),
      latencyMs,
      completedAt,
      runId,
    );
    const components = {
      contextId: context.id,
      modelId: model.modelId,
      runId,
      citedSourceRanks: parsed.citedSourceRanks,
    };
    const writeOptions = {
      db: env.DB,
      recordedAt: completedAt,
      precedingStatements: [completionStatement],
      deferAggregateErrors: true,
    };
    if (event.eventType === "categorical") {
      await recordAutomatedEventForecast({
        eventId: event.id,
        participantId: model.participantId,
        participantName: model.participantName,
        probabilities: parsed.probabilities,
        rationale: parsed.rationale,
        version: model.promptVersion,
        components,
      }, writeOptions);
    } else {
      await recordAutomatedForecast({
        eventId: event.id,
        participantId: model.participantId,
        participantName: model.participantName,
        probability: parsed.probabilities.yes,
        rationale: parsed.rationale,
        version: model.promptVersion,
        components,
      }, writeOptions);
    }
    return { eventId: event.id, contextId: context.id, modelId: model.modelId, status: "completed", probabilities: parsed.probabilities };
  } catch (error) {
    await env.DB.prepare(`
      UPDATE model_forecast_runs SET status='failed', error=?, raw_response=?, latency_ms=?, completed_at=?
      WHERE id=? AND status='running'
    `).bind(
      errorMessage(error).slice(0, 1500),
      serializeRawResponse(raw),
      Date.now() - requestStarted,
      new Date().toISOString(),
      runId,
    ).run();
    throw error;
  }
}

async function getOrCreateContext(env: ForecastEnv, event: ForecastEvent, signal:AbortSignal) {
  signal.throwIfAborted();
  const existing = await env.DB.prepare(`
    SELECT * FROM research_contexts WHERE event_id=? AND search_prompt_version='tavily-basic-v1'
  `).bind(event.id).first<Record<string, unknown>>();
  if (existing) return contextFromRow(existing, event);

  if (!env.TAVILY_API_KEY) throw new Error("TAVILY_API_KEY is not configured");
  const searchQuery = buildSearchQuery(event);
  const newsResults = await searchTavily(env.TAVILY_API_KEY, searchQuery, "news", signal);
  let sources = normalizeSources(newsResults, 10) as ResearchSource[];
  if (sources.length < 2) {
    const generalResults = await searchTavily(env.TAVILY_API_KEY, searchQuery, "general", signal);
    sources = normalizeSources([...newsResults, ...generalResults], 10) as ResearchSource[];
  }
  if (sources.length < 2) throw new Error(`Tavily returned only ${sources.length} usable sources`);
  const asOfTime = new Date().toISOString();
  const id = `ctx-${crypto.randomUUID()}`;
  const marketSnapshot = {
    source: event.sourcePlatform === "kalshi" ? "Kalshi" : "Polymarket",
    sourceUrl: event.sourceUrl,
    outcomes: event.outcomes,
    atSelection: {
      observedAt: event.selectedAt,
      yesPrice: event.yesPriceAtSelection,
      volume24h: event.selectionVolume24h,
      totalVolume: event.selectionTotalVolume,
      liquidity: event.selectionLiquidity,
    },
    atForecast: {
      observedAt: event.latestObservedAt,
      yesPrice: event.latestYesPrice,
      volume24h: event.latestVolume24h,
      totalVolume: event.latestTotalVolume,
      liquidity: event.latestLiquidity,
    },
  };
  await env.DB.prepare(`
    INSERT INTO research_contexts (
      id, event_id, selection_run_id, provider, search_query, search_prompt_version,
      sources_json, market_snapshot_json, source_count, status, as_of_time, created_at
    ) VALUES (?, ?, ?, 'tavily', ?, 'tavily-basic-v1', ?, ?, ?, 'ready', ?, ?)
  `).bind(
    id,
    event.id,
    event.selectionRunId,
    searchQuery,
    JSON.stringify(sources),
    JSON.stringify(marketSnapshot),
    sources.length,
    asOfTime,
    asOfTime,
  ).run();
  return { id, event, sources, marketSnapshot, asOfTime };
}

async function searchTavily(apiKey: string, query: string, topic: "news" | "general", signal:AbortSignal) {
  signal.throwIfAborted();
  const response = await fetch("https://api.tavily.com/search", {
    signal:AbortSignal.any([signal, AbortSignal.timeout(FORECAST_SEARCH_TIMEOUT_MS)]),
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      topic,
      search_depth: "basic",
      max_results: 10,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    }),
  });
  if (!response.ok) throw new Error(`Tavily ${topic} search failed with HTTP ${response.status}`);
  const payload = await response.json() as { results?: unknown[] };
  return Array.isArray(payload.results) ? payload.results : [];
}

export async function getForecastPipelineSnapshot(
  db: D1Database = getD1(),
  runtime: Pick<ForecastEnv, "AI" | "TAVILY_API_KEY" | "PROPHET_MODEL_GATEWAY_MODE" | "PROPHET_AI_GATEWAY_ID" | "PROPHET_CLOUDFLARE_MODEL_ID_MAP" | "PROPHET_DISABLED_MODEL_IDS"> = {},
) {
  await ensureForecastingReady(db, runtime.PROPHET_DISABLED_MODEL_IDS);
  const gatewayProblem = modelGatewayConfigurationProblem(runtime);
  const activeModels = getActiveForecastModels(runtime.PROPHET_DISABLED_MODEL_IDS);
  const modelValues = activeModels.length ? activeModels.map(() => "(?)").join(", ") : "(NULL)";
  const modelBindings = activeModels.map((model) => model.participantId);
  const snapshotNow = new Date();
  const todayRunId = dailySelectionRunId(snapshotNow);
  const [counts, runRows, selection, dailyRows] = await Promise.all([
    db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM research_contexts WHERE status='ready') AS contexts_ready,
        (SELECT COUNT(*) FROM model_forecast_runs WHERE status='completed') AS completed,
        (SELECT COUNT(*) FROM model_forecast_runs WHERE status='failed') AS failed
    `).first<Record<string, unknown>>(),
    db.prepare(`
      SELECT mfr.*, rc.source_count, rc.provider, rc.as_of_time, rc.sources_json,
        rc.search_query, rc.market_snapshot_json,
        e.title, e.category
      FROM model_forecast_runs mfr
      JOIN research_contexts rc ON rc.id=mfr.context_id
      JOIN events e ON e.id=mfr.event_id
      ORDER BY mfr.created_at DESC LIMIT 30
    `).all<Record<string, unknown>>(),
    db.prepare(`
      SELECT sr.id, sr.status,
        (SELECT COUNT(DISTINCT si.event_id) FROM selection_items si WHERE si.run_id=sr.id) AS actual_questions
      FROM selection_runs sr WHERE sr.id=? AND sr.config_version=?
    `).bind(todayRunId, CURATION_CONFIG.configVersion).first<Record<string, unknown>>(),
    db.prepare(`
      WITH forecast_models(participant_id) AS (VALUES ${modelValues})
      SELECT si.event_id, fm.participant_id, e.status AS event_status, e.close_time,
        ${publishedForecastSql("e", "fm.participant_id")} AS published,
        latest.status AS latest_status, latest.created_at AS latest_created_at, latest.error AS latest_error
      FROM selection_items si JOIN events e ON e.id=si.event_id
      CROSS JOIN forecast_models fm
      LEFT JOIN model_forecast_runs latest ON latest.id=(
        SELECT r.id FROM model_forecast_runs r
        WHERE r.event_id=e.id AND r.participant_id=fm.participant_id AND r.prompt_version=?
        ORDER BY r.created_at DESC, r.id DESC LIMIT 1
      )
      WHERE si.run_id=?
    `).bind(...modelBindings, FORECAST_CONFIG_VERSION, todayRunId).all<Record<string, unknown>>(),
  ]);
  const dailySlate = summarizeDailyForecasts({
    utcDate:snapshotNow.toISOString().slice(0,10),
    runId:selection ? String(selection.id) : null,
    selectionStatus:selection ? String(selection.status) : null,
    selectedQuestions:Number(selection?.actual_questions || 0),
    models:activeModels, rows:dailyRows.results, now:snapshotNow.getTime(),
  });
  return {
    models: activeModels,
    activeModels: activeModels.map((model) => model.modelId),
    unavailableModels: FORECAST_MODELS.filter((model) => !activeModels.includes(model)).map((model) => model.modelId),
    model: activeModels[0] || FORECAST_MODELS[0],
    configured: {
      modelGateway: !gatewayProblem,
      modelGatewayProblem: gatewayProblem,
      searchSecret: Boolean(runtime.TAVILY_API_KEY),
    },
    stats: {
      contextsReady: Number(counts?.contexts_ready || 0),
      completed: Number(counts?.completed || 0),
      failed: Number(counts?.failed || 0),
      pending: dailySlate.pending,
    },
    dailySlate,
    runs: runRows.results.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      title: row.title,
      category: row.category,
      contextId: row.context_id,
      participantId: row.participant_id,
      modelId: row.model_id,
      status: row.status,
      yesProbability: row.yes_probability === null ? null : Number(row.yes_probability),
      noProbability: row.no_probability === null ? null : Number(row.no_probability),
      probabilities: safeJson(String(row.probabilities_json || "{}"), {}),
      rationale: row.rationale,
      citedSourceRanks: safeJson(String(row.cited_sources_json || "[]"), []),
      sources: safeJson(String(row.sources_json || "[]"), []),
      sourceCount: Number(row.source_count || 0),
      provider: row.provider,
      searchQuery: row.search_query,
      marketSnapshot: safeJson(String(row.market_snapshot_json || "{}"), {}),
      latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
      error: row.error,
      asOfTime: row.as_of_time,
      completedAt: row.completed_at,
    })),
  };
}

function rowToForecastEvent(row: Record<string, unknown>): ForecastEvent {
  const storedOutcomes = safeJson(String(row.event_outcomes_json || "[]"), []) as ForecastEvent["outcomes"];
  const outcomes = storedOutcomes.length
    ? storedOutcomes
    : [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }];
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description || ""),
    category: String(row.category || "Entertainment"),
    closeTime: row.close_time ? String(row.close_time) : null,
    rules: String(row.rules || ""),
    selectionRunId: String(row.run_id),
    sourcePlatform: row.source_platform === "kalshi" ? "kalshi" : "polymarket",
    sourceUrl: String(row.source_url || ""),
    selectedAt: String(row.selected_at || ""),
    latestObservedAt: String(row.last_seen_at || new Date().toISOString()),
    yesPriceAtSelection: Number(row.price_at_selection ?? 0.5),
    selectionVolume24h: Number(row.volume_24h || 0),
    selectionTotalVolume: Number(row.total_volume || 0),
    selectionLiquidity: Number(row.liquidity || 0),
    latestYesPrice: Number(row.latest_yes_price ?? row.price_at_selection ?? 0.5),
    latestVolume24h: Number(row.latest_volume_24h ?? row.volume_24h ?? 0),
    latestTotalVolume: Number(row.latest_total_volume ?? row.total_volume ?? 0),
    latestLiquidity: Number(row.latest_liquidity ?? row.liquidity ?? 0),
    eventType: String(row.event_type || "binary") === "categorical" ? "categorical" : "binary",
    outcomes,
  };
}

function contextFromRow(row: Record<string, unknown>, event: ForecastEvent) {
  return {
    id: String(row.id),
    event,
    sources: safeJson(String(row.sources_json || "[]"), []) as ResearchSource[],
    marketSnapshot: safeJson(String(row.market_snapshot_json || "{}"), {
      source: event.sourcePlatform === "kalshi" ? "Kalshi" : "Polymarket",
      sourceUrl: event.sourceUrl,
      atSelection: {
        observedAt: event.selectedAt,
        yesPrice: event.yesPriceAtSelection,
        volume24h: event.selectionVolume24h,
        totalVolume: event.selectionTotalVolume,
        liquidity: event.selectionLiquidity,
      },
      atForecast: {
        observedAt: event.latestObservedAt,
        yesPrice: event.latestYesPrice,
        volume24h: event.latestVolume24h,
        totalVolume: event.latestTotalVolume,
        liquidity: event.latestLiquidity,
      },
    }) as {
      source: string;
      sourceUrl: string;
      atSelection: { observedAt: string; yesPrice: number; volume24h: number; totalVolume: number; liquidity: number };
      atForecast: { observedAt: string; yesPrice: number; volume24h: number; totalVolume: number; liquidity: number };
    },
    asOfTime: String(row.as_of_time),
  };
}

function safeJson(value: string, fallback: unknown) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function serializeRawResponse(raw: unknown) {
  if (raw === undefined) return null;
  const text = typeof raw === "string"
    ? raw
    : typeof (raw as { response?: unknown })?.response === "string"
      ? String((raw as { response: string }).response)
      : JSON.stringify(raw);
  return text.slice(0, 12000);
}

function deterministicSeed(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (Math.abs(hash) % 2_000_000_000) + 1;
}

async function mapWithConcurrency<Input, Output>(
  items: Input[],
  concurrency: number,
  task: (item: Input, index: number) => Promise<Output>,
) {
  const output = new Array<Output>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await task(items[index], index);
    }
  }
  const workerCount = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return output;
}

function createProviderLane(signal:AbortSignal) {
  const tails = new Map<string, Promise<void>>();
  let pacingTail = Promise.resolve();
  let nextStartAt = 0;
  const providerNextStartAt = new Map<string, number>();
  const pace = (lane: string) => {
    const turn = pacingTail.catch(() => undefined).then(async () => {
      const delay = Math.max(0, nextStartAt - Date.now(), (providerNextStartAt.get(lane) || 0) - Date.now());
      if (delay) await waitForForecast(delay, signal);
      signal.throwIfAborted();
      nextStartAt = Date.now() + 4000;
      providerNextStartAt.set(lane, Date.now() + providerCooldownMs(lane));
    });
    pacingTail = turn;
    return turn;
  };
  return {
    async run<Output>(modelId: string, task: () => Promise<Output>) {
      const lane = providerLaneForModel(modelId);
      const prior = tails.get(lane) ?? Promise.resolve();
      const result = prior.catch(() => undefined).then(async () => {
        await pace(lane);
        signal.throwIfAborted();
        return task();
      });
      tails.set(lane, result.then(() => undefined, () => undefined));
      return result;
    },
  };
}

function providerCooldownMs(lane: string) {
  if (lane === "anthropic") return 12000;
  if (["google", "xai"].includes(lane)) return 5000;
  return 4000;
}

function providerLaneForModel(modelId: string) {
  if (modelId.startsWith("claude-")) return "anthropic";
  if (modelId.startsWith("gemini-")) return "google";
  if (modelId.startsWith("grok-")) return "xai";
  if (modelId.startsWith("deepseek-")) return "deepseek";
  if (modelId.startsWith("kimi-")) return "moonshot";
  if (modelId.startsWith("minimax-")) return "minimax";
  if (modelId.startsWith("glm-")) return "zai";
  return modelId;
}
