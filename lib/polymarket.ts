import { getD1 } from "@/db";
import {
  CANONICAL_CATEGORIES,
  CURATION_CONFIG,
  normalizePolymarketMarket,
  rankCandidates,
  selectBalancedCandidates,
} from "@/lib/curation-core";

type Candidate = ReturnType<typeof normalizePolymarketMarket> & {
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
const MAX_EVENT_PAGES = 4;
const EVENT_PAGE_SIZE = 100;

const CURATION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS polymarket_candidates (
    market_id TEXT PRIMARY KEY, source_event_id TEXT NOT NULL, event_slug TEXT NOT NULL DEFAULT '',
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
    category_counts_json TEXT NOT NULL DEFAULT '{}', started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS selection_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, market_id TEXT NOT NULL,
    event_id TEXT NOT NULL, category TEXT NOT NULL, rank INTEGER NOT NULL,
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
  curationSchemaReady = true;
}

export async function syncPolymarketCandidates(db: D1Database = getD1(), now = new Date()) {
  await ensureCurationReady(db);
  const startedAt = now.toISOString();
  const run = await db.prepare(
    "INSERT INTO curation_sync_runs (status, started_at) VALUES ('running', ?) RETURNING id",
  ).bind(startedAt).first<{ id: number }>();
  const runId = run?.id;

  try {
    const events: Record<string, unknown>[] = [];
    for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
      const url = new URL("/events", GAMMA_API);
      url.searchParams.set("active", "true");
      url.searchParams.set("closed", "false");
      url.searchParams.set("order", "volume24hr");
      url.searchParams.set("ascending", "false");
      url.searchParams.set("limit", String(EVENT_PAGE_SIZE));
      url.searchParams.set("offset", String(page * EVENT_PAGE_SIZE));
      const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "AggregationArena/1.0" } });
      if (!response.ok) throw new Error(`Polymarket Gamma returned ${response.status}`);
      const pageRows = await response.json() as Record<string, unknown>[];
      events.push(...pageRows);
      if (pageRows.length < EVENT_PAGE_SIZE) break;
    }

    const normalized = events.flatMap((event) => {
      const markets = Array.isArray(event.markets) ? event.markets as Record<string, unknown>[] : [];
      return markets.map((market) => normalizePolymarketMarket(event, market, now));
    }).filter((candidate) => candidate.marketId);
    const ranked = rankCandidates(normalized, now) as Candidate[];

    const statements = ranked.flatMap((candidate) => {
      const upsert = db.prepare(`
        INSERT INTO polymarket_candidates (
          market_id, source_event_id, event_slug, market_slug, series_id, title, description, rules,
          category, category_confidence, tags_json, outcomes_json, close_time, start_time, yes_price,
          volume_24h, total_volume, liquidity, volume_percentile, selection_score, eligible,
          rejection_reasons_json, source_url, raw_json, first_seen_at, last_seen_at
          , event_title, event_neg_risk, event_neg_risk_augmented
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(market_id) DO UPDATE SET
          source_event_id=excluded.source_event_id, event_slug=excluded.event_slug, market_slug=excluded.market_slug,
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
      `).bind(
        candidate.marketId, candidate.sourceEventId, candidate.eventSlug, candidate.marketSlug,
        candidate.seriesId, candidate.title, candidate.description, candidate.rules, candidate.category,
        candidate.categoryConfidence, JSON.stringify(candidate.tags), JSON.stringify(candidate.outcomes),
        candidate.closeTime, candidate.startTime, candidate.yesPrice, candidate.volume24h,
        candidate.totalVolume, candidate.liquidity, candidate.volume24Percentile || 0,
        candidate.selectionScore, candidate.eligible ? 1 : 0, JSON.stringify(candidate.reasons),
        candidate.sourceUrl, JSON.stringify(candidate.raw), startedAt, startedAt,
        candidate.eventTitle, candidate.eventNegRisk ? 1 : 0, candidate.eventNegRiskAugmented ? 1 : 0,
      );
      const snapshot = db.prepare(`
        INSERT INTO market_snapshots (market_id, captured_at, yes_price, volume_24h, total_volume, liquidity)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(candidate.marketId, startedAt, candidate.yesPrice, candidate.volume24h, candidate.totalVolume, candidate.liquidity);
      return candidate.eligible ? [upsert, snapshot] : [upsert];
    });
    await runBatches(db, statements);

    const eligibleCount = ranked.filter((candidate) => candidate.eligible).length;
    await db.prepare(`
      UPDATE curation_sync_runs SET status='completed', fetched_events=?, fetched_markets=?,
        eligible_markets=?, detail_json=?, completed_at=? WHERE id=?
    `).bind(
      events.length,
      ranked.length,
      eligibleCount,
      JSON.stringify({ configVersion: CURATION_CONFIG.configVersion, pages: Math.ceil(events.length / EVENT_PAGE_SIZE) }),
      new Date().toISOString(),
      runId,
    ).run();
    return { events: events.length, markets: ranked.length, eligible: eligibleCount };
  } catch (error) {
    if (runId) {
      await db.prepare(`
        UPDATE curation_sync_runs SET status='failed', detail_json=?, completed_at=? WHERE id=?
      `).bind(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), new Date().toISOString(), runId).run();
    }
    throw error;
  }
}

export async function selectDailyBalancedSlate(db: D1Database = getD1(), now = new Date()) {
  await ensureCurationReady(db);
  const date = now.toISOString().slice(0, 10);
  const runId = `poly-${date}-v2`;
  const existing = await db.prepare("SELECT * FROM selection_runs WHERE id=?").bind(runId).first<Record<string, unknown>>();
  if (existing?.status === "completed") return { runId, selected: Number(existing.selected_count), reused: true };

  const rows = await db.prepare(`
    SELECT c.*, CASE WHEN EXISTS (
      SELECT 1 FROM selection_items si
      JOIN polymarket_candidates prior ON prior.market_id=si.market_id
      WHERE prior.source_event_id=c.source_event_id
    ) THEN 1 ELSE 0 END AS already_selected
    FROM polymarket_candidates c
    WHERE datetime(c.close_time) > datetime(?)
    ORDER BY c.category, c.selection_score DESC
  `).bind(new Date(now.getTime() + CURATION_CONFIG.minimumCloseHours * 3_600_000).toISOString()).all<Record<string, unknown>>();
  const recent = await db.prepare(`
    SELECT category, COUNT(*) AS count FROM selection_items
    WHERE datetime(selected_at) >= datetime(?, '-7 days') GROUP BY category
  `).bind(now.toISOString()).all<{ category: string; count: number }>();
  const recentCounts = Object.fromEntries(recent.results.map((row) => [row.category, Number(row.count)]));
  const marketCandidates = rows.results.map(rowToCandidate);
  const candidates = buildEventCandidates(marketCandidates);
  const selected = selectBalancedCandidates(candidates, {
    targetPerCategory: CURATION_CONFIG.targetPerCategory,
    recentCategoryCounts: recentCounts,
  }) as EventCandidate[];
  const categoryCounts = Object.fromEntries(CANONICAL_CATEGORIES.map((category) => [
    category,
    selected.filter((candidate) => candidate.category === category).length,
  ]));
  const completedAt = new Date().toISOString();

  await db.prepare(`
    INSERT INTO selection_runs (
      id, config_version, taxonomy_version, status, candidate_count, eligible_count,
      selected_count, category_counts_json, started_at, completed_at
    ) VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status='completed', candidate_count=excluded.candidate_count,
      eligible_count=excluded.eligible_count, selected_count=excluded.selected_count,
      category_counts_json=excluded.category_counts_json, completed_at=excluded.completed_at
  `).bind(
    runId, CURATION_CONFIG.configVersion, CURATION_CONFIG.taxonomyVersion, candidates.length,
    candidates.filter((candidate) => !candidate.alreadySelected).length, selected.length,
    JSON.stringify(categoryCounts), now.toISOString(), completedAt,
  ).run();

  const statements = selected.flatMap((candidate) => {
    const eventId = `poly-event-${candidate.sourceEventId}`;
    const eventUrl = candidate.eventSlug
      ? `https://polymarket.com/event/${candidate.eventSlug}`
      : candidate.sourceUrl;
    const sourceMetadata = [
      "Source: Polymarket",
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
        ) VALUES (?, ?, ?, ?, 'Polymarket Live', ?, 'open', ?, ?, ?, ?, ?)
      `).bind(
        eventId, candidate.eventTitle || candidate.title, description, candidate.category,
        candidate.closeTime, candidate.eventType, candidate.sourceEventId,
        JSON.stringify(candidate.eventOutcomes.map((outcome) => outcome.key)),
        completedAt, completedAt,
      ),
      db.prepare(`
        INSERT OR IGNORE INTO selection_items (
          run_id, market_id, event_id, category, rank, selection_score, price_at_selection,
          volume_24h, total_volume, liquidity, selected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        runId, candidate.marketId, eventId, candidate.category, candidate.categoryRank || 0,
        candidate.selectionScore, candidate.yesPrice, candidate.volume24h,
        candidate.totalVolume, candidate.liquidity, completedAt,
      ),
      db.prepare(`
        INSERT INTO audit_log (action, entity_type, entity_id, detail_json, actor, created_at)
        VALUES ('curation.event_selected', 'event', ?, ?, 'polymarket-cron', ?)
      `).bind(eventId, JSON.stringify({
        runId,
        sourceEventId: candidate.sourceEventId,
        representativeMarketId: candidate.marketId,
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
  await runBatches(db, statements);
  return { runId, selected: selected.length, categoryCounts, reused: false };
}

export async function resolveSelectedPolymarketMarkets(db: D1Database = getD1()) {
  await ensureCurationReady(db);
  const rows = await db.prepare(`
    SELECT si.market_id, si.event_id, e.event_type, e.source_event_id FROM selection_items si
    JOIN events e ON e.id=si.event_id
    WHERE e.status='open' AND datetime(e.close_time) <= datetime('now', '+12 hours')
    ORDER BY e.close_time LIMIT 25
  `).all<{ market_id: string; event_id: string; event_type: string; source_event_id: string | null }>();
  let resolved = 0;
  for (const row of rows.results) {
    if (row.event_type === "categorical" && row.source_event_id) {
      const response = await fetch(`${GAMMA_API}/events/${encodeURIComponent(row.source_event_id)}`, {
        headers: { accept: "application/json", "user-agent": "AggregationArena/1.0" },
      });
      if (!response.ok) continue;
      const sourceEvent = await response.json() as Record<string, unknown>;
      const sourceMarkets = Array.isArray(sourceEvent.markets) ? sourceEvent.markets as Record<string, unknown>[] : [];
      const outcomeRows = await db.prepare(
        "SELECT outcome_key, market_id FROM event_outcomes WHERE event_id=? ORDER BY display_order",
      ).bind(row.event_id).all<{ outcome_key: string; market_id: string }>();
      const winner = outcomeRows.results.find((outcome) => {
        const market = sourceMarkets.find((item) => String(item.id) === String(outcome.market_id));
        if (!market || market.closed !== true) return false;
        const prices = parseJsonList(market.outcomePrices).map(Number);
        const labels = parseJsonList(market.outcomes).map((value) => String(value).toLowerCase());
        const yesIndex = labels.indexOf("yes");
        return prices[yesIndex >= 0 ? yesIndex : 0] >= 0.999;
      });
      if (!winner) continue;
      const resolvedAt = new Date().toISOString();
      await db.batch([
        db.prepare(`
          UPDATE events SET status='resolved', resolution=NULL, resolved_outcome=?,
            resolution_note=?, resolved_at=?, updated_at=? WHERE id=? AND status='open'
        `).bind(
          winner.outcome_key,
          `Automatically resolved from Polymarket event ${row.source_event_id}.`,
          resolvedAt, resolvedAt, row.event_id,
        ),
        db.prepare(`
          INSERT INTO audit_log (action, entity_type, entity_id, detail_json, actor, created_at)
          VALUES ('curation.event_resolved', 'event', ?, ?, 'polymarket-cron', ?)
        `).bind(row.event_id, JSON.stringify({
          sourceEventId: row.source_event_id,
          resolvedOutcome: winner.outcome_key,
        }), resolvedAt),
      ]);
      resolved += 1;
      continue;
    }
    const response = await fetch(`${GAMMA_API}/markets/${encodeURIComponent(row.market_id)}`, {
      headers: { accept: "application/json", "user-agent": "AggregationArena/1.0" },
    });
    if (!response.ok) continue;
    const market = await response.json() as Record<string, unknown>;
    const prices = parseJsonList(market.outcomePrices).map(Number);
    const outcomes = parseJsonList(market.outcomes).map(String);
    const yesIndex = outcomes.findIndex((value) => value.toLowerCase() === "yes");
    const yesPrice = prices[yesIndex >= 0 ? yesIndex : 0];
    if (market.closed !== true || (yesPrice < 0.999 && yesPrice > 0.001)) continue;
    const outcome = yesPrice >= 0.999 ? 1 : 0;
    const now = new Date().toISOString();
    await db.batch([
      db.prepare(`
        UPDATE events SET status='resolved', resolution=?, resolved_outcome=?, resolution_note=?,
          resolved_at=?, updated_at=? WHERE id=? AND status='open'
      `).bind(outcome, outcome ? "yes" : "no", `Automatically resolved from Polymarket market ${row.market_id}.`, now, now, row.event_id),
      db.prepare(`
        INSERT INTO audit_log (action, entity_type, entity_id, detail_json, actor, created_at)
        VALUES ('curation.event_resolved', 'event', ?, ?, 'polymarket-cron', ?)
      `).bind(row.event_id, JSON.stringify({ marketId: row.market_id, resolution: outcome }), now),
    ]);
    resolved += 1;
  }
  return { checked: rows.results.length, resolved };
}

export async function runPolymarketScheduled(
  env: { DB: D1Database },
  controller: { cron: string },
) {
  const daily = controller.cron === "10 0 * * *";
  const sync = daily ? null : await syncPolymarketCandidates(env.DB);
  const resolution = await resolveSelectedPolymarketMarkets(env.DB);
  const selection = daily
    ? await selectDailyBalancedSlate(env.DB)
    : null;
  return { sync, resolution, selection };
}

export async function getCurationSnapshot(db: D1Database = getD1()) {
  await ensureCurationReady(db);
  const [latestSync, latestRun, categoryRows, selectedRows] = await Promise.all([
    db.prepare("SELECT * FROM curation_sync_runs ORDER BY id DESC LIMIT 1").first<Record<string, unknown>>(),
    db.prepare("SELECT * FROM selection_runs ORDER BY started_at DESC LIMIT 1").first<Record<string, unknown>>(),
    db.prepare(`
      SELECT category, COUNT(*) AS candidate_count,
        SUM(CASE WHEN eligible=1 THEN 1 ELSE 0 END) AS eligible_count
      FROM polymarket_candidates GROUP BY category
    `).all<Record<string, unknown>>(),
    db.prepare(`
      SELECT si.*, c.title, c.close_time, c.yes_price, c.source_url
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
    latestSelection: latestRun ? {
      id: latestRun.id,
      status: latestRun.status,
      candidateCount: Number(latestRun.candidate_count),
      eligibleCount: Number(latestRun.eligible_count),
      selectedCount: Number(latestRun.selected_count),
      categoryCounts: safeJson(latestRun.category_counts_json, {}),
      completedAt: latestRun.completed_at,
    } : null,
    categories: CANONICAL_CATEGORIES.map((category) => {
      const row = categoryMap.get(category);
      return {
        category,
        candidates: Number(row?.candidate_count || 0),
        eligible: Number(row?.eligible_count || 0),
        selectedThisRun: Number((safeJson(latestRun?.category_counts_json, {}) as Record<string, number>)[category] || 0),
        selectedLast7d: rollingMap[category] || 0,
        target: CURATION_CONFIG.targetPerCategory,
      };
    }),
    selectedMarkets: selectedRows.results.map((row) => ({
      marketId: row.market_id,
      eventId: row.event_id,
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
    marketId: String(row.market_id), sourceEventId: String(row.source_event_id),
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

async function runBatches(db: D1Database, statements: D1PreparedStatement[]) {
  for (let index = 0; index < statements.length; index += 80) {
    await db.batch(statements.slice(index, index + 80));
  }
}

function parseJsonList(value: unknown): unknown[] {
  const parsed = safeJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function safeJson(value: unknown, fallback: unknown) {
  if (typeof value !== "string") return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
