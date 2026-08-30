import { getD1 } from "@/db";
import {
  CANONICAL_CATEGORIES,
  CURATION_CONFIG,
  dailySelectionRunId,
  evaluateHardEligibility,
  normalizeKalshiMarket,
  normalizePolymarketMarket,
  rankCandidates,
  selectPersistenceCandidates,
  selectRapidResolutionCandidates,
  selectDiverseSourceBalancedCandidates,
  validateDailySlate,
} from "@/lib/curation-core";
import {
  inspectKalshiMarket,
  inspectPolymarketBinaryMarket,
  inspectPolymarketCategoricalEvent,
  selectResolutionCheckRows,
} from "@/lib/event-state-core.js";
import { lockEvent } from "@/lib/event-state";
import { DAILY_CANDIDATES_SQL, DAILY_SELECTION_CLAIM_SQL, dailySelectionNeedsRetry } from "@/lib/curation-pipeline-core.js";

type Candidate = Omit<ReturnType<typeof normalizePolymarketMarket>, "sourcePlatform"> & {
  sourcePlatform: "polymarket" | "kalshi";
  eligible: boolean;
  reasons: string[];
  selectionScore: number;
  volume24Percentile: number;
  alreadySelected?: boolean;
  categoryRank?: number;
};

type EventOutcome = {
  key: string;
  label: string;
  marketId: string | null;
  sourceUrl: string;
  price: number;
  volume24h: number;
  totalVolume: number;
  liquidity: number;
};

type EventCandidate = Candidate & {
  eventType: "binary" | "categorical";
  eventOutcomes: EventOutcome[];
};

const GAMMA_API = "https://gamma-api.polymarket.com";
const KALSHI_API = "https://external-api.kalshi.com/trade-api/v2";
const KALSHI_API_FALLBACK_ORIGIN = "https://api.elections.kalshi.com";
const MAX_POLYMARKET_DISCOVERY_PAGES = 3;
const POLYMARKET_DISCOVERY_PAGE_SIZE = 100;
const MAX_POLYMARKET_HYDRATED_EVENTS = 48;
const MAX_KALSHI_SERIES_REQUESTS = 24;
const KALSHI_EVENTS_PER_SERIES = 30;
const KALSHI_DISCOVERY_GROUP_TARGET = 4;
const INTAKE_CONCURRENCY = 2;
const INTAKE_REQUEST_TIMEOUT_MS = 8_000;
const INTAKE_SOURCE_TIMEOUT_MS = 45_000;
const INTAKE_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const INTAKE_SOURCE_MAX_BYTES = 32 * 1024 * 1024;
const RAPID_RESOLUTION_HOURS = 3;
const RAPID_MINIMUM_LEAD_MINUTES = 15;
const RAPID_EVENT_LIMIT = 10;
const RAPID_MAX_PER_DIVERSITY_GROUP = 4;
const RAPID_MINIMUM_POLYMARKET_LIQUIDITY = 0;
const RAPID_MINIMUM_YES_PRICE = 0.01;
const RAPID_MAXIMUM_YES_PRICE = 0.99;
const RAPID_ALLOWED_REASONS = [
  "outside_close_window",
  "low_total_volume",
  "low_24h_volume",
  "low_liquidity",
  "market_too_new",
  "extreme_or_missing_price",
];
const MAX_RESOLUTION_CHECKS_PER_RUN = 24;
const EXTERNAL_FETCH_TIMEOUT_MS = 15_000;
const MAX_EXTERNAL_PAGE_BYTES = 8 * 1024 * 1024;
const STALE_SYNC_MINUTES = 20;

const CURATION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS polymarket_candidates (
    market_id TEXT PRIMARY KEY, source_platform TEXT NOT NULL DEFAULT 'polymarket',
    source_event_id TEXT NOT NULL, diversity_group_id TEXT NOT NULL DEFAULT '', event_slug TEXT NOT NULL DEFAULT '',
    market_slug TEXT NOT NULL DEFAULT '', series_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', rules TEXT NOT NULL DEFAULT '', category TEXT NOT NULL,
    category_confidence REAL NOT NULL DEFAULT 0, tags_json TEXT NOT NULL DEFAULT '[]',
    outcomes_json TEXT NOT NULL DEFAULT '[]', close_time TEXT, start_time TEXT,
    yes_price REAL NOT NULL DEFAULT 0, volume_24h REAL NOT NULL DEFAULT 0,
    total_volume REAL NOT NULL DEFAULT 0, liquidity REAL NOT NULL DEFAULT 0,
    volume_percentile REAL NOT NULL DEFAULT 0, selection_score REAL NOT NULL DEFAULT 0,
    eligible INTEGER NOT NULL DEFAULT 0, rejection_reasons_json TEXT NOT NULL DEFAULT '[]',
    source_url TEXT NOT NULL DEFAULT '', raw_json TEXT NOT NULL DEFAULT '{}',
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    event_title TEXT NOT NULL DEFAULT '', event_neg_risk INTEGER NOT NULL DEFAULT 0,
    event_neg_risk_augmented INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS market_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, market_id TEXT NOT NULL,
    captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, yes_price REAL NOT NULL,
    volume_24h REAL NOT NULL, total_volume REAL NOT NULL, liquidity REAL NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS curation_sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL,
    fetched_events INTEGER NOT NULL DEFAULT 0, fetched_markets INTEGER NOT NULL DEFAULT 0,
    eligible_markets INTEGER NOT NULL DEFAULT 0, detail_json TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS selection_runs (
    id TEXT PRIMARY KEY, config_version TEXT NOT NULL, taxonomy_version TEXT NOT NULL,
    status TEXT NOT NULL, candidate_count INTEGER NOT NULL DEFAULT 0,
    eligible_count INTEGER NOT NULL DEFAULT 0, selected_count INTEGER NOT NULL DEFAULT 0,
    category_counts_json TEXT NOT NULL DEFAULT '{}', source_counts_json TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS selection_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, market_id TEXT NOT NULL,
    event_id TEXT NOT NULL, source_platform TEXT NOT NULL DEFAULT 'polymarket',
    category TEXT NOT NULL, rank INTEGER NOT NULL,
    selection_score REAL NOT NULL, price_at_selection REAL NOT NULL,
    volume_24h REAL NOT NULL, total_volume REAL NOT NULL, liquidity REAL NOT NULL,
    selected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(market_id), UNIQUE(run_id, market_id)
  )`,
  `CREATE TABLE IF NOT EXISTS event_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, outcome_key TEXT NOT NULL,
    label TEXT NOT NULL, market_id TEXT, source_url TEXT NOT NULL DEFAULT '',
    price_at_selection REAL NOT NULL DEFAULT 0, volume_24h REAL NOT NULL DEFAULT 0,
    total_volume REAL NOT NULL DEFAULT 0, liquidity REAL NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, outcome_key)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_candidates_eligible_category ON polymarket_candidates(eligible, category, selection_score DESC)",
  "CREATE INDEX IF NOT EXISTS idx_candidates_seen ON polymarket_candidates(last_seen_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_market_snapshots_market ON market_snapshots(market_id, captured_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_selection_items_run ON selection_items(run_id, category, rank)",
  "CREATE INDEX IF NOT EXISTS idx_selection_items_event ON selection_items(event_id)",
  "CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON curation_sync_runs(started_at DESC)",
];

let curationSchemaReady = false;

export async function ensureCurationReady(db: D1Database = getD1()) {
  if (curationSchemaReady) return;
  await db.batch(CURATION_SCHEMA.map((statement) => db.prepare(statement)));
  await ensureColumn(db, "polymarket_candidates", "source_platform", "TEXT NOT NULL DEFAULT 'polymarket'");
  await ensureColumn(db, "polymarket_candidates", "diversity_group_id", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, "selection_runs", "source_counts_json", "TEXT NOT NULL DEFAULT '{}'");
  await ensureColumn(db, "selection_items", "source_platform", "TEXT NOT NULL DEFAULT 'polymarket'");
  // The legacy diversity backfill is migration-owned. Re-scanning the entire
  // candidate history on every cold isolate can exceed D1's per-query CPU
  // budget even when there are no rows left to update.
  curationSchemaReady = true;
}

