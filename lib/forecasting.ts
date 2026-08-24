import { getD1 } from "@/db";
import { recordAutomatedEventForecast, recordAutomatedForecast, syncAggregates } from "@/lib/arena";
import {
  FORECAST_JOBS_PER_RUN,
  FORECAST_MODELS,
  RETIRED_FORECAST_PARTICIPANT_IDS,
  buildProphetPredictionPrompt,
  buildSearchQuery,
  normalizeSources,
  getActiveForecastModels,
} from "@/lib/forecast-core.js";
import { parseEventPredictionResponse } from "@/lib/event-core.js";
import { modelGatewayConfigurationProblem, runModelGateway } from "@/lib/model-gateway";

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
];

let forecastingSchemaReady = false;
let modelRegistryReady = false;

export async function ensureForecastingReady(db: D1Database = getD1()) {
  if (!forecastingSchemaReady) {
    await db.batch(FORECAST_SCHEMA.map((statement) => db.prepare(statement)));
    forecastingSchemaReady = true;
  }
  if (!modelRegistryReady) {
    const registryStatements = FORECAST_MODELS.map((model) => db.prepare(`
      INSERT INTO participants (id, name, organization, kind, color, status)
      VALUES (?, ?, ?, 'forecaster', ?, 'active')
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, organization=excluded.organization,
        color=excluded.color, status='active'
    `).bind(
      model.participantId,
      model.participantName,
      model.organization,
      model.color,
    ));
    if (RETIRED_FORECAST_PARTICIPANT_IDS.length) {
      registryStatements.push(db.prepare(`
        UPDATE participants SET status='inactive'
        WHERE id IN (${RETIRED_FORECAST_PARTICIPANT_IDS.map(() => "?").join(", ")})
      `).bind(...RETIRED_FORECAST_PARTICIPANT_IDS));
    }
    await db.batch(registryStatements);
    modelRegistryReady = true;
  }
}

export async function runForecastBatch(
  env: ForecastEnv,
  jobLimit = FORECAST_JOBS_PER_RUN,
  requestedEventIds: string[] = [],
) {
  await ensureForecastingReady(env.DB);
  const gatewayProblem = modelGatewayConfigurationProblem(env);
  if (!env.TAVILY_API_KEY || gatewayProblem) {
    return {
      configured: false,
      processed: 0,
      completed: 0,
      message: !env.TAVILY_API_KEY ? "TAVILY_API_KEY is not configured" : gatewayProblem,
    };
  }

  // A model run is persisted before aggregate generation begins. If a Worker
  // reaches its wall-time limit after a slower model response, the base
  // forecast is safe but its aggregate rows can be missing. Repair those rows
  // at the beginning of every scheduled pass so categorical events with many
  // outcomes still become scoreable without rerunning paid inference/search.
  const repairedAggregates = await repairMissingAggregates(env.DB);

  const batchJobLimit = Math.max(1, Math.min(72, jobLimit));
  const targetEventIds = [...new Set(requestedEventIds.map((value) => String(value).trim()).filter(Boolean))].slice(0, 10);
  const targetEventClause = targetEventIds.length
    ? `AND e.id IN (${targetEventIds.map(() => "?").join(", ")})`
    : "";
  const activeModels = getActiveForecastModels(env.PROPHET_DISABLED_MODEL_IDS);
  const modelValues = activeModels.map(() => "(?, ?)").join(", ");
  const modelBindings = activeModels.flatMap((model, index) => [model.participantId, index]);
  const rows = await env.DB.prepare(`
    WITH forecast_models(participant_id, model_order) AS (VALUES ${modelValues}),
    pending_jobs AS (
      SELECT e.id AS event_id, fm.participant_id, fm.model_order
      FROM events e
      JOIN selection_items si ON si.event_id=e.id
      CROSS JOIN forecast_models fm
      WHERE e.status='open'
        AND (e.close_time IS NULL OR datetime(e.close_time) > datetime('now'))
        ${targetEventClause}
        AND NOT EXISTS (
        SELECT 1 FROM model_forecast_runs completed_run
        WHERE completed_run.event_id=e.id
          AND completed_run.participant_id=fm.participant_id
          AND completed_run.status='completed'
      )
      AND NOT EXISTS (
        SELECT 1 FROM model_forecast_runs recent_failure
        WHERE recent_failure.event_id=e.id
          AND recent_failure.participant_id=fm.participant_id
          AND recent_failure.status='failed'
          AND datetime(recent_failure.completed_at) > datetime('now', '-15 minutes')
      )
      GROUP BY e.id, fm.participant_id, fm.model_order
      ORDER BY MIN(si.selected_at), MIN(si.category), MIN(si.rank), e.id, fm.model_order
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
    JOIN selection_items si ON si.event_id=e.id
    JOIN polymarket_candidates pc ON pc.market_id=si.market_id
    ORDER BY si.selected_at, si.category, si.rank, e.id, pj.model_order
  `).bind(...modelBindings, ...targetEventIds, batchJobLimit).all<Record<string, unknown>>();

  const jobs = rows.results.flatMap((row) => {
    const event = rowToForecastEvent(row);
    const model = activeModels.find((candidate) => candidate.participantId === row.target_participant_id);
    return model ? [{ event, model }] : [];
  });
  const contextPromises = new Map<string, Promise<Awaited<ReturnType<typeof getOrCreateContext>>>>();
  const outcomes = await mapWithConcurrency(jobs, 3, async ({ event, model }) => {
    try {
      let contextPromise = contextPromises.get(event.id);
      if (!contextPromise) {
        contextPromise = getOrCreateContext(env, event);
        contextPromises.set(event.id, contextPromise);
      }
      return await forecastEvent(env, event, model, await contextPromise);
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
    repairedAggregates,
    jobLimit: batchJobLimit,
    targetEventIds,
    processedEvents: new Set(outcomes.map((item) => item.eventId)).size,
    processed: outcomes.length,
    completed: outcomes.filter((item) => item.status === "completed").length,
    outcomes,
  };
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
) {
  const runId = `run-${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO model_forecast_runs (
      id, context_id, event_id, participant_id, model_id, prompt_version, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
    ON CONFLICT(context_id, participant_id) DO UPDATE SET
      id=excluded.id, model_id=excluded.model_id, prompt_version=excluded.prompt_version,
      status='running', error=NULL, created_at=excluded.created_at, completed_at=NULL
  `).bind(
    runId,
    context.id,
    event.id,
    model.participantId,
    model.modelId,
    model.promptVersion,
    startedAt,
  ).run();

  const prompt = buildProphetPredictionPrompt(context);
  const requestStarted = Date.now();
  let raw: unknown;
  try {
    let parsed;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const gatewayResult = await runModelGateway(env, {
        modelId: model.modelId,
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
      raw = gatewayResult.payload;
      try {
        parsed = parseEventPredictionResponse(raw, event.outcomes);
        break;
      } catch (parseError) {
        if (attempt === 1) throw parseError;
      }
    }
    if (!parsed) throw new Error("Model response could not be parsed");
    const completedAt = new Date().toISOString();
    const latencyMs = Date.now() - requestStarted;
    await env.DB.prepare(`
      UPDATE model_forecast_runs SET status='completed', yes_probability=?, no_probability=?,
        probabilities_json=?, rationale=?, cited_sources_json=?, raw_response=?, latency_ms=?, completed_at=?,
        error=NULL WHERE context_id=? AND participant_id=?
    `).bind(
      parsed.probabilities.yes ?? null,
      parsed.probabilities.no ?? null,
      JSON.stringify(parsed.probabilities),
      parsed.rationale,
      JSON.stringify(parsed.citedSourceRanks),
      parsed.rawText.slice(0, 12000),
      latencyMs,
      completedAt,
      context.id,
      model.participantId,
    ).run();
    const components = {
      contextId: context.id,
      modelId: model.modelId,
      citedSourceRanks: parsed.citedSourceRanks,
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
      });
    } else {
      await recordAutomatedForecast({
        eventId: event.id,
        participantId: model.participantId,
        participantName: model.participantName,
        probability: parsed.probabilities.yes,
        rationale: parsed.rationale,
        version: model.promptVersion,
        components,
      });
    }
    return { eventId: event.id, contextId: context.id, modelId: model.modelId, status: "completed", probabilities: parsed.probabilities };
  } catch (error) {
    await env.DB.prepare(`
      UPDATE model_forecast_runs SET status='failed', error=?, raw_response=?, latency_ms=?, completed_at=?
      WHERE context_id=? AND participant_id=?
    `).bind(
      errorMessage(error).slice(0, 1500),
      serializeRawResponse(raw),
      Date.now() - requestStarted,
      new Date().toISOString(),
      context.id,
      model.participantId,
    ).run();
    throw error;
  }
}

