import { getD1 } from "@/db";
import { recordAutomatedForecast } from "@/lib/arena";
import {
  FORECAST_MODEL,
  buildProphetPredictionPrompt,
  buildSearchQuery,
  normalizeSources,
  parsePredictionResponse,
} from "@/lib/forecast-core.js";

type ForecastEnv = {
  DB: D1Database;
  AI?: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
  TAVILY_API_KEY?: string;
};

type ForecastEvent = {
  id: string;
  title: string;
  description: string;
  category: string;
  closeTime: string | null;
  rules: string;
  selectionRunId: string;
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
};

type ResearchSource = {
  rank: number;
  title: string;
  url: string;
  content: string;
  publishedDate: string | null;
  score: number | null;
};

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
    await db.prepare(`
      INSERT INTO participants (id, name, organization, kind, color, status)
      VALUES (?, ?, ?, 'forecaster', ?, 'active')
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, organization=excluded.organization,
        color=excluded.color, status='active'
    `).bind(
      FORECAST_MODEL.participantId,
      FORECAST_MODEL.participantName,
      FORECAST_MODEL.organization,
      FORECAST_MODEL.color,
    ).run();
    modelRegistryReady = true;
  }
}

export async function runForecastBatch(env: ForecastEnv, limit = 3) {
  await ensureForecastingReady(env.DB);
  if (!env.TAVILY_API_KEY || !env.AI) {
    return {
      configured: false,
      processed: 0,
      completed: 0,
      message: !env.TAVILY_API_KEY ? "TAVILY_API_KEY is not configured" : "Workers AI binding is unavailable",
    };
  }

  const rows = await env.DB.prepare(`
    SELECT e.id, e.title, e.description, e.category, e.close_time,
      pc.rules, pc.source_url, pc.last_seen_at, pc.yes_price AS latest_yes_price,
      pc.volume_24h AS latest_volume_24h, pc.total_volume AS latest_total_volume,
      pc.liquidity AS latest_liquidity, si.run_id, si.selected_at,
      si.price_at_selection, si.volume_24h, si.total_volume, si.liquidity
    FROM events e
    JOIN selection_items si ON si.event_id=e.id
    JOIN polymarket_candidates pc ON pc.market_id=si.market_id
    LEFT JOIN model_forecast_runs mfr
      ON mfr.event_id=e.id AND mfr.participant_id=? AND mfr.status='completed'
    WHERE e.status='open' AND mfr.id IS NULL
    ORDER BY si.selected_at, si.rank
    LIMIT ?
  `).bind(FORECAST_MODEL.participantId, Math.max(1, Math.min(10, limit))).all<Record<string, unknown>>();

  const outcomes = [];
  for (const row of rows.results) {
    const event = rowToForecastEvent(row);
    try {
      outcomes.push(await forecastEvent(env, event));
    } catch (error) {
      await env.DB.prepare(`
        INSERT INTO audit_log (action, entity_type, entity_id, detail_json, actor, created_at)
        VALUES ('forecast.pipeline_failed', 'event', ?, ?, 'forecast-cron', ?)
      `).bind(
        event.id,
        JSON.stringify({ modelId: FORECAST_MODEL.modelId, error: errorMessage(error).slice(0, 800) }),
        new Date().toISOString(),
      ).run();
      outcomes.push({ eventId: event.id, status: "failed", error: errorMessage(error) });
    }
  }
  return {
    configured: true,
    processed: outcomes.length,
    completed: outcomes.filter((item) => item.status === "completed").length,
    outcomes,
  };
}