export async function syncLiveMarketCandidates(db: D1Database = getD1(), now = new Date()) {
  await ensureCurationReady(db);
  const startedAt = now.toISOString();
  await closeStaleSyncRuns(db, now);
  const run = await db.prepare(
    "INSERT INTO curation_sync_runs (status, started_at) VALUES ('running', ?) RETURNING id",
  ).bind(startedAt).first<{ id: number }>();
  const runId = run?.id;
  const checkpoint = async (stage: string, detail: Record<string, unknown> = {}, key = "progress") => {
    if (!runId) return;
    await db.prepare(`
      UPDATE curation_sync_runs SET detail_json=json_set(
        CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,
        '$.lastStage', ?, '$.lastStageAt', ?, ?, json(?)
      ) WHERE id=? AND status='running'
    `).bind(stage, new Date().toISOString(), `$.${key}`, JSON.stringify(detail), runId).run();
  };
  const collectSource = async (source: string, collect: () => Promise<SourceFetchResult>) => {
    try {
      const result = await collect();
      await checkpoint(`${source}_fetched`, result.diagnostics, `sourceProgress.${source}`);
      return result;
    } catch (error) {
      await checkpoint(`${source}_failed`, { error: error instanceof Error ? error.message : String(error) }, `sourceProgress.${source}`);
      throw error;
    }
  };

  try {
    await checkpoint("intake_started");
    const used = await db.prepare(`
      SELECT DISTINCT c.diversity_group_id
      FROM selection_items si
      JOIN selection_runs sr ON sr.id=si.run_id AND sr.status='completed'
      JOIN polymarket_candidates c ON c.market_id=si.market_id
      WHERE c.diversity_group_id!=''
    `).all<{ diversity_group_id: string }>();
    const blockedGroups = new Set(used.results.map((row) => row.diversity_group_id));
    const sourceResults = await Promise.allSettled([
      collectSource("polymarket", () => fetchPolymarketCandidates(now, blockedGroups)),
      collectSource("kalshi", () => fetchKalshiCandidates(now, blockedGroups)),
    ]);
    const successes = sourceResults
      .filter((result): result is PromiseFulfilledResult<SourceFetchResult> => result.status === "fulfilled")
      .map((result) => result.value);
    if (!successes.length) {
      const detail = sourceResults.map((result) => result.status === "rejected"
        ? (result.reason instanceof Error ? result.reason.message : String(result.reason))
        : "ok");
      throw new Error(`Both market sources failed: ${detail.join("; ")}`);
    }
    const normalized = successes.flatMap((result) => result.candidates);
    const ranked = rankCandidates(normalized, now) as Candidate[];
    const regularPersisted = selectPersistenceCandidates(ranked) as Candidate[];
    const rapidEligible = selectRapidResolutionCandidates(ranked, {
      now,
      horizonHours: RAPID_RESOLUTION_HOURS,
      minimumLeadMinutes: RAPID_MINIMUM_LEAD_MINUTES,
      allowedReasons: RAPID_ALLOWED_REASONS,
      minimumPolymarketLiquidity: RAPID_MINIMUM_POLYMARKET_LIQUIDITY,
      minimumYesPrice: RAPID_MINIMUM_YES_PRICE,
      maximumYesPrice: RAPID_MAXIMUM_YES_PRICE,
      limit: 24,
    }) as Candidate[];
    const rapidEarliest = now.getTime() + RAPID_MINIMUM_LEAD_MINUTES * 60_000;
    const rapidLatest = now.getTime() + RAPID_RESOLUTION_HOURS * 3_600_000;
    const rapidWindow = ranked.filter((candidate) => {
      const closeTime = Date.parse(candidate.closeTime || "");
      return Number.isFinite(closeTime) && closeTime >= rapidEarliest && closeTime <= rapidLatest;
    }).sort((left, right) => right.volume24h - left.volume24h).slice(0, 200);
    const persisted = [...new Map(
      [...regularPersisted, ...rapidEligible].map((candidate) => [candidate.marketId, candidate]),
    ).values()];
    const rapidReasonCounts: Record<string, number> = {};
    for (const candidate of rapidWindow) {
      for (const reason of candidate.reasons) rapidReasonCounts[reason] = (rapidReasonCounts[reason] || 0) + 1;
    }
    const categoryStats = Object.fromEntries(CANONICAL_CATEGORIES.map((category) => [category, {
      candidates: ranked.filter((candidate) => candidate.category === category).length,
      eligible: ranked.filter((candidate) => candidate.category === category && candidate.eligible).length,
    }]));

    await checkpoint("persisting", { total: persisted.length, completed: 0 });
    // Keep prepared statements and JSON serialization local to forty rows.
    // Multi-row inserts stay below D1's 100-bind limit and reduce query count.
    let persistedStatements = 0;
    for (let offset = 0; offset < persisted.length; offset += 40) {
      const batch = persisted.slice(offset, offset + 40);
      const statements: D1PreparedStatement[] = [];
      for (let index = 0; index < batch.length; index += 3) {
        const rows = batch.slice(index, index + 3);
        const values = rows.map(() => `(${Array(31).fill("?").join(", ")})`).join(", ");
        statements.push(db.prepare(`
        INSERT INTO polymarket_candidates (
          market_id, source_platform, source_event_id, diversity_group_id,
          event_slug, market_slug, series_id, title, description, rules,
          category, category_confidence, tags_json, outcomes_json, close_time, start_time, yes_price,
          volume_24h, total_volume, liquidity, volume_percentile, selection_score, eligible,
          rejection_reasons_json, source_url, raw_json, first_seen_at, last_seen_at
          , event_title, event_neg_risk, event_neg_risk_augmented
        ) VALUES ${values}
        ON CONFLICT(market_id) DO UPDATE SET
          source_platform=excluded.source_platform, source_event_id=excluded.source_event_id,
          diversity_group_id=excluded.diversity_group_id,
          event_slug=excluded.event_slug, market_slug=excluded.market_slug,
          series_id=excluded.series_id, title=excluded.title, description=excluded.description, rules=excluded.rules,
          category=excluded.category, category_confidence=excluded.category_confidence, tags_json=excluded.tags_json,
          outcomes_json=excluded.outcomes_json, close_time=excluded.close_time, start_time=excluded.start_time,
          yes_price=excluded.yes_price, volume_24h=excluded.volume_24h, total_volume=excluded.total_volume,
          liquidity=excluded.liquidity, volume_percentile=excluded.volume_percentile,
          selection_score=excluded.selection_score, eligible=excluded.eligible,
          rejection_reasons_json=excluded.rejection_reasons_json, source_url=excluded.source_url,
          raw_json=excluded.raw_json, last_seen_at=excluded.last_seen_at,
          event_title=excluded.event_title, event_neg_risk=excluded.event_neg_risk,
          event_neg_risk_augmented=excluded.event_neg_risk_augmented
      `).bind(...rows.flatMap((candidate) => [
        candidate.marketId, candidate.sourcePlatform, candidate.sourceEventId, candidate.diversityGroupId,
        candidate.eventSlug, candidate.marketSlug,
        candidate.seriesId, candidate.title, candidate.description, candidate.rules, candidate.category,
        candidate.categoryConfidence, JSON.stringify(candidate.tags), JSON.stringify(candidate.outcomes),
        candidate.closeTime, candidate.startTime, candidate.yesPrice, candidate.volume24h,
        candidate.totalVolume, candidate.liquidity, candidate.volume24Percentile || 0,
        candidate.selectionScore, candidate.eligible ? 1 : 0, JSON.stringify(candidate.reasons),
        candidate.sourceUrl, JSON.stringify(candidate.raw), startedAt, startedAt,
        candidate.eventTitle, candidate.eventNegRisk ? 1 : 0, candidate.eventNegRiskAugmented ? 1 : 0,
        ])));
      }
      const eligible = batch.filter((candidate) => candidate.eligible);
      for (let index = 0; index < eligible.length; index += 16) {
        const rows = eligible.slice(index, index + 16);
        const values = rows.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
        statements.push(db.prepare(`
          INSERT INTO market_snapshots (market_id, captured_at, yes_price, volume_24h, total_volume, liquidity)
          VALUES ${values}
        `).bind(...rows.flatMap((candidate) => [
          candidate.marketId, startedAt, candidate.yesPrice, candidate.volume24h, candidate.totalVolume, candidate.liquidity,
        ])));
      }
      await runBatches(db, statements);
      persistedStatements += statements.length;
      await checkpoint("persisting", { total: persisted.length, completed: Math.min(offset + 40, persisted.length), statements: persistedStatements });
    }

    const eligibleCount = ranked.filter((candidate) => candidate.eligible).length;
    const fetchedEvents = successes.reduce((sum, result) => sum + result.eventCount, 0);
    const sourceStats = Object.fromEntries(["polymarket", "kalshi"].map((source) => {
      const success = successes.find((result) => result.source === source);
      const failureIndex = source === "polymarket" ? 0 : 1;
      const failure = sourceResults[failureIndex]?.status === "rejected"
        ? sourceResults[failureIndex].reason
        : null;
      const sourceCandidates = ranked.filter((candidate) => candidate.sourcePlatform === source);
      const categoryCoverage = Object.fromEntries(CANONICAL_CATEGORIES.map((category) => {
        const eligible = sourceCandidates.filter((candidate) => candidate.category === category && candidate.eligible && !blockedGroups.has(candidate.diversityGroupId));
        return [category, {
          eligible: eligible.length,
          eventGroups: new Set(eligible.map((candidate) => candidate.diversityGroupId)).size,
        }];
      }));
      const underTargetCategories = CANONICAL_CATEGORIES.filter((category) =>
        categoryCoverage[category].eventGroups < CURATION_CONFIG.sourceTargetPerCategory);
      const availableGroups = new Set(sourceCandidates.filter((candidate) => candidate.eligible
        && !blockedGroups.has(candidate.diversityGroupId)).map((candidate) => candidate.diversityGroupId)).size;
      // Two per source/category is a preference. The hard requirements apply
      // jointly: ten per source and four per category across both sources.
      const degraded = !!success && (availableGroups < CURATION_CONFIG.sourceQuotas[source as "polymarket" | "kalshi"]
        || success.diagnostics.errors.length > 0
        || success.diagnostics.limitsReached.some((limit) =>
          limit.startsWith("source_") || limit === "incomplete_hydration"));
      return [source, success ? {
        status: degraded ? "degraded" : "completed",
        events: success.eventCount,
        markets: sourceCandidates.length,
        eligible: sourceCandidates.filter((candidate) => candidate.eligible).length,
        pages: success.pages,
        categoryCoverage,
        underTargetCategories,
        availableGroups,
        diagnostics: success.diagnostics,
      } : {
        status: "failed",
        error: failure instanceof Error ? failure.message : String(failure || "Unknown source failure"),
      }];
    }));
    const availableCategoryGroups = Object.fromEntries(CANONICAL_CATEGORIES.map((category) => [category,
      new Set(ranked.filter((candidate) => candidate.eligible && candidate.category === category
        && !blockedGroups.has(candidate.diversityGroupId)).map((candidate) => candidate.diversityGroupId)).size,
    ]));
    await db.prepare(`
      UPDATE curation_sync_runs SET status='completed', fetched_events=?, fetched_markets=?,
        eligible_markets=?, detail_json=?, completed_at=? WHERE id=?
    `).bind(
      fetchedEvents,
      ranked.length,
      eligibleCount,
      JSON.stringify({
        configVersion: CURATION_CONFIG.configVersion,
        persistedMarkets: persisted.length,
        persistedStatements,
        categoryStats,
        sourceStats,
        availableCategoryGroups,
        rapidResolution: {
          horizonHours: RAPID_RESOLUTION_HOURS,
          minimumLeadMinutes: RAPID_MINIMUM_LEAD_MINUTES,
          windowCandidates: rapidWindow.length,
          eligibleCandidates: rapidEligible.length,
          rejectionReasonCounts: rapidReasonCounts,
        },
        degraded: Object.values(sourceStats).some((source) => source.status !== "completed")
          || Object.values(availableCategoryGroups).some((count) => count < CURATION_CONFIG.targetPerCategory),
      }),
      new Date().toISOString(),
      runId,
    ).run();
    return { events: fetchedEvents, markets: ranked.length, eligible: eligibleCount, sourceStats };
  } catch (error) {
    if (runId) {
      await db.prepare(`
        UPDATE curation_sync_runs SET status='failed', detail_json=json_set(
          CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END, '$.error', ?
        ), completed_at=? WHERE id=?
      `).bind(error instanceof Error ? error.message : String(error), new Date().toISOString(), runId).run();
    }
    throw error;
  }
}