async function getOrCreateContext(env: ForecastEnv, event: ForecastEvent) {
  const existing = await env.DB.prepare(`
    SELECT * FROM research_contexts WHERE event_id=? AND search_prompt_version='tavily-basic-v1'
  `).bind(event.id).first<Record<string, unknown>>();
  if (existing) return contextFromRow(existing, event);

  if (!env.TAVILY_API_KEY) throw new Error("TAVILY_API_KEY is not configured");
  const searchQuery = buildSearchQuery(event);
  const newsResults = await searchTavily(env.TAVILY_API_KEY, searchQuery, "news");
  let sources = normalizeSources(newsResults, 10) as ResearchSource[];
  if (sources.length < 2) {
    const generalResults = await searchTavily(env.TAVILY_API_KEY, searchQuery, "general");
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

async function searchTavily(apiKey: string, query: string, topic: "news" | "general") {
  const response = await fetch("https://api.tavily.com/search", {
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
  await ensureForecastingReady(db);
  const gatewayProblem = modelGatewayConfigurationProblem(runtime);
  const activeModels = getActiveForecastModels(runtime.PROPHET_DISABLED_MODEL_IDS);
  const modelValues = activeModels.map(() => "(?)").join(", ");
  const modelBindings = activeModels.map((model) => model.participantId);
  const [counts, runRows, pending] = await Promise.all([
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
      WITH forecast_models(participant_id) AS (VALUES ${modelValues})
      SELECT COUNT(*) AS count FROM events e
      JOIN selection_items si ON si.event_id=e.id
      CROSS JOIN forecast_models
      LEFT JOIN model_forecast_runs mfr
        ON mfr.event_id=e.id AND mfr.participant_id=forecast_models.participant_id AND mfr.status='completed'
      WHERE e.status='open'
        AND (e.close_time IS NULL OR datetime(e.close_time) > datetime('now'))
        AND mfr.id IS NULL
    `).bind(...modelBindings).first<{ count: number }>(),
  ]);
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
      pending: Number(pending?.count || 0),
    },
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