async function forecastEvent(env: ForecastEnv, event: ForecastEvent) {
  const context = await getOrCreateContext(env, event);
  const runId = `run-${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO model_forecast_runs (
      id, context_id, event_id, participant_id, model_id, prompt_version, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
    ON CONFLICT(context_id, participant_id) DO UPDATE SET
      id=excluded.id, status='running', error=NULL, created_at=excluded.created_at, completed_at=NULL
  `).bind(
    runId,
    context.id,
    event.id,
    FORECAST_MODEL.participantId,
    FORECAST_MODEL.modelId,
    FORECAST_MODEL.promptVersion,
    startedAt,
  ).run();

  const prompt = buildProphetPredictionPrompt(context);
  const requestStarted = Date.now();
  try {
    let parsed;
    let raw: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      raw = await env.AI!.run(FORECAST_MODEL.modelId, {
        messages: [
          { role: "system", content: "Return valid JSON only. Calibrate probabilities carefully." },
          { role: "user", content: attempt ? `${prompt}\n\nYour prior response was invalid. Return the required JSON object only.` : prompt },
        ],
        max_tokens: 700,
        temperature: 0,
        seed: 42,
      });
      try {
        parsed = parsePredictionResponse(raw);
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
        rationale=?, cited_sources_json=?, raw_response=?, latency_ms=?, completed_at=?,
        error=NULL WHERE context_id=? AND participant_id=?
    `).bind(
      parsed.yesProbability,
      parsed.noProbability,
      parsed.rationale,
      JSON.stringify(parsed.citedSourceRanks),
      parsed.rawText.slice(0, 12000),
      latencyMs,
      completedAt,
      context.id,
      FORECAST_MODEL.participantId,
    ).run();
    await recordAutomatedForecast({
      eventId: event.id,
      participantId: FORECAST_MODEL.participantId,
      participantName: FORECAST_MODEL.participantName,
      probability: parsed.yesProbability,
      rationale: parsed.rationale,
      version: FORECAST_MODEL.promptVersion,
      components: {
        contextId: context.id,
        modelId: FORECAST_MODEL.modelId,
        citedSourceRanks: parsed.citedSourceRanks,
      },
    });
    return { eventId: event.id, contextId: context.id, status: "completed", probability: parsed.yesProbability };
  } catch (error) {
    await env.DB.prepare(`
      UPDATE model_forecast_runs SET status='failed', error=?, latency_ms=?, completed_at=?
      WHERE context_id=? AND participant_id=?
    `).bind(
      errorMessage(error).slice(0, 1500),
      Date.now() - requestStarted,
      new Date().toISOString(),
      context.id,
      FORECAST_MODEL.participantId,
    ).run();
    throw error;
  }
}

async function getOrCreateContext(env: ForecastEnv, event: ForecastEvent) {
  const existing = await env.DB.prepare(`
    SELECT * FROM research_contexts WHERE event_id=? AND search_prompt_version='tavily-basic-v1'
  `).bind(event.id).first<Record<string, unknown>>();
  if (existing) return contextFromRow(existing, event);

  const searchQuery = buildSearchQuery(event);
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TAVILY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: searchQuery,
      topic: "news",
      search_depth: "basic",
      max_results: 10,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    }),
  });
  if (!response.ok) throw new Error(`Tavily search failed with HTTP ${response.status}`);
  const payload = await response.json() as { results?: unknown[] };
  const sources = normalizeSources(payload.results, 10) as ResearchSource[];
  if (sources.length < 3) throw new Error(`Tavily returned only ${sources.length} usable sources`);
  const asOfTime = new Date().toISOString();
  const id = `ctx-${crypto.randomUUID()}`;
  const marketSnapshot = {
    source: "Polymarket",
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

export async function getForecastPipelineSnapshot(
  db: D1Database = getD1(),
  runtime: { AI?: unknown; TAVILY_API_KEY?: string } = {},
) {
  await ensureForecastingReady(db);
  const [counts, runRows, pending] = await Promise.all([
    db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM research_contexts WHERE status='ready') AS contexts_ready,
        (SELECT COUNT(*) FROM model_forecast_runs WHERE status='completed') AS completed,
        (SELECT COUNT(*) FROM model_forecast_runs WHERE status='failed') AS failed
    `).first<Record<string, unknown>>(),
    db.prepare(`
      SELECT mfr.*, rc.source_count, rc.provider, rc.as_of_time, rc.sources_json,
        e.title, e.category
      FROM model_forecast_runs mfr
      JOIN research_contexts rc ON rc.id=mfr.context_id
      JOIN events e ON e.id=mfr.event_id
      ORDER BY mfr.created_at DESC LIMIT 30
    `).all<Record<string, unknown>>(),
    db.prepare(`
      SELECT COUNT(*) AS count FROM events e
      JOIN selection_items si ON si.event_id=e.id
      LEFT JOIN model_forecast_runs mfr
        ON mfr.event_id=e.id AND mfr.participant_id=? AND mfr.status='completed'
      WHERE e.status='open' AND mfr.id IS NULL
    `).bind(FORECAST_MODEL.participantId).first<{ count: number }>(),
  ]);
  return {
    model: FORECAST_MODEL,
    configured: {
      aiBinding: Boolean(runtime.AI),
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
      modelId: row.model_id,
      status: row.status,
      yesProbability: row.yes_probability === null ? null : Number(row.yes_probability),
      noProbability: row.no_probability === null ? null : Number(row.no_probability),
      rationale: row.rationale,
      citedSourceRanks: safeJson(String(row.cited_sources_json || "[]"), []),
      sources: safeJson(String(row.sources_json || "[]"), []),
      sourceCount: Number(row.source_count || 0),
      provider: row.provider,
      marketSnapshot: safeJson(String(row.market_snapshot_json || "{}"), {}),
      latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
      error: row.error,
      asOfTime: row.as_of_time,
      completedAt: row.completed_at,
    })),
  };
}

function rowToForecastEvent(row: Record<string, unknown>): ForecastEvent {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description || ""),
    category: String(row.category || "General"),
    closeTime: row.close_time ? String(row.close_time) : null,
    rules: String(row.rules || ""),
    selectionRunId: String(row.run_id),
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
  };
}

function contextFromRow(row: Record<string, unknown>, event: ForecastEvent) {
  return {
    id: String(row.id),
    event,
    sources: safeJson(String(row.sources_json || "[]"), []) as ResearchSource[],
    marketSnapshot: safeJson(String(row.market_snapshot_json || "{}"), {
      source: "Polymarket",
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