// Backwards-compatible export for existing internal callers. The operation now
// synchronizes both prediction-market providers.
export const syncPolymarketCandidates = syncLiveMarketCandidates;

export async function selectDailyBalancedSlate(db: D1Database = getD1(), now = new Date()) {
  await ensureCurationReady(db);
  const runId = dailySelectionRunId(now);
  const existing = await db.prepare("SELECT * FROM selection_runs WHERE id=?").bind(runId).first<Record<string, unknown>>();
  if (existing?.status === "completed") return {
    runId,
    selected: Number(existing.selected_count),
    sourceCounts: safeJson(existing.source_counts_json, {}),
    reused: true,
  };

  const claim = await db.prepare(DAILY_SELECTION_CLAIM_SQL).bind(
    runId, CURATION_CONFIG.configVersion, CURATION_CONFIG.taxonomyVersion, now.toISOString(),
  ).first<{ id: string }>();
  if (!claim) return { runId, selected: 0, busy: true, reused: true };

  // Record the attempt before any query or constraint search, so an interrupted
  // invocation is visible and can be retried by the next hourly sync.
  try {
  const [rows, recent, recentTitles] = await Promise.all([
    db.prepare(DAILY_CANDIDATES_SQL).bind(
      now.toISOString(), new Date(now.getTime() + CURATION_CONFIG.minimumCloseHours * 3_600_000).toISOString(),
    ).all<Record<string, unknown>>(),
    db.prepare(`
      SELECT si.category, COUNT(*) AS count FROM selection_items si
      JOIN selection_runs sr ON sr.id=si.run_id AND sr.status='completed'
      WHERE datetime(si.selected_at) >= datetime(?, '-7 days') GROUP BY si.category
    `).bind(now.toISOString()).all<{ category: string; count: number }>(),
    db.prepare(`
      SELECT e.title FROM selection_items si
      JOIN selection_runs sr ON sr.id=si.run_id AND sr.status='completed'
      JOIN events e ON e.id=si.event_id
      WHERE datetime(si.selected_at) >= datetime(?, '-7 days')
    `).bind(now.toISOString()).all<{ title: string }>(),
  ]);
  const recentCounts = Object.fromEntries(recent.results.map((row) => [row.category, Number(row.count)]));
  const marketCandidates = rows.results.map(rowToCandidate);
  const candidates = buildEventCandidates(marketCandidates);
  const selected = selectDiverseSourceBalancedCandidates(candidates, {
    sourceQuotas: CURATION_CONFIG.sourceQuotas,
    sourceTargetPerCategory: CURATION_CONFIG.sourceTargetPerCategory,
    recentCategoryCounts: recentCounts,
    recentTitles: recentTitles.results.map((row) => row.title),
  }) as EventCandidate[];
  const validation = validateDailySlate(selected);
  const { categoryCounts, sourceCounts } = validation;
  const completedAt = new Date().toISOString();
  const quotaMet = validation.valid;

  await db.prepare(`
    INSERT INTO selection_runs (
      id, config_version, taxonomy_version, status, candidate_count, eligible_count,
      selected_count, category_counts_json, source_counts_json, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, candidate_count=excluded.candidate_count,
      eligible_count=excluded.eligible_count, selected_count=excluded.selected_count,
      category_counts_json=excluded.category_counts_json, source_counts_json=excluded.source_counts_json,
      completed_at=excluded.completed_at
  `).bind(
    runId, CURATION_CONFIG.configVersion, CURATION_CONFIG.taxonomyVersion,
    quotaMet ? "running" : "incomplete", candidates.length,
    candidates.filter((candidate) => !candidate.alreadySelected).length, quotaMet ? selected.length : 0,
    JSON.stringify(categoryCounts), JSON.stringify(sourceCounts), now.toISOString(), completedAt,
  ).run();

  if (!quotaMet) {
    await db.prepare(`
      INSERT INTO audit_log (action, entity_type, entity_id, detail_json, actor, created_at)
      VALUES ('curation.selection_incomplete', 'selection_run', ?, ?, 'market-curation-cron', ?)
    `).bind(runId, JSON.stringify({
      sourceCounts,
      categoryCounts,
      requirements: {
        dailyTotal: CURATION_CONFIG.dailyTotal,
        sourceQuotas: CURATION_CONFIG.sourceQuotas,
        targetPerCategory: CURATION_CONFIG.targetPerCategory,
        uniqueDiversityGroups: true,
        uniqueTitles: true,
      },
      validation,
    }), completedAt).run();
    return { runId, selected: 0, sourceCounts, categoryCounts, quotaMet: false, reused: false };
  }

  const statements = selected.flatMap((candidate) => {
    const sourceName = candidate.sourcePlatform === "kalshi" ? "Kalshi" : "Polymarket";
    const eventId = `live-event-${candidate.sourcePlatform}-${candidate.sourceEventId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const eventUrl = candidate.sourceUrl;
    const sourceMetadata = [
      `Source: ${sourceName}`,
      eventUrl ? `Event URL: ${eventUrl}` : "",
      `Selection run: ${runId}`,
      `Outcomes: ${candidate.eventOutcomes.length}`,
    ].filter(Boolean).join("\n");
    const description = [
      candidate.description,
      sourceMetadata,
    ].filter(Boolean).join("\n\n");
    return [
      db.prepare(`
        INSERT OR IGNORE INTO events (
          id, title, description, category, season, close_time, status, event_type,
          source_event_id, outcomes_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'Live Benchmark', ?, 'open', ?, ?, ?, ?, ?)
      `).bind(
        eventId, candidate.eventTitle || candidate.title, description, candidate.category,
        candidate.closeTime, candidate.eventType, candidate.sourceEventId,
        JSON.stringify(candidate.eventOutcomes.map((outcome) => outcome.key)),
        completedAt, completedAt,
      ),
      db.prepare(`
        INSERT INTO selection_items (
          run_id, market_id, event_id, source_platform, category, rank, selection_score, price_at_selection,
          volume_24h, total_volume, liquidity, selected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        runId, candidate.marketId, eventId, candidate.sourcePlatform, candidate.category, candidate.categoryRank || 0,
        candidate.selectionScore, candidate.yesPrice, candidate.volume24h,
        candidate.totalVolume, candidate.liquidity, completedAt,
      ),
      db.prepare(`
        INSERT INTO audit_log (action, entity_type, entity_id, detail_json, actor, created_at)
        VALUES ('curation.event_selected', 'event', ?, ?, 'market-curation-cron', ?)
      `).bind(eventId, JSON.stringify({
        runId,
        sourceEventId: candidate.sourceEventId,
        representativeMarketId: candidate.marketId,
        sourcePlatform: candidate.sourcePlatform,
        outcomeCount: candidate.eventOutcomes.length,
        category: candidate.category,
      }), completedAt),
      ...candidate.eventOutcomes.map((outcome, index) => db.prepare(`
        INSERT OR IGNORE INTO event_outcomes (
          event_id, outcome_key, label, market_id, source_url, price_at_selection,
          volume_24h, total_volume, liquidity, display_order, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        eventId, outcome.key, outcome.label, outcome.marketId, outcome.sourceUrl,
        outcome.price, outcome.volume24h, outcome.totalVolume, outcome.liquidity,
        index, completedAt,
      )),
    ];
  });
  // D1 batches are transactional: publish the complete slate and its status
  // together, never a partial slate that consumes tomorrow's diversity slots.
  await db.batch([
    ...statements,
    db.prepare("UPDATE selection_runs SET status='completed', completed_at=? WHERE id=?")
      .bind(new Date().toISOString(), runId),
  ]);
  return { runId, selected: selected.length, sourceCounts, categoryCounts, quotaMet: true, reused: false };
  } catch (error) {
    const failedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    await db.batch([
      db.prepare("UPDATE selection_runs SET status='failed', completed_at=? WHERE id=? AND status!='completed'")
        .bind(failedAt, runId),
      db.prepare(`INSERT INTO audit_log (action, entity_type, entity_id, detail_json, actor, created_at)
        VALUES ('curation.selection_failed', 'selection_run', ?, ?, 'market-curation-cron', ?)`)
        .bind(runId, JSON.stringify({ error: message.slice(0, 1500) }), failedAt),
    ]);
    throw error;
  }
}

export async function selectRapidResolutionSlate(db: D1Database = getD1(), now = new Date()) {
  await ensureCurationReady(db);
  const hour = now.toISOString().slice(0, 13).replace("T", "-");
  const runId = `rapid10-${hour}00-v1`;
  const existing = await db.prepare("SELECT * FROM selection_runs WHERE id=?").bind(runId)
    .first<Record<string, unknown>>();
  if (existing?.status === "completed") {
    const existingItems = await db.prepare(
      "SELECT event_id FROM selection_items WHERE run_id=? ORDER BY rank, event_id",
    ).bind(runId).all<{ event_id: string }>();
    return {
      runId,
      selected: Number(existing.selected_count),
      eventIds: existingItems.results.map((row) => row.event_id),
      sourceCounts: safeJson(existing.source_counts_json, {}),
      reused: true,
    };
  }

  const horizon = new Date(now.getTime() + RAPID_RESOLUTION_HOURS * 3_600_000).toISOString();
  const earliest = new Date(now.getTime() + RAPID_MINIMUM_LEAD_MINUTES * 60_000).toISOString();
  const [rows, selectedGroups] = await Promise.all([
    db.prepare(`
    SELECT c.*
    FROM polymarket_candidates c
    WHERE c.last_seen_at=(
      SELECT started_at FROM curation_sync_runs WHERE status='completed' ORDER BY id DESC LIMIT 1
    )
      AND datetime(c.close_time) >= datetime(?)
      AND datetime(c.close_time) <= datetime(?)
    ORDER BY c.selection_score DESC, c.volume_24h DESC, c.close_time
    LIMIT 200
  `).bind(earliest, horizon).all<Record<string, unknown>>(),
    db.prepare(`
      SELECT DISTINCT pc.diversity_group_id
      FROM selection_items si
      JOIN polymarket_candidates pc ON pc.market_id=si.market_id
      WHERE pc.diversity_group_id!=''
    `).all<{ diversity_group_id: string }>(),
  ]);
  const selectedGroupIds = new Set(selectedGroups.results.map((row) => row.diversity_group_id));
  const candidates = rows.results.map((row) => rowToCandidate({
    ...row,
    already_selected: selectedGroupIds.has(String(row.diversity_group_id)) ? 1 : 0,
  }));
  const eligiblePool = selectRapidResolutionCandidates(candidates, {
    now,
    horizonHours: RAPID_RESOLUTION_HOURS,
    minimumLeadMinutes: RAPID_MINIMUM_LEAD_MINUTES,
    allowedReasons: RAPID_ALLOWED_REASONS,
    minimumPolymarketLiquidity: RAPID_MINIMUM_POLYMARKET_LIQUIDITY,
    minimumYesPrice: RAPID_MINIMUM_YES_PRICE,
    maximumYesPrice: RAPID_MAXIMUM_YES_PRICE,
    maxPerDiversityGroup: RAPID_MAX_PER_DIVERSITY_GROUP,
    limit: Math.max(1, candidates.length),
  }) as Candidate[];
  const selected = eligiblePool.slice(0, RAPID_EVENT_LIMIT);
  const categoryCounts = Object.fromEntries(CANONICAL_CATEGORIES.map((category) => [
    category,
    selected.filter((candidate) => candidate.category === category).length,
  ]));
  const sourceCounts = Object.fromEntries(["polymarket", "kalshi"].map((source) => [
    source,
    selected.filter((candidate) => candidate.sourcePlatform === source).length,
  ]));
  const completedAt = new Date().toISOString();

  await db.prepare(`
    INSERT INTO selection_runs (
      id, config_version, taxonomy_version, status, candidate_count, eligible_count,
      selected_count, category_counts_json, source_counts_json, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, candidate_count=excluded.candidate_count,
      eligible_count=excluded.eligible_count, selected_count=excluded.selected_count,
      category_counts_json=excluded.category_counts_json, source_counts_json=excluded.source_counts_json,
      completed_at=excluded.completed_at
  `).bind(
    runId,
    `${CURATION_CONFIG.configVersion}-rapid10-3h-v1`,
    CURATION_CONFIG.taxonomyVersion,
    selected.length ? "running" : "incomplete",
    candidates.length,
    eligiblePool.length,
    selected.length,
    JSON.stringify(categoryCounts),
    JSON.stringify(sourceCounts),
    now.toISOString(),
    completedAt,
  ).run();

  if (!selected.length) {
    await db.prepare(`
      INSERT INTO audit_log (action, entity_type, entity_id, detail_json, actor, created_at)
      VALUES ('curation.rapid_selection_incomplete', 'selection_run', ?, ?, 'rapid-resolution-cron', ?)
    `).bind(runId, JSON.stringify({
      horizonHours: RAPID_RESOLUTION_HOURS,
      minimumLeadMinutes: RAPID_MINIMUM_LEAD_MINUTES,
      candidateCount: candidates.length,
      rule: "rapid experiment gates: open binary market, minimally non-extreme price, clear rules, and up to four questions per source event",
    }), completedAt).run();
    return { runId, selected: 0, eventIds: [], sourceCounts, categoryCounts, reused: false };
  }

  const eventIds: string[] = [];
  const statements = selected.flatMap((candidate, index) => {
    const sourceName = candidate.sourcePlatform === "kalshi" ? "Kalshi" : "Polymarket";
    const safeMarketId = candidate.marketId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const eventId = `rapid-event-${candidate.sourcePlatform}-${safeMarketId}`;
    eventIds.push(eventId);
    const description = [
      candidate.description,
      candidate.rules ? `Resolution rules: ${candidate.rules}` : "",
      `Source: ${sourceName}`,
      candidate.sourceUrl ? `Event URL: ${candidate.sourceUrl}` : "",
      `Selection run: ${runId}`,
      `Rapid resolution window: ${RAPID_RESOLUTION_HOURS} hours`,
    ].filter(Boolean).join("\n\n");
    return [
      db.prepare(`
        INSERT OR IGNORE INTO events (
          id, title, description, category, season, close_time, status, event_type,
          source_event_id, outcomes_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'Live Benchmark', ?, 'open', 'binary', ?, '["yes","no"]', ?, ?)
      `).bind(
        eventId,
        candidate.title,
        description,
        candidate.category,
        candidate.closeTime,
        candidate.sourceEventId,
        completedAt,
        completedAt,
      ),
      db.prepare(`
        INSERT OR IGNORE INTO selection_items (
          run_id, market_id, event_id, source_platform, category, rank, selection_score, price_at_selection,
          volume_24h, total_volume, liquidity, selected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        runId,
        candidate.marketId,
        eventId,
        candidate.sourcePlatform,
        candidate.category,
        index + 1,
        candidate.selectionScore,
        candidate.yesPrice,
        candidate.volume24h,
        candidate.totalVolume,
        candidate.liquidity,
        completedAt,
      ),
      db.prepare(`
        INSERT INTO audit_log (action, entity_type, entity_id, detail_json, actor, created_at)
        VALUES ('curation.rapid_event_selected', 'event', ?, ?, 'rapid-resolution-cron', ?)
      `).bind(eventId, JSON.stringify({
        runId,
        sourceEventId: candidate.sourceEventId,
        marketId: candidate.marketId,
        sourcePlatform: candidate.sourcePlatform,
        closeTime: candidate.closeTime,
        horizonHours: RAPID_RESOLUTION_HOURS,
        waivedReason: "outside_close_window",
        waivedReasons: candidate.reasons,
        minimumPolymarketLiquidity: RAPID_MINIMUM_POLYMARKET_LIQUIDITY,
        rapidYesPriceRange: [RAPID_MINIMUM_YES_PRICE, RAPID_MAXIMUM_YES_PRICE],
        maxPerDiversityGroup: RAPID_MAX_PER_DIVERSITY_GROUP,
      }), completedAt),
      db.prepare(`
        INSERT OR IGNORE INTO event_outcomes (
          event_id, outcome_key, label, market_id, source_url, price_at_selection,
          volume_24h, total_volume, liquidity, display_order, created_at
        ) VALUES (?, 'yes', 'Yes', ?, ?, ?, ?, ?, ?, 0, ?)
      `).bind(
        eventId, candidate.marketId, candidate.sourceUrl, candidate.yesPrice,
        candidate.volume24h, candidate.totalVolume, candidate.liquidity, completedAt,
      ),
      db.prepare(`
        INSERT OR IGNORE INTO event_outcomes (
          event_id, outcome_key, label, market_id, source_url, price_at_selection,
          volume_24h, total_volume, liquidity, display_order, created_at
        ) VALUES (?, 'no', 'No', ?, ?, ?, ?, ?, ?, 1, ?)
      `).bind(
        eventId, candidate.marketId, candidate.sourceUrl, 1 - candidate.yesPrice,
        candidate.volume24h, candidate.totalVolume, candidate.liquidity, completedAt,
      ),
    ];
  });
  await runBatches(db, statements);
  await db.prepare("UPDATE selection_runs SET status='completed', completed_at=? WHERE id=?")
    .bind(completedAt, runId).run();
  return { runId, selected: selected.length, eventIds, sourceCounts, categoryCounts, reused: false };
}

export async function resolveSelectedMarkets(db: D1Database = getD1()) {
  await ensureCurationReady(db);
  const rows = await db.prepare(`
    SELECT si.market_id, si.source_platform, si.event_id, e.status, e.close_time,
      e.event_type, e.source_event_id
    FROM selection_items si
    JOIN events e ON e.id=si.event_id
    WHERE e.status IN ('open','locked')
    ORDER BY CASE e.status WHEN 'locked' THEN 0 ELSE 1 END, e.close_time
  `).all<{
    market_id: string;
    source_platform: string;
    event_id: string;
    status: string;
    close_time: string | null;
    event_type: string;
    source_event_id: string | null;
  }>();
  const checkRows = selectResolutionCheckRows(rows.results, new Date(), MAX_RESOLUTION_CHECKS_PER_RUN);
  let locked = 0;
  let resolved = 0;
  let failed = 0;
  for (const row of checkRows) {
    try {
      if (row.status === "open" && deadlinePassed(row.close_time)) {
        locked += Number(await lockEvent(db, {
          eventId: row.event_id,
          reason: "scheduled_close",
          actor: "market-curation-cron",
          detail: { scheduledCloseTime: row.close_time },
        }));
      }

      if (row.source_platform === "kalshi") {
        const ticker = row.market_id.replace(/^kalshi:/, "");
        const response = await fetch(`${KALSHI_API}/markets/${encodeURIComponent(ticker)}`, {
          headers: { accept: "application/json", "user-agent": "Aggrena/1.0" },
          signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) continue;
        const payload = await readJsonLimited(response, MAX_EXTERNAL_PAGE_BYTES) as Record<string, unknown>;
        const market = (payload.market && typeof payload.market === "object" ? payload.market : payload) as Record<string, unknown>;
        const state = inspectKalshiMarket(market);
        if (state.resolvedOutcome) {
          const outcome = state.resolvedOutcome === "yes" ? 1 : 0;
          resolved += Number(await resolveSelectedEvent(db, {
            eventId: row.event_id,
            resolution: outcome,
            resolvedOutcome: state.resolvedOutcome,
            note: `Automatically resolved from Kalshi market ${ticker}.`,
            detail: { sourcePlatform: "kalshi", ticker, resolution: outcome },
          }));
        } else if (state.closed) {
          locked += Number(await lockEvent(db, {
            eventId: row.event_id,
            reason: "source_closed",
            actor: "market-curation-cron",
            detail: { sourcePlatform: "kalshi", ticker },
          }));
        }
        continue;
      }

      if (row.event_type === "categorical" && row.source_event_id) {
        const response = await fetch(`${GAMMA_API}/events/${encodeURIComponent(row.source_event_id)}`, {
          headers: { accept: "application/json", "user-agent": "Aggrena/1.0" },
          signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) continue;
        const sourceEvent = await readJsonLimited(response, MAX_EXTERNAL_PAGE_BYTES) as Record<string, unknown>;
        const outcomeRows = await db.prepare(
          "SELECT outcome_key, market_id FROM event_outcomes WHERE event_id=? ORDER BY display_order",
        ).bind(row.event_id).all<{ outcome_key: string; market_id: string }>();
        const state = inspectPolymarketCategoricalEvent(sourceEvent, outcomeRows.results);
        if (state.resolvedOutcome) {
          resolved += Number(await resolveSelectedEvent(db, {
            eventId: row.event_id,
            resolution: null,
            resolvedOutcome: state.resolvedOutcome,
            note: `Automatically resolved from Polymarket event ${row.source_event_id}.`,
            detail: { sourceEventId: row.source_event_id, resolvedOutcome: state.resolvedOutcome },
          }));
        } else if (state.closed) {
          locked += Number(await lockEvent(db, {
            eventId: row.event_id,
            reason: "source_closed",
            actor: "market-curation-cron",
            detail: { sourcePlatform: "polymarket", sourceEventId: row.source_event_id },
          }));
        }
        continue;
      }

      const response = await fetch(`${GAMMA_API}/markets/${encodeURIComponent(row.market_id)}`, {
        headers: { accept: "application/json", "user-agent": "Aggrena/1.0" },
        signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const market = await readJsonLimited(response, MAX_EXTERNAL_PAGE_BYTES) as Record<string, unknown>;
      const state = inspectPolymarketBinaryMarket(market);
      if (state.resolvedOutcome) {
        const outcome = state.resolvedOutcome === "yes" ? 1 : 0;
        resolved += Number(await resolveSelectedEvent(db, {
          eventId: row.event_id,
          resolution: outcome,
          resolvedOutcome: state.resolvedOutcome,
          note: `Automatically resolved from Polymarket market ${row.market_id}.`,
          detail: { marketId: row.market_id, resolution: outcome },
        }));
      } else if (state.closed) {
        locked += Number(await lockEvent(db, {
          eventId: row.event_id,
          reason: "source_closed",
          actor: "market-curation-cron",
          detail: { sourcePlatform: "polymarket", marketId: row.market_id },
        }));
      }
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({
        message: "Market resolution check failed",
        eventId: row.event_id,
        sourcePlatform: row.source_platform,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return { checked: checkRows.length, available: rows.results.length, locked, resolved, failed };
}

async function resolveSelectedEvent(
  db: D1Database,
  options: {
    eventId: string;
    resolution: number | null;
    resolvedOutcome: string;
    note: string;
    detail: Record<string, unknown>;
  },
) {
  const resolvedAt = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE events SET status='resolved', resolution=?, resolved_outcome=?, resolution_note=?,
      locked_at=COALESCE(locked_at, ?), lock_reason=COALESCE(lock_reason, 'source_resolved'),
      resolved_at=?, updated_at=? WHERE id=? AND status IN ('open','locked')
  `).bind(
    options.resolution,
    options.resolvedOutcome,
    options.note,
    resolvedAt,
    resolvedAt,
    resolvedAt,
    options.eventId,
  ).run();
  if (!Number(result.meta.changes || 0)) return false;
  await db.prepare(`
    INSERT INTO audit_log (action, entity_type, entity_id, detail_json, actor, created_at)
    VALUES ('curation.event_resolved', 'event', ?, ?, 'market-curation-cron', ?)
  `).bind(options.eventId, JSON.stringify(options.detail), resolvedAt).run();
  return true;
}

function deadlinePassed(closeTime: string | null) {
  if (!closeTime) return false;
  const timestamp = Date.parse(closeTime);
  return !Number.isFinite(timestamp) || timestamp <= Date.now();
}

export const resolveSelectedPolymarketMarkets = resolveSelectedMarkets;

export async function runMarketScheduled(
  env: { DB: D1Database },
  controller: { cron: string },
) {
  const daily = controller.cron === "10 0 * * *";
  if (daily) {
    return { sync: null, resolution: null, selection: await selectDailyBalancedSlate(env.DB) };
  }
  await ensureCurationReady(env.DB);
  const [sync, resolution] = await Promise.allSettled([
    syncLiveMarketCandidates(env.DB),
    resolveSelectedMarkets(env.DB),
  ]);
  if (sync.status === "rejected") console.error("Market sync failed", sync.reason);
  if (resolution.status === "rejected") console.error("Market resolution failed", resolution.reason);
  const selection = sync.status === "fulfilled"
    ? await retryIncompleteDailySelection(env.DB)
    : null;
  return {
    sync: settledValue(sync),
    resolution: settledValue(resolution),
    selection,
  };
}

export const runPolymarketScheduled = runMarketScheduled;

export async function getCurationSnapshot(db: D1Database = getD1()) {
  await ensureCurationReady(db);
  const [latestSync, latestAttempt, syncHealth, latestRun, categoryRows, selectedRows] = await Promise.all([
    db.prepare(`
      SELECT * FROM curation_sync_runs WHERE status='completed' ORDER BY id DESC LIMIT 1
    `).first<Record<string, unknown>>(),
    db.prepare("SELECT * FROM curation_sync_runs ORDER BY id DESC LIMIT 1").first<Record<string, unknown>>(),
    db.prepare(`
      SELECT
        SUM(CASE WHEN status='running' AND datetime(started_at) < datetime('now', '-20 minutes') THEN 1 ELSE 0 END) AS stale_runs,
        SUM(CASE WHEN status='failed' AND datetime(started_at) >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS failed_24h
      FROM curation_sync_runs
    `).first<Record<string, unknown>>(),
    db.prepare("SELECT * FROM selection_runs ORDER BY started_at DESC LIMIT 1").first<Record<string, unknown>>(),
    db.prepare(`
      SELECT category, COUNT(*) AS candidate_count,
        SUM(CASE WHEN eligible=1 THEN 1 ELSE 0 END) AS eligible_count
      FROM polymarket_candidates GROUP BY category
    `).all<Record<string, unknown>>(),
    db.prepare(`
      SELECT si.*, c.title, c.close_time, c.yes_price, c.source_url, c.source_platform
      FROM selection_items si JOIN polymarket_candidates c ON c.market_id=si.market_id
      WHERE si.run_id=(SELECT id FROM selection_runs ORDER BY started_at DESC LIMIT 1)
      ORDER BY si.category, si.rank
    `).all<Record<string, unknown>>(),
  ]);
  const rolling = await db.prepare(`
    SELECT category, COUNT(*) AS count FROM selection_items
    WHERE datetime(selected_at) >= datetime('now', '-7 days') GROUP BY category
  `).all<Record<string, unknown>>();
  const rollingMap = Object.fromEntries(rolling.results.map((row) => [String(row.category), Number(row.count)]));
  const categoryMap = new Map(categoryRows.results.map((row) => [String(row.category), row]));
  const latestDetail = safeJson(latestSync?.detail_json, {}) as Record<string, unknown>;
  const categoryStats = (latestDetail.categoryStats || {}) as Record<string, { candidates?: number; eligible?: number }>;
  const staleRuns = Number(syncHealth?.stale_runs || 0);
  const failed24h = Number(syncHealth?.failed_24h || 0);
  const lastSuccessAt = latestSync?.completed_at ? String(latestSync.completed_at) : null;
  const successAgeMs = lastSuccessAt ? Date.now() - new Date(lastSuccessAt).getTime() : Number.POSITIVE_INFINITY;
  const latestAttemptFailedAfterSuccess = latestAttempt?.status === "failed"
    && (!lastSuccessAt || new Date(String(latestAttempt.started_at)).getTime() > new Date(lastSuccessAt).getTime());

  return {
    config: CURATION_CONFIG,
    latestSync: latestSync ? {
      status: latestSync.status,
      fetchedEvents: Number(latestSync.fetched_events),
      fetchedMarkets: Number(latestSync.fetched_markets),
      eligibleMarkets: Number(latestSync.eligible_markets),
      startedAt: latestSync.started_at,
      completedAt: latestSync.completed_at,
      detail: safeJson(latestSync.detail_json, {}),
    } : null,
    automation: {
      status: staleRuns > 0 || successAgeMs > 3 * 3_600_000 || latestDetail.degraded === true
        ? "degraded"
        : latestAttemptFailedAfterSuccess ? "recovering" : "healthy",
      schedules: {
        intake: "Hourly at minute 00 UTC",
        selection: "Daily at 00:10 UTC",
        forecast: "Hourly at minute 20 UTC until all models cover the daily slate",
      },
      latestAttemptStatus: latestAttempt?.status ? String(latestAttempt.status) : null,
      latestAttemptAt: latestAttempt?.started_at ? String(latestAttempt.started_at) : null,
      lastSuccessfulSyncAt: lastSuccessAt,
      staleRuns,
      failed24h,
    },
    latestSelection: latestRun ? {
      id: latestRun.id,
      status: latestRun.status,
      candidateCount: Number(latestRun.candidate_count),
      eligibleCount: Number(latestRun.eligible_count),
      selectedCount: Number(latestRun.selected_count),
      categoryCounts: safeJson(latestRun.category_counts_json, {}),
      sourceCounts: safeJson(latestRun.source_counts_json, {}),
      completedAt: latestRun.completed_at,
    } : null,
    categories: CANONICAL_CATEGORIES.map((category) => {
      const row = categoryMap.get(category);
      const stats = categoryStats[category];
      return {
        category,
        candidates: Number(stats?.candidates ?? row?.candidate_count ?? 0),
        eligible: Number(stats?.eligible ?? row?.eligible_count ?? 0),
        selectedThisRun: Number((safeJson(latestRun?.category_counts_json, {}) as Record<string, number>)[category] || 0),
        selectedLast7d: rollingMap[category] || 0,
        target: CURATION_CONFIG.targetPerCategory,
      };
    }),
    selectedMarkets: selectedRows.results.map((row) => ({
      marketId: row.market_id,
      eventId: row.event_id,
      sourcePlatform: row.source_platform,
      title: row.title,
      category: row.category,
      rank: Number(row.rank),
      score: Number(row.selection_score),
      yesPrice: Number(row.price_at_selection),
      currentYesPrice: Number(row.yes_price),
      volume24h: Number(row.volume_24h),
      totalVolume: Number(row.total_volume),
      liquidity: Number(row.liquidity),
      closeTime: row.close_time,
      selectedAt: row.selected_at,
      sourceUrl: row.source_url,
    })),
  };
}

function rowToCandidate(row: Record<string, unknown>): Candidate {
  return {
    sourcePlatform: row.source_platform === "kalshi" ? "kalshi" : "polymarket",
    marketId: String(row.market_id), sourceEventId: String(row.source_event_id),
    diversityGroupId: String(row.diversity_group_id || row.source_event_id),
    eventTitle: String(row.event_title || row.title),
    eventNegRisk: Number(row.event_neg_risk) === 1,
    eventNegRiskAugmented: Number(row.event_neg_risk_augmented) === 1,
    eventSlug: String(row.event_slug), marketSlug: String(row.market_slug), seriesId: String(row.series_id),
    title: String(row.title), description: String(row.description), rules: String(row.rules),
    category: String(row.category), categoryConfidence: Number(row.category_confidence),
    tags: parseJsonList(row.tags_json), outcomes: parseJsonList(row.outcomes_json),
    closeTime: row.close_time ? String(row.close_time) : null,
    startTime: row.start_time ? String(row.start_time) : null,
    yesPrice: Number(row.yes_price), volume24h: Number(row.volume_24h),
    totalVolume: Number(row.total_volume), liquidity: Number(row.liquidity),
    active: true, closed: false, acceptingOrders: true, sourceUrl: String(row.source_url),
    fetchedAt: String(row.last_seen_at), raw: safeJson(row.raw_json, {}),
    eligible: Number(row.eligible) === 1, reasons: parseJsonList(row.rejection_reasons_json).map(String),
    selectionScore: Number(row.selection_score), volume24Percentile: Number(row.volume_percentile),
    alreadySelected: Number(row.already_selected) === 1,
  };
}

function buildEventCandidates(candidates: Candidate[]): EventCandidate[] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.sourceEventId) ?? [];
    group.push(candidate);
    groups.set(candidate.sourceEventId, group);
  }
  const events: EventCandidate[] = [];
  for (const group of groups.values()) {
    const ranked = [...group].sort((a, b) => b.selectionScore - a.selectionScore || b.volume24h - a.volume24h);
    const representative = ranked.find((candidate) => candidate.eligible);
    if (!representative) continue;
    const namedMarkets = ranked.filter((candidate) => isActiveNamedMarket(candidate));
    const isCategorical = representative.eventNegRisk && namedMarkets.length > 1;
    if (!isCategorical && namedMarkets.length > 1) continue;
    const eventOutcomes: EventOutcome[] = isCategorical
      ? namedMarkets.map((candidate) => ({
          key: candidate.marketId,
          label: candidate.title,
          marketId: candidate.marketId,
          sourceUrl: candidate.sourceUrl,
          price: candidate.yesPrice,
          volume24h: candidate.volume24h,
          totalVolume: candidate.totalVolume,
          liquidity: candidate.liquidity,
        }))
      : [
          {
            key: "yes", label: "Yes", marketId: representative.marketId,
            sourceUrl: representative.sourceUrl, price: representative.yesPrice,
            volume24h: representative.volume24h, totalVolume: representative.totalVolume,
            liquidity: representative.liquidity,
          },
          {
            key: "no", label: "No", marketId: representative.marketId,
            sourceUrl: representative.sourceUrl, price: 1 - representative.yesPrice,
            volume24h: representative.volume24h, totalVolume: representative.totalVolume,
            liquidity: representative.liquidity,
          },
        ];
    events.push({
      ...representative,
      title: representative.eventTitle || representative.title,
      eventType: isCategorical ? "categorical" : "binary",
      eventOutcomes,
    });
  }
  return events;
}

function isActiveNamedMarket(candidate: Candidate) {
  const rawMarket = (candidate.raw as { market?: Record<string, unknown> } | undefined)?.market;
  if (rawMarket?.active === false || rawMarket?.closed === true || rawMarket?.acceptingOrders === false) return false;
  const title = candidate.title.trim();
  if (!title) return false;
  return !/\b(?:company|person|candidate|team)\s+[a-z]\b/i.test(title);
}

type IntakeDiagnostics = {
  startedAt: string;
  elapsedMs: number;
  requests: number;
  bytes: number;
  fetchedMarkets: number;
  discoveredEvents: number;
  hydratedEvents: number;
  errors: Array<{ stage: string; error: string }>;
  limitsReached: string[];
};

type IntakeBudget = {
  deadline: number;
  maximumRequests: number;
  diagnostics: IntakeDiagnostics;
};

type EventPayloadResult = {
  events: Record<string, unknown>[];
  diagnostics: IntakeDiagnostics;
};

type SourceFetchResult = {
  source: "polymarket" | "kalshi";
  eventCount: number;
  pages: number;
  candidates: Array<ReturnType<typeof normalizePolymarketMarket> | ReturnType<typeof normalizeKalshiMarket>>;
  diagnostics: IntakeDiagnostics;
};

function intakeBudget(maximumRequests: number): IntakeBudget {
  const startedAt = new Date().toISOString();
  return {
    deadline: Date.now() + INTAKE_SOURCE_TIMEOUT_MS,
    maximumRequests,
    diagnostics: {
      startedAt, elapsedMs: 0, requests: 0, bytes: 0, fetchedMarkets: 0,
      discoveredEvents: 0, hydratedEvents: 0, errors: [], limitsReached: [],
    },
  };
}

function intakeAvailable(budget: IntakeBudget) {
  const reason = Date.now() >= budget.deadline ? "source_time_budget"
    : budget.diagnostics.requests >= budget.maximumRequests ? "source_request_budget"
      : budget.diagnostics.bytes >= INTAKE_SOURCE_MAX_BYTES ? "source_byte_budget" : null;
  if (reason && !budget.diagnostics.limitsReached.includes(reason)) budget.diagnostics.limitsReached.push(reason);
  return !reason;
}

function intakeFailure(budget: IntakeBudget, stage: string, error: unknown) {
  budget.diagnostics.errors.push({ stage, error: error instanceof Error ? error.message : String(error) });
}

async function fetchIntakeJson(url: URL, budget: IntakeBudget, maximumBytes = INTAKE_PAGE_MAX_BYTES) {
  const endpoints = url.origin === new URL(KALSHI_API).origin
    ? [url, new URL(url.pathname + url.search, KALSHI_API_FALLBACK_ORIGIN)] : [url];
  let lastError: unknown = new Error("Intake source budget exhausted");
  for (const endpoint of endpoints) {
    if (!intakeAvailable(budget)) break;
    budget.diagnostics.requests += 1;
    try {
      const response = await fetch(endpoint, {
        headers: { accept: "application/json", "user-agent": "Aggrena/1.0 (+https://www.aggrena.com)" },
        signal: AbortSignal.timeout(Math.max(1, Math.min(INTAKE_REQUEST_TIMEOUT_MS, budget.deadline - Date.now()))),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(`${endpoint.hostname}${endpoint.pathname} returned ${response.status}`);
        if (response.status !== 429 && response.status < 500) throw error;
        lastError = error;
        if (response.status === 429 && endpoints.length > 1) {
          const delay = Math.min(1_000, Math.max(0, budget.deadline - Date.now()));
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        }
        continue;
      }
      return await readJsonLimited(
        response,
        Math.min(maximumBytes, INTAKE_SOURCE_MAX_BYTES - budget.diagnostics.bytes),
        (bytes) => { budget.diagnostics.bytes += bytes; },
      ) as Record<string, unknown>;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// Each invocation owns its budget and workers; no request state survives in a
// module global. A failed item never discards earlier complete source events.
async function intakeMap<T>(items: T[], budget: IntakeBudget, consume: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(INTAKE_CONCURRENCY, items.length) }, async () => {
    while (next < items.length && intakeAvailable(budget)) {
      const item = items[next++];
      await consume(item);
    }
  }));
}

function objectRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> =>
    !!item && typeof item === "object" && !Array.isArray(item)) : [];
}

function keepFields(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

const POLYMARKET_EVENT_FIELDS = [
  "id", "slug", "title", "question", "description", "resolutionSource", "endDate", "end_date_iso",
  "startDate", "start_date_iso", "active", "closed", "negRisk", "negRiskAugmented", "enableNegRisk", "seriesId",
];
const POLYMARKET_MARKET_FIELDS = [
  "id", "conditionId", "condition_id", "eventId", "event_id", "slug", "question", "title", "description",
  "resolutionSource", "rules", "endDate", "end_date_iso", "startDate", "start_date_iso", "outcomes", "outcomePrices",
  "lastTradePrice", "bestBid", "bestAsk", "volume24hr", "volume24h", "volume_24h", "volumeNum", "volume",
  "totalVolume", "liquidityNum", "liquidity", "active", "closed", "acceptingOrders", "negRisk", "negRiskAugmented",
  "groupItemTitle", "groupItemThreshold", "umaResolutionStatus", "updatedAt", "createdAt",
];
const KALSHI_MARKET_FIELDS = [
  "ticker", "ticker_name", "event_ticker", "series_ticker", "title", "yes_sub_title", "no_sub_title", "subtitle",
  "last_price_dollars", "last_price", "yes_bid_dollars", "yes_bid", "yes_ask_dollars", "yes_ask",
  "status", "result", "market_type", "rules_primary", "rules_secondary", "expected_expiration_time",
  "expected_expiration_date", "event_occurrence_time", "event_occurrence_datetime", "occurrence_datetime",
  "close_time", "close_date", "open_time", "open_date", "volume_24h_fp", "volume_24h", "volume_fp", "volume",
  "open_interest_fp", "open_interest", "yes_bid_size_fp", "yes_bid_size", "yes_ask_size_fp", "yes_ask_size",
  "settlement_ts", "updated_time", "created_time", "can_close_early", "early_close_condition",
];

function compactTags(value: unknown) {
  return Array.isArray(value) ? value.map((tag) => typeof tag === "string" ? tag
    : tag && typeof tag === "object" ? keepFields(tag as Record<string, unknown>, ["id", "label", "name", "slug"]) : "") : value;
}

function compactPolymarketEvent(event: Record<string, unknown>): Record<string, unknown> {
  // Never slice markets. A too-large or malformed event is rejected as a unit;
  // admitting a subset would silently change the categorical outcome space.
  if (!event.id || !Array.isArray(event.markets) || !event.markets.length
    || objectRows(event.markets).length !== event.markets.length
    || objectRows(event.markets).some((market) => !market.id)) {
    throw new Error("Polymarket event missing identity or complete markets array");
  }
  return {
    ...keepFields(event, POLYMARKET_EVENT_FIELDS),
    tags: compactTags(event.tags),
    series: objectRows(event.series).map((series) => keepFields(series, ["id"])),
    markets: objectRows(event.markets).map((market) => ({
      ...keepFields(market, POLYMARKET_MARKET_FIELDS), tags: compactTags(market.tags),
    })),
  };
}

function rapidIntakeCandidate(candidate: ReturnType<typeof normalizePolymarketMarket> | ReturnType<typeof normalizeKalshiMarket>, now: Date) {
  const close = Date.parse(candidate.closeTime || "");
  const check = evaluateHardEligibility(candidate, now);
  return close >= now.getTime() + RAPID_MINIMUM_LEAD_MINUTES * 60_000
    && close <= now.getTime() + RAPID_RESOLUTION_HOURS * 3_600_000
    && check.reasons.every((reason: string) => RAPID_ALLOWED_REASONS.includes(reason))
    && candidate.yesPrice >= RAPID_MINIMUM_YES_PRICE && candidate.yesPrice <= RAPID_MAXIMUM_YES_PRICE;
}

async function fetchPolymarketCandidates(now: Date, blockedGroups = new Set<string>()): Promise<SourceFetchResult> {
  const result = await fetchPolymarketEventPayloads(now, blockedGroups);
  const candidates = result.events.flatMap((event) => objectRows(event.markets)
    .map((market) => normalizePolymarketMarket(event, market, now))).filter((candidate) => candidate.marketId);
  return { source: "polymarket", eventCount: result.events.length, pages: result.diagnostics.requests, candidates, diagnostics: result.diagnostics };
}

async function fetchPolymarketEventPayloads(now: Date, blockedGroups = new Set<string>()): Promise<EventPayloadResult> {
  const budget = intakeBudget(MAX_POLYMARKET_HYDRATED_EVENTS + MAX_POLYMARKET_DISCOVERY_PAGES + 1);
  const discovered = new Map<string, { id: string; rapid: boolean; volume24h: number }>();
  for (const rapid of [false, true]) {
    let cursor = "";
    const seen = new Set<string>();
    const maximumPages = rapid ? 1 : MAX_POLYMARKET_DISCOVERY_PAGES;
    for (let page = 0; page < maximumPages && intakeAvailable(budget); page += 1) {
      const url = new URL("/markets/keyset", GAMMA_API);
      const minimumClose = now.getTime() + (rapid ? RAPID_MINIMUM_LEAD_MINUTES * 60_000 : CURATION_CONFIG.minimumCloseHours * 3_600_000);
      const maximumClose = now.getTime() + (rapid ? RAPID_RESOLUTION_HOURS * 3_600_000 : CURATION_CONFIG.maximumCloseDays * 86_400_000);
      for (const [key, value] of Object.entries({
        active: "true", closed: "false", order: "volume24hr", ascending: "false", include_tag: "true",
        limit: String(rapid ? 50 : POLYMARKET_DISCOVERY_PAGE_SIZE),
        end_date_min: new Date(minimumClose).toISOString(), end_date_max: new Date(maximumClose).toISOString(),
      })) url.searchParams.set(key, value);
      if (!rapid) {
        url.searchParams.set("liquidity_min", String(CURATION_CONFIG.minimumLiquidity));
        url.searchParams.set("volume_min", String(CURATION_CONFIG.minimumTotalVolume));
      }
      if (cursor) url.searchParams.set("after_cursor", cursor);
      try {
        const payload = await fetchIntakeJson(url, budget);
        if (!Array.isArray(payload.markets)) throw new Error("Polymarket discovery missing markets array");
        const markets = objectRows(payload.markets);
        budget.diagnostics.fetchedMarkets += markets.length;
        for (const market of markets) {
          const event = objectRows(market.events)[0];
          if (!event?.id) continue;
          const candidate = normalizePolymarketMarket(event, market, now);
          if (blockedGroups.has(candidate.diversityGroupId)) continue;
          if (rapid ? !rapidIntakeCandidate(candidate, now) : !evaluateHardEligibility(candidate, now).eligible) continue;
          const id = String(event.id);
          const previous = discovered.get(id);
          if (!previous || candidate.volume24h > previous.volume24h) discovered.set(id, { id, rapid, volume24h: candidate.volume24h });
        }
        const next = String(payload.next_cursor || "");
        const belowVolumeFloor = !rapid && markets.length > 0
          && Number(markets[markets.length - 1].volume24hr) < CURATION_CONFIG.minimumVolume24h;
        if (!next || seen.has(next) || !markets.length || belowVolumeFloor) break;
        seen.add(next);
        cursor = next;
        if (page + 1 === maximumPages) budget.diagnostics.limitsReached.push(rapid ? "rapid_discovery_page_limit" : "regular_discovery_page_limit");
      } catch (error) {
        intakeFailure(budget, rapid ? "rapid_discovery" : "regular_discovery", error);
        break;
      }
    }
  }
  budget.diagnostics.discoveredEvents = discovered.size;
  const regular = [...discovered.values()].filter((item) => !item.rapid).sort((a, b) => b.volume24h - a.volume24h);
  const rapid = [...discovered.values()].filter((item) => item.rapid).sort((a, b) => b.volume24h - a.volume24h).slice(0, RAPID_EVENT_LIMIT);
  const queue = [...regular.slice(0, MAX_POLYMARKET_HYDRATED_EVENTS - rapid.length), ...rapid];
  if (queue.length < discovered.size) budget.diagnostics.limitsReached.push("event_hydration_limit");
  const events: Record<string, unknown>[] = [];
  await intakeMap(queue, budget, async ({ id }) => {
    try {
      const payload = await fetchIntakeJson(new URL(`/events/${encodeURIComponent(id)}`, GAMMA_API), budget, MAX_EXTERNAL_PAGE_BYTES);
      const event = compactPolymarketEvent(payload);
      if (String(event.id) !== id) throw new Error(`Polymarket hydration identity mismatch for ${id}`);
      events.push(event);
    } catch (error) { intakeFailure(budget, `hydrate:${id}`, error); }
  });
  budget.diagnostics.hydratedEvents = events.length;
  if (events.length < queue.length && !budget.diagnostics.limitsReached.includes("incomplete_hydration")) budget.diagnostics.limitsReached.push("incomplete_hydration");
  budget.diagnostics.elapsedMs = Date.now() - Date.parse(budget.diagnostics.startedAt);
  if (!events.length && budget.diagnostics.errors.length) throw new Error(JSON.stringify(budget.diagnostics));
  return { events, diagnostics: budget.diagnostics };
}

const KALSHI_DISCOVERY_CATEGORIES = [
  ["Politics", "Politics"], ["Economics", "Economics"], ["Science", "Science and Technology"],
  ["Sports", "Sports"], ["Entertainment", "Entertainment"],
] as const;

async function fetchKalshiCandidates(now: Date, blockedGroups = new Set<string>()): Promise<SourceFetchResult> {
  const result = await fetchKalshiEventPayloads(now, blockedGroups);
  const candidates = result.events.flatMap((event) => objectRows(event.markets)
    .map((market) => normalizeKalshiMarket(event, market, now))).filter((candidate) => candidate.marketId !== "kalshi:");
  return { source: "kalshi", eventCount: result.events.length, pages: result.diagnostics.requests, candidates, diagnostics: result.diagnostics };
}

async function fetchKalshiEventPayloads(now: Date, blockedGroups = new Set<string>()): Promise<EventPayloadResult> {
  const budget = intakeBudget(40);
  const pools = new Map<string, Array<{ ticker: string; volume: number }>>();
  await intakeMap([...KALSHI_DISCOVERY_CATEGORIES], budget, async ([category, sourceCategory]) => {
    try {
      const url = new URL(`${KALSHI_API}/series`);
      url.searchParams.set("category", sourceCategory);
      url.searchParams.set("include_volume", "true");
      const payload = await fetchIntakeJson(url, budget, MAX_EXTERNAL_PAGE_BYTES);
      if (!Array.isArray(payload.series)) throw new Error("Kalshi discovery missing series array");
      const series = objectRows(payload.series).map((item) => ({
        ticker: String(item.ticker || ""), volume: Number(item.volume_fp ?? item.volume ?? 0),
      })).filter((item) => item.ticker && Number.isFinite(item.volume) && item.volume > 0)
        .sort((a, b) => b.volume - a.volume || a.ticker.localeCompare(b.ticker));
      pools.set(category, series);
    } catch (error) { intakeFailure(budget, `series_discovery:${category}`, error); }
  });
  const queried = new Set<string>();
  const events = new Map<string, Record<string, unknown>>();
  const groups = new Map(CANONICAL_CATEGORIES.map((category) => [category, new Set<string>()]));
  const attempts = new Map(CANONICAL_CATEGORIES.map((category) => [category, 0]));
  while (queried.size < MAX_KALSHI_SERIES_REQUESTS && intakeAvailable(budget)) {
    const categories = [...CANONICAL_CATEGORIES].filter((category) =>
      (groups.get(category)?.size || 0) < KALSHI_DISCOVERY_GROUP_TARGET
      && pools.get(category)?.some((series) => !queried.has(series.ticker)),
    ).sort((left, right) =>
      (groups.get(left)?.size || 0) - (groups.get(right)?.size || 0)
      || (attempts.get(left) || 0) - (attempts.get(right) || 0));
    if (!categories.length) break;
    const queue: Array<{ category: string; ticker: string }> = [];
    for (const category of categories) {
      const series = pools.get(category)?.find((item) => !queried.has(item.ticker));
      if (!series || queried.size >= MAX_KALSHI_SERIES_REQUESTS) continue;
      queried.add(series.ticker);
      attempts.set(category, (attempts.get(category) || 0) + 1);
      queue.push({ category, ticker: series.ticker });
      if (queue.length === INTAKE_CONCURRENCY) break;
    }
    await intakeMap(queue, budget, async ({ ticker }) => {
      try {
        const url = new URL(`${KALSHI_API}/events`);
        url.searchParams.set("series_ticker", ticker);
        url.searchParams.set("status", "open");
        url.searchParams.set("with_nested_markets", "true");
        // Include the rapid window too. The local normalizer uses the earliest
        // source expiration/occurrence time, not the administrative close only.
        url.searchParams.set("min_close_ts", String(Math.floor(now.getTime() / 1000)));
        url.searchParams.set("limit", String(KALSHI_EVENTS_PER_SERIES));
        const payload = await fetchIntakeJson(url, budget);
        if (!Array.isArray(payload.events)) throw new Error("Kalshi series missing events array");
        const rows = objectRows(payload.events);
        budget.diagnostics.discoveredEvents += rows.length;
        if (payload.cursor) budget.diagnostics.limitsReached.push(`series_page_limit:${ticker}`);
        for (const row of rows) {
          const event = keepFields(row, ["event_ticker", "series_ticker", "title", "sub_title", "category", "settlement_sources"]);
          const markets = objectRows(row.markets);
          budget.diagnostics.fetchedMarkets += markets.length;
          // Each Kalshi market is a binary question; no categorical siblings
          // are dropped. Reject inactive/irrelevant questions before retention.
          const retained = markets.filter((market) => {
            const candidate = normalizeKalshiMarket(event, market, now);
            if (evaluateHardEligibility(candidate, now).eligible) {
              // Previously completed questions may be refreshed, but must not
              // satisfy the supply target for new daily questions.
              if (!blockedGroups.has(candidate.diversityGroupId)) groups.get(String(candidate.category))?.add(candidate.diversityGroupId);
              return true;
            }
            return rapidIntakeCandidate(candidate, now);
          }).map((market) => keepFields(market, KALSHI_MARKET_FIELDS));
          if (retained.length && event.event_ticker) events.set(String(event.event_ticker), { ...event, markets: retained });
        }
      } catch (error) { intakeFailure(budget, `series_events:${ticker}`, error); }
    });
  }
  if (queried.size >= MAX_KALSHI_SERIES_REQUESTS) budget.diagnostics.limitsReached.push("series_request_limit");
  budget.diagnostics.hydratedEvents = events.size;
  budget.diagnostics.elapsedMs = Date.now() - Date.parse(budget.diagnostics.startedAt);
  if (!events.size && budget.diagnostics.errors.length) throw new Error(JSON.stringify(budget.diagnostics));
  return { events: [...events.values()], diagnostics: budget.diagnostics };
}

async function readJsonLimited(response: Response, maximumBytes: number, onBytes?: (bytes: number) => void) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body?.cancel("response too large");
    throw new Error(`External response exceeded ${maximumBytes} bytes`);
  }
  if (!response.body) return JSON.parse(await response.text());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    onBytes?.(value.byteLength);
    if (totalBytes > maximumBytes) {
      await reader.cancel("response too large");
      throw new Error(`External response exceeded ${maximumBytes} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

async function ensureColumn(db: D1Database, table: string, column: string, definition: string) {
  const allowed = new Set([
    "polymarket_candidates.source_platform",
    "polymarket_candidates.diversity_group_id",
    "selection_runs.source_counts_json",
    "selection_items.source_platform",
  ]);
  if (!allowed.has(`${table}.${column}`)) throw new Error("Unsupported curation schema migration");
  const info = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  if (info.results.some((row) => row.name === column)) return;
  await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]) {
  for (let index = 0; index < statements.length; index += 80) {
    await db.batch(statements.slice(index, index + 80));
  }
}

async function closeStaleSyncRuns(db: D1Database, now: Date) {
  const cutoff = new Date(now.getTime() - STALE_SYNC_MINUTES * 60_000).toISOString();
  await db.prepare(`
    UPDATE curation_sync_runs
    SET status='failed', detail_json=json_set(
      CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,
      '$.error', ?, '$.timedOut', json('true')
    ), completed_at=?
    WHERE status='running' AND started_at < ?
  `).bind(
    `Automatically closed after ${STALE_SYNC_MINUTES} minutes without completion`,
    now.toISOString(),
    cutoff,
  ).run();
}

async function retryIncompleteDailySelection(db: D1Database, now = new Date()) {
  const runId = dailySelectionRunId(now);
  const run = await db.prepare("SELECT status FROM selection_runs WHERE id=?").bind(runId)
    .first<{ status: string }>();
  return dailySelectionNeedsRetry(run?.status)
    ? selectDailyBalancedSlate(db, now)
    : null;
}

function settledValue<T>(result: PromiseSettledResult<T>) {
  return result.status === "fulfilled"
    ? result.value
    : { status: "failed", error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
}

function parseJsonList(value: unknown): unknown[] {
  const parsed = safeJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function safeJson(value: unknown, fallback: unknown) {
  if (typeof value !== "string") return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
