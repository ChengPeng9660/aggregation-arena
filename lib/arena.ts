import { getD1 } from "@/db";
import { getCurationSnapshot } from "@/lib/polymarket";
import { CANONICAL_CATEGORIES } from "@/lib/curation-core.js";
import { aggregateDistribution, normalizeDistribution, prophetEventBrier } from "@/lib/event-core.js";

export type ArenaFilters = {
  track?: "aggregators" | "forecasters" | "all";
  window?: "all" | "30d" | "90d";
  season?: string;
  category?: string;
};

type BaseForecast = {
  participantId: string;
  participantName: string;
  probability: number;
};

type AggregateDefinition = {
  id: string;
  name: string;
  shortName: string;
  description: string;
  color: string;
};

export const AGGREGATE_METHODS: AggregateDefinition[] = [
  {
    id: "agg-equal-mean",
    name: "Equal Probability Mean",
    shortName: "Equal Mean",
    description: "Arithmetic mean of all forecaster probabilities.",
    color: "#7c4dff",
  },
  {
    id: "agg-median",
    name: "Median Forecast",
    shortName: "Median",
    description: "Uses the median probability to reduce the influence of extreme forecasts.",
    color: "#a879ff",
  },
  {
    id: "agg-trimmed-mean",
    name: "Trimmed Mean",
    shortName: "Trimmed",
    description: "Drops both tails before averaging when the panel is large enough.",
    color: "#6f8cff",
  },
  {
    id: "agg-logit-pool",
    name: "Log-odds Pool",
    shortName: "Logit Pool",
    description: "Pools forecasts equally in log-odds space, then converts back to probability.",
    color: "#20b9a8",
  },
  {
    id: "agg-extremized",
    name: "Extremized Mean",
    shortName: "Extremized",
    description: "Amplifies the equal mean by 1.2 in log-odds space.",
    color: "#efab02",
  },
  {
    id: "agg-performance-weighted",
    name: "Performance Weighted",
    shortName: "Perf. Weighted",
    description: "Dynamically weights forecasters using shrunk Brier performance on previously resolved events.",
    color: "#f06f56",
  },
];

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    organization TEXT NOT NULL DEFAULT 'Independent',
    kind TEXT NOT NULL DEFAULT 'forecaster',
    color TEXT NOT NULL DEFAULT '#7c4dff',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Entertainment',
    season TEXT NOT NULL DEFAULT 'Season 1',
    close_time TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    event_type TEXT NOT NULL DEFAULT 'binary',
    source_event_id TEXT,
    outcomes_json TEXT NOT NULL DEFAULT '["Yes","No"]',
    resolution INTEGER,
    resolved_outcome TEXT,
    resolution_note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS event_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, outcome_key TEXT NOT NULL,
    label TEXT NOT NULL, market_id TEXT, source_url TEXT NOT NULL DEFAULT '',
    price_at_selection REAL NOT NULL DEFAULT 0, volume_24h REAL NOT NULL DEFAULT 0,
    total_volume REAL NOT NULL DEFAULT 0, liquidity REAL NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, outcome_key)
  )`,
  `CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    participant_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    probability REAL NOT NULL CHECK(probability >= 0 AND probability <= 1),
    rationale TEXT,
    version TEXT NOT NULL DEFAULT 'v1',
    components_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, participant_id)
  )`,
  `CREATE TABLE IF NOT EXISTS prediction_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    participant_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    probability REAL NOT NULL,
    rationale TEXT,
    version TEXT NOT NULL DEFAULT 'v1',
    components_json TEXT,
    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS prediction_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, participant_id TEXT NOT NULL,
    participant_name TEXT NOT NULL, kind TEXT NOT NULL, outcome_key TEXT NOT NULL,
    probability REAL NOT NULL, rationale TEXT, version TEXT NOT NULL DEFAULT 'v1',
    components_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, participant_id, outcome_key)
  )`,
  `CREATE TABLE IF NOT EXISTS prediction_outcome_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, participant_id TEXT NOT NULL,
    participant_name TEXT NOT NULL, kind TEXT NOT NULL, outcome_key TEXT NOT NULL,
    probability REAL NOT NULL, rationale TEXT, version TEXT NOT NULL DEFAULT 'v1',
    components_json TEXT, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    detail_json TEXT,
    actor TEXT NOT NULL DEFAULT 'local-admin',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE INDEX IF NOT EXISTS idx_events_status ON events(status, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_predictions_event ON predictions(event_id, kind)",
  "CREATE INDEX IF NOT EXISTS idx_predictions_participant ON predictions(participant_id, event_id)",
  "CREATE INDEX IF NOT EXISTS idx_history_event ON prediction_history(event_id, recorded_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_event_outcomes_event ON event_outcomes(event_id, display_order)",
  "CREATE INDEX IF NOT EXISTS idx_prediction_outcomes_event ON prediction_outcomes(event_id, kind)",
];

let schemaReady = false;

export async function ensureArenaReady() {
  if (!schemaReady) {
    const db = getD1();
    await db.batch(SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)));
    schemaReady = true;
  }
}

export async function getArenaSnapshot(filters: ArenaFilters = {}) {
  await ensureArenaReady();
  const db = getD1();
  const [eventRows, participantRows, predictionRows, predictionOutcomeRows, eventOutcomeRows, auditRows, curation] = await Promise.all([
    db.prepare("SELECT * FROM events WHERE id NOT LIKE 'demo-%' AND season <> 'Demo Season' ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, updated_at DESC").all(),
    db.prepare("SELECT * FROM participants WHERE status = 'active' ORDER BY created_at, name").all(),
    db.prepare("SELECT * FROM predictions WHERE event_id NOT LIKE 'demo-%' ORDER BY event_id, CASE kind WHEN 'aggregate' THEN 1 ELSE 0 END, participant_name").all(),
    db.prepare("SELECT * FROM prediction_outcomes WHERE event_id NOT LIKE 'demo-%' ORDER BY event_id, participant_id, outcome_key").all(),
    db.prepare("SELECT * FROM event_outcomes WHERE event_id NOT LIKE 'demo-%' ORDER BY event_id, display_order").all(),
    db.prepare("SELECT * FROM audit_log WHERE action <> 'benchmark.seeded' ORDER BY id DESC LIMIT 18").all(),
    getCurationSnapshot(db),
  ]);

  const predictionsByEvent = new Map<string, Record<string, unknown>[]>();
  for (const raw of predictionRows.results as Record<string, unknown>[]) {
    const eventId = String(raw.event_id);
    const list = predictionsByEvent.get(eventId) ?? [];
    list.push({
      id: raw.participant_id,
      name: raw.participant_name,
      kind: raw.kind,
      probability: Number(raw.probability),
      version: raw.version,
      components: safeJson(String(raw.components_json ?? ""), []),
      updatedAt: raw.updated_at,
    });
    predictionsByEvent.set(eventId, list);
  }
  for (const raw of predictionOutcomeRows.results as Record<string, unknown>[]) {
    const eventId = String(raw.event_id);
    const list = predictionsByEvent.get(eventId) ?? [];
    let prediction = list.find((item) => item.id === raw.participant_id);
    if (!prediction) {
      prediction = {
        id: raw.participant_id, name: raw.participant_name, kind: raw.kind,
        probability: 0, version: raw.version, components: safeJson(String(raw.components_json ?? ""), []),
        updatedAt: raw.updated_at, probabilities: {},
      };
      list.push(prediction);
    }
    const probabilities = prediction.probabilities as Record<string, number> || {};
    probabilities[String(raw.outcome_key)] = Number(raw.probability);
    prediction.probabilities = probabilities;
    predictionsByEvent.set(eventId, list);
  }
  const outcomesByEvent = new Map<string, Record<string, unknown>[]>();
  for (const row of eventOutcomeRows.results as Record<string, unknown>[]) {
    const list = outcomesByEvent.get(String(row.event_id)) ?? [];
    list.push({
      key: row.outcome_key, label: row.label, marketId: row.market_id, sourceUrl: row.source_url,
      priceAtSelection: Number(row.price_at_selection), volume24h: Number(row.volume_24h),
      totalVolume: Number(row.total_volume), liquidity: Number(row.liquidity),
    });
    outcomesByEvent.set(String(row.event_id), list);
  }

  const events = (eventRows.results as Record<string, unknown>[]).map((row) => {
    const predictions = predictionsByEvent.get(String(row.id)) ?? [];
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      category: row.category,
      season: row.season,
      closeTime: row.close_time,
      status: row.status,
      eventType: String(row.event_type || "binary"),
      sourceEventId: row.source_event_id,
      outcomes: outcomesByEvent.get(String(row.id)) ?? [
        { key: "yes", label: "Yes" }, { key: "no", label: "No" },
      ],
      resolution: row.resolution === null ? null : Number(row.resolution),
      resolvedOutcome: row.resolved_outcome || (row.resolution === null ? null : Number(row.resolution) ? "yes" : "no"),
      resolutionNote: row.resolution_note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
      forecasterCount: predictions.filter((item) => item.kind === "forecaster").length,
      predictions,
    };
  });

  const participants = (participantRows.results as Record<string, unknown>[]).map((row) => ({
    id: row.id,
    name: row.name,
    organization: row.organization,
    color: row.color,
    kind: row.kind,
  }));
  const leaderboard = await buildLeaderboard(filters, participants);
  const resolvedEvents = events.filter((event) => event.status === "resolved");
  const openEvents = events.filter((event) => event.status === "open");

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      track: filters.track ?? "aggregators",
      window: filters.window ?? "all",
      season: filters.season ?? "all",
      category: filters.category ?? "all",
    },
    stats: {
      openEvents: openEvents.length,
      resolvedEvents: resolvedEvents.length,
      activeForecasters: participants.length,
      totalForecasts: (predictionRows.results as Record<string, unknown>[]).filter((row) => row.kind === "forecaster").length,
      leaderBrier: leaderboard[0]?.brier ?? null,
      leaderName: leaderboard[0]?.name ?? null,
    },
    leaderboard,
    events,
    participants,
    methods: AGGREGATE_METHODS,
    seasons: [...new Set(events.map((event) => String(event.season)))],
    categories: [...new Set(events.map((event) => String(event.category)))],
    activity: (auditRows.results as Record<string, unknown>[]).map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      detail: safeJson(String(row.detail_json ?? ""), {}),
      actor: row.actor,
      createdAt: row.created_at,
    })),
    methodology: {
      primaryMetric: "Prophet Event Brier Score",
      displayMetric: "Event Brier over mutually exclusive outcomes · lower is better",
      minimumResolved: 5,
      coverageRule: "participant forecasts / eligible resolved events",
      weightingRule: "performance weights use resolved history available before the open event is locked",
    },
    curation,
  };
}

export async function createParticipant(
  payload: { name?: string; organization?: string; color?: string; id?: string },
  actor: string,
) {
  await ensureArenaReady();
  const name = requiredText(payload.name, "name");
  const id = slugify(payload.id || name);
  if (!id) throw new ArenaError(400, "The participant name cannot produce a valid ID");
  const organization = String(payload.organization || "Independent").trim().slice(0, 80);
  const color = /^#[0-9a-f]{6}$/i.test(String(payload.color || "")) ? String(payload.color) : "#7c4dff";
  const db = getD1();
  await db.prepare(`
    INSERT INTO participants (id, name, organization, color, status)
    VALUES (?, ?, ?, ?, 'active')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, organization = excluded.organization,
      color = excluded.color, status = 'active'
  `).bind(id, name, organization, color).run();
  await writeAudit("participant.upserted", "participant", id, { name, organization }, actor);
  return { id, name, organization, color };
}

export async function createEvent(
  payload: {
    title?: string;
    description?: string;
    category?: string;
    season?: string;
    closeTime?: string | null;
  },
  actor: string,
) {
  await ensureArenaReady();
  const title = requiredText(payload.title, "title");
  const id = `evt-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const category = String(payload.category || "Entertainment").trim().slice(0, 50);
  if (!CANONICAL_CATEGORIES.includes(category)) {
    throw new Error(`category must be one of: ${CANONICAL_CATEGORIES.join(", ")}`);
  }
  const season = String(payload.season || "Season 1").trim().slice(0, 50);
  const closeTime = payload.closeTime ? new Date(payload.closeTime).toISOString() : null;
  const db = getD1();
  await db.prepare(`
    INSERT INTO events (id, title, description, category, season, close_time, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).bind(id, title, String(payload.description || "").trim(), category, season, closeTime, now, now).run();
  await writeAudit("event.created", "event", id, { title, category, season }, actor);
  return { id, title, category, season, status: "open" };
}

export async function submitForecasts(
  payload: {
    eventId?: string;
    forecasts?: { participantId?: string; probability?: number | string; rationale?: string }[];
  },
  actor: string,
) {
  await ensureArenaReady();
  const eventId = requiredText(payload.eventId, "eventId");
  const db = getD1();
  const event = await db.prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first<Record<string, unknown>>();
  if (!event) throw new ArenaError(404, "Event not found");
  if (event.status !== "open") throw new ArenaError(409, "The event is locked and forecasts cannot be changed");
  const forecasts = Array.isArray(payload.forecasts) ? payload.forecasts : [];
  if (!forecasts.length) throw new ArenaError(400, "Enter at least one probability");
  const participants = await db.prepare("SELECT * FROM participants WHERE status = 'active'").all<Record<string, unknown>>();
  const participantMap = new Map(participants.results.map((row) => [String(row.id), row]));
  const accepted: BaseForecast[] = [];

  for (const item of forecasts) {
    const participantId = String(item.participantId || "");
    const participant = participantMap.get(participantId);
    if (!participant) throw new ArenaError(400, `Unknown forecaster: ${participantId}`);
    const probability = Number(item.probability);
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new ArenaError(400, `${participant.name}'s probability must be between 0 and 1`);
    }
    const row = {
      participantId,
      participantName: String(participant.name),
      probability,
      rationale: String(item.rationale || "").trim() || null,
    };
    await upsertPrediction(eventId, row, "forecaster", "manual-v1", null);
    accepted.push(row);
  }

  const aggregates = await syncAggregates(eventId);
  await writeAudit(
    "forecast.batch_submitted",
    "event",
    eventId,
    { forecasters: accepted.map((item) => item.participantId), aggregateCount: aggregates.length },
    actor,
  );
  return { eventId, accepted, aggregates };
}

export async function resolveEvent(
  payload: { eventId?: string; resolution?: number | string; resolvedOutcome?: string; note?: string },
  actor: string,
) {
  await ensureArenaReady();
  const eventId = requiredText(payload.eventId, "eventId");
  const db = getD1();
  const event = await db.prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first<Record<string, unknown>>();
  if (!event) throw new ArenaError(404, "Event not found");
  if (event.status !== "open") throw new ArenaError(409, "The event is already resolved or invalid");
  const categorical = String(event.event_type || "binary") === "categorical";
  const resolution = Number(payload.resolution);
  const resolvedOutcome = categorical ? String(payload.resolvedOutcome || "") : resolution === 1 ? "yes" : "no";
  if (!categorical && ![0, 1].includes(resolution)) throw new ArenaError(400, "The resolution must be Yes or No");
  if (categorical) {
    const outcome = await db.prepare(
      "SELECT outcome_key FROM event_outcomes WHERE event_id=? AND outcome_key=?",
    ).bind(eventId, resolvedOutcome).first();
    if (!outcome) throw new ArenaError(400, "The resolution is not an outcome of this event");
  }
  const count = await db.prepare(categorical
    ? "SELECT COUNT(DISTINCT participant_id) AS count FROM prediction_outcomes WHERE event_id=? AND kind='forecaster'"
    : "SELECT COUNT(*) AS count FROM predictions WHERE event_id=? AND kind='forecaster'"
  ).bind(eventId).first<{ count: number }>();
  if (Number(count?.count || 0) < 2) throw new ArenaError(409, "At least two forecaster predictions are required before resolution");
  await syncAggregates(eventId);
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE events SET status = 'resolved', resolution = ?, resolved_outcome=?, resolution_note = ?,
      resolved_at = ?, updated_at = ? WHERE id = ?
  `).bind(categorical ? null : resolution, resolvedOutcome, String(payload.note || "").trim() || null, now, now, eventId).run();
  await writeAudit("event.resolved", "event", eventId, { resolution, resolvedOutcome, note: payload.note || "" }, actor);
  return { eventId, status: "resolved", resolution: categorical ? null : resolution, resolvedOutcome };
}

export async function changeEventStatus(
  payload: { eventId?: string; status?: "invalid" | "open" },
  actor: string,
) {
  await ensureArenaReady();
  const eventId = requiredText(payload.eventId, "eventId");
  if (!["invalid", "open"].includes(String(payload.status))) throw new ArenaError(400, "Unsupported status");
  const status = payload.status as "invalid" | "open";
  const now = new Date().toISOString();
  const db = getD1();
  const result = await db.prepare(`
    UPDATE events SET status = ?, resolution = NULL, resolution_note = NULL,
      resolved_outcome=NULL, resolved_at = NULL, updated_at = ? WHERE id = ?
  `).bind(status, now, eventId).run();
  if (!Number(result.meta.changes || 0)) throw new ArenaError(404, "Event not found");
  await writeAudit(`event.${status === "open" ? "reopened" : "invalidated"}`, "event", eventId, {}, actor);
  return { eventId, status };
}

async function buildLeaderboard(
  filters: ArenaFilters,
  participants: { id: unknown; name: unknown; organization: unknown; color: unknown }[],
) {
  const db = getD1();
  const eventRows = await db.prepare(
    `SELECT id, season, category, resolved_at, event_type, resolution, resolved_outcome
     FROM events WHERE status='resolved' AND (resolution IS NOT NULL OR resolved_outcome IS NOT NULL)`,
  ).all<Record<string, unknown>>();
  const now = Date.now();
  const cutoff =
    filters.window === "30d"
      ? now - 30 * 86400000
      : filters.window === "90d"
        ? now - 90 * 86400000
        : 0;
  const eligible = new Set(
    eventRows.results
      .filter((event) => !cutoff || Date.parse(String(event.resolved_at)) >= cutoff)
      .filter((event) => !filters.season || filters.season === "all" || event.season === filters.season)
      .filter((event) => !filters.category || filters.category === "all" || event.category === filters.category)
      .map((event) => String(event.id)),
  );
  if (!eligible.size) return [];

  const rows = await db.prepare(`
    SELECT p.*, e.resolution, e.resolved_at
    FROM predictions p JOIN events e ON e.id = p.event_id
    WHERE e.status = 'resolved' AND (e.resolution IS NOT NULL OR e.resolved_outcome IS NOT NULL)
    ORDER BY e.resolved_at ASC
  `).all<Record<string, unknown>>();
  const outcomeRows = await db.prepare(`
    SELECT po.*, e.resolved_outcome, e.resolved_at
    FROM prediction_outcomes po JOIN events e ON e.id=po.event_id
    WHERE e.status='resolved' AND e.resolved_outcome IS NOT NULL
    ORDER BY e.resolved_at, po.event_id, po.participant_id
  `).all<Record<string, unknown>>();
  const eventOutcomes = await db.prepare(
    "SELECT event_id, outcome_key FROM event_outcomes ORDER BY event_id, display_order",
  ).all<{ event_id: string; outcome_key: string }>();
  const track = filters.track ?? "aggregators";
  const acceptsTrack = (row: Record<string, unknown>) => {
    if (!eligible.has(String(row.event_id))) return false;
    if (track === "aggregators") return row.kind === "aggregate";
    if (track === "forecasters") return row.kind === "forecaster";
    return true;
  };
  type ScoreRow = { eventId: string; participantId: string; participantName: string; kind: string; version: string; loss: number };
  const scores: ScoreRow[] = rows.results.filter(acceptsTrack).map((row) => ({
    eventId: String(row.event_id),
    participantId: String(row.participant_id),
    participantName: String(row.participant_name),
    kind: String(row.kind),
    version: String(row.version || "v1"),
    loss: brier(Number(row.probability), Number(row.resolution)),
  }));
  const outcomeKeysByEvent = new Map<string, string[]>();
  for (const row of eventOutcomes.results) {
    const keys = outcomeKeysByEvent.get(String(row.event_id)) ?? [];
    keys.push(String(row.outcome_key));
    outcomeKeysByEvent.set(String(row.event_id), keys);
  }
  const vectorGroups = new Map<string, Record<string, unknown>[]>();
  for (const row of outcomeRows.results.filter(acceptsTrack)) {
    const key = `${row.event_id}::${row.participant_id}`;
    const group = vectorGroups.get(key) ?? [];
    group.push(row);
    vectorGroups.set(key, group);
  }
  for (const group of vectorGroups.values()) {
    const first = group[0];
    const eventId = String(first.event_id);
    const keys = outcomeKeysByEvent.get(eventId) ?? [];
    const probabilities = Object.fromEntries(group.map((row) => [String(row.outcome_key), Number(row.probability)]));
    if (!keys.length || group.length !== keys.length) continue;
    scores.push({
      eventId,
      participantId: String(first.participant_id),
      participantName: String(first.participant_name),
      kind: String(first.kind),
      version: String(first.version || "v1"),
      loss: prophetEventBrier(probabilities, String(first.resolved_outcome), keys),
    });
  }
  const groups = new Map<string, ScoreRow[]>();
  for (const row of scores) {
    const group = groups.get(row.participantId) ?? [];
    group.push(row);
    groups.set(row.participantId, group);
  }
  const participantMeta = new Map(participants.map((item) => [String(item.id), item]));
  const methodMeta = new Map(AGGREGATE_METHODS.map((item) => [item.id, item]));

  return [...groups.entries()]
    .map(([id, group]) => {
      const losses = group.map((row) => row.loss);
      const averageBrier = mean(losses);
      const ci = bootstrapMeanCI(losses, id);
      const method = methodMeta.get(id);
      const participant = participantMeta.get(id);
      return {
        id,
        name: String(method?.name || group[0].participantName),
        shortName: method?.shortName || String(group[0].participantName),
        organization: method ? "Arena Baseline" : String(participant?.organization || "Independent"),
        kind: group[0].kind,
        color: method?.color || String(participant?.color || "#7c4dff"),
        brier: averageBrier,
        ciLow: ci.low,
        ciHigh: ci.high,
        resolved: losses.length,
        coverage: (losses.length / eligible.size) * 100,
        status: losses.length >= 5 ? "listed" : "provisional",
        version: group[group.length - 1].version,
      };
    })
    .sort((a, b) => a.brier - b.brier)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

export async function syncAggregates(eventId: string) {
  const db = getD1();
  const event = await db.prepare("SELECT event_type FROM events WHERE id=?").bind(eventId)
    .first<{ event_type: string }>();
  if (event?.event_type === "categorical") {
    const outcomeRows = await db.prepare(
      "SELECT outcome_key FROM event_outcomes WHERE event_id=? ORDER BY display_order",
    ).bind(eventId).all<{ outcome_key: string }>();
    const keys = outcomeRows.results.map((row) => row.outcome_key);
    const rows = await db.prepare(`
      SELECT participant_id, participant_name, outcome_key, probability
      FROM prediction_outcomes WHERE event_id=? AND kind='forecaster'
      ORDER BY participant_id, outcome_key
    `).bind(eventId).all<Record<string, unknown>>();
    const grouped = new Map<string, { name: string; probabilities: Record<string, number> }>();
    for (const row of rows.results) {
      const id = String(row.participant_id);
      const forecast = grouped.get(id) ?? { name: String(row.participant_name), probabilities: {} };
      forecast.probabilities[String(row.outcome_key)] = Number(row.probability);
      grouped.set(id, forecast);
    }
    const complete = [...grouped.entries()].filter(([, forecast]) => keys.every((key) => Number.isFinite(forecast.probabilities[key])));
    if (complete.length < 2) return [];
    const weights = await getPerformanceWeights(complete.map(([id]) => id));
    const vectors = complete.map(([, forecast]) => forecast.probabilities);
    const components = JSON.stringify(complete.map(([id]) => id));
    const methods = [
      ["agg-equal-mean", "mean"],
      ["agg-median", "median"],
      ["agg-trimmed-mean", "trimmed"],
      ["agg-logit-pool", "logit"],
      ["agg-extremized", "extremized"],
      ["agg-performance-weighted", "weighted"],
    ] as const;
    const results = [];
    for (const [id, methodName] of methods) {
      const method = AGGREGATE_METHODS.find((item) => item.id === id)!;
      const probabilities = aggregateDistribution(
        vectors,
        keys,
        methodName,
        complete.map(([participantId]) => weights[participantId] || 1),
      );
      await upsertPredictionOutcomes(
        eventId, id, method.name, probabilities, null, "aggregate", "arena-event-v2", components,
      );
      results.push({ id, probabilities });
    }
    return results;
  }
  const rows = await db.prepare(`
    SELECT participant_id, participant_name, probability
    FROM predictions WHERE event_id = ? AND kind = 'forecaster'
    ORDER BY participant_id
  `).bind(eventId).all<Record<string, unknown>>();
  const forecasts: BaseForecast[] = rows.results.map((row) => ({
    participantId: String(row.participant_id),
    participantName: String(row.participant_name),
    probability: Number(row.probability),
  }));
  if (forecasts.length < 2) return [];
  const weights = await getPerformanceWeights(forecasts.map((forecast) => forecast.participantId));
  const values = forecasts.map((forecast) => forecast.probability);
  const components = JSON.stringify(forecasts.map((forecast) => forecast.participantId));
  const equal = mean(values);
  const rowsToWrite = [
    ["agg-equal-mean", mean(values)],
    ["agg-median", median(values)],
    ["agg-trimmed-mean", trimmedMean(values)],
    ["agg-logit-pool", logitPool(values)],
    ["agg-extremized", inverseLogit(logit(clamp(equal)) * 1.2)],
    ["agg-performance-weighted", weightedMean(values, forecasts.map((forecast) => weights[forecast.participantId] || 1))],
  ] as const;
  for (const [id, probability] of rowsToWrite) {
    const method = AGGREGATE_METHODS.find((item) => item.id === id)!;
    await upsertPrediction(
      eventId,
      { participantId: id, participantName: method.name, probability, rationale: null },
      "aggregate",
      "arena-v1",
      components,
    );
  }
  return rowsToWrite.map(([id, probability]) => ({ id, probability }));
}

export async function recordAutomatedForecast(payload: {
  eventId: string;
  participantId: string;
  participantName: string;
  probability: number;
  rationale: string;
  version: string;
  components: Record<string, unknown>;
}) {
  await ensureArenaReady();
  const db = getD1();
  const event = await db.prepare("SELECT status FROM events WHERE id=?").bind(payload.eventId)
    .first<{ status: string }>();
  if (!event) throw new ArenaError(404, "Event not found");
  if (event.status !== "open") throw new ArenaError(409, "The event is locked and cannot accept automated forecasts");
  await upsertPrediction(
    payload.eventId,
    {
      participantId: payload.participantId,
      participantName: payload.participantName,
      probability: payload.probability,
      rationale: payload.rationale,
    },
    "forecaster",
    payload.version,
    JSON.stringify(payload.components),
  );
  const aggregates = await syncAggregates(payload.eventId);
  await writeAudit(
    "forecast.automated_completed",
    "event",
    payload.eventId,
    {
      participantId: payload.participantId,
      probability: payload.probability,
      contextId: payload.components.contextId,
      aggregateCount: aggregates.length,
    },
    "forecast-cron",
  );
  return { eventId: payload.eventId, probability: payload.probability, aggregates };
}

export async function recordAutomatedEventForecast(payload: {
  eventId: string;
  participantId: string;
  participantName: string;
  probabilities: Record<string, number>;
  rationale: string;
  version: string;
  components: Record<string, unknown>;
}) {
  await ensureArenaReady();
  const db = getD1();
  const event = await db.prepare("SELECT status FROM events WHERE id=?").bind(payload.eventId)
    .first<{ status: string }>();
  if (!event) throw new ArenaError(404, "Event not found");
  if (event.status !== "open") throw new ArenaError(409, "The event is locked and cannot accept automated forecasts");
  const outcomes = await db.prepare(
    "SELECT outcome_key FROM event_outcomes WHERE event_id=? ORDER BY display_order",
  ).bind(payload.eventId).all<{ outcome_key: string }>();
  const keys = outcomes.results.map((row) => row.outcome_key);
  const probabilities = normalizeDistribution(payload.probabilities, keys);
  await upsertPredictionOutcomes(
    payload.eventId, payload.participantId, payload.participantName, probabilities,
    payload.rationale, "forecaster", payload.version, JSON.stringify(payload.components),
  );
  const aggregates = await syncAggregates(payload.eventId);
  await writeAudit("forecast.automated_completed", "event", payload.eventId, {
    participantId: payload.participantId,
    probabilities,
    contextId: payload.components.contextId,
    aggregateCount: aggregates.length,
  }, "forecast-cron");
  return { eventId: payload.eventId, probabilities, aggregates };
}

async function getPerformanceWeights(participantIds: string[]) {
  const db = getD1();
  const weights: Record<string, number> = {};
  for (const id of participantIds) {
    const rows = await db.prepare(`
      SELECT p.probability, e.resolution
      FROM predictions p JOIN events e ON e.id = p.event_id
      WHERE p.participant_id = ? AND p.kind = 'forecaster'
        AND e.status = 'resolved' AND e.resolution IS NOT NULL
    `).bind(id).all<Record<string, unknown>>();
    const losses = rows.results.map((row) => brier(Number(row.probability), Number(row.resolution)));
    const shrunkBrier = (losses.reduce((sum, value) => sum + value, 0) + 5 * 0.25) / (losses.length + 5);
    weights[id] = 1 / Math.max(0.04, shrunkBrier);
  }
  return weights;
}

async function upsertPrediction(
  eventId: string,
  row: {
    participantId: string;
    participantName: string;
    probability: number;
    rationale: string | null;
  },
  kind: "forecaster" | "aggregate",
  version: string,
  componentsJson: string | null,
) {
  const db = getD1();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`
      INSERT INTO predictions (
        event_id, participant_id, participant_name, kind, probability, rationale,
        version, components_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id, participant_id) DO UPDATE SET
        participant_name = excluded.participant_name,
        probability = excluded.probability,
        rationale = excluded.rationale,
        version = excluded.version,
        components_json = excluded.components_json,
        updated_at = excluded.updated_at
    `).bind(
      eventId,
      row.participantId,
      row.participantName,
      kind,
      row.probability,
      row.rationale,
      version,
      componentsJson,
      now,
      now,
    ),
    db.prepare(`
      INSERT INTO prediction_history (
        event_id, participant_id, participant_name, kind, probability, rationale,
        version, components_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      eventId,
      row.participantId,
      row.participantName,
      kind,
      row.probability,
      row.rationale,
      version,
      componentsJson,
      now,
    ),
  ]);
}

async function upsertPredictionOutcomes(
  eventId: string,
  participantId: string,
  participantName: string,
  probabilities: Record<string, number>,
  rationale: string | null,
  kind: "forecaster" | "aggregate",
  version: string,
  componentsJson: string | null,
) {
  const db = getD1();
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const [outcomeKey, probability] of Object.entries(probabilities)) {
    statements.push(
      db.prepare(`
        INSERT INTO prediction_outcomes (
          event_id, participant_id, participant_name, kind, outcome_key, probability,
          rationale, version, components_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id, participant_id, outcome_key) DO UPDATE SET
          participant_name=excluded.participant_name, kind=excluded.kind,
          probability=excluded.probability, rationale=excluded.rationale,
          version=excluded.version, components_json=excluded.components_json,
          updated_at=excluded.updated_at
      `).bind(
        eventId, participantId, participantName, kind, outcomeKey, probability,
        rationale, version, componentsJson, now, now,
      ),
      db.prepare(`
        INSERT INTO prediction_outcome_history (
          event_id, participant_id, participant_name, kind, outcome_key, probability,
          rationale, version, components_json, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        eventId, participantId, participantName, kind, outcomeKey, probability,
        rationale, version, componentsJson, now,
      ),
    );
  }
  await db.batch(statements);
}

async function writeAudit(
  action: string,
  entityType: string,
  entityId: string,
  detail: Record<string, unknown>,
  actor: string,
) {
  await getD1().prepare(`
    INSERT INTO audit_log (action, entity_type, entity_id, detail_json, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(action, entityType, entityId, JSON.stringify(detail), actor, new Date().toISOString()).run();
}

function brier(probability: number, resolution: number) {
  return (probability - resolution) ** 2;
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function trimmedMean(values: number[]) {
  if (values.length < 5) return mean(values);
  const sorted = [...values].sort((a, b) => a - b);
  return mean(sorted.slice(1, -1));
}

function weightedMean(values: number[], weights: number[]) {
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  return values.reduce((sum, value, index) => sum + value * weights[index], 0) / total;
}

function clamp(value: number) {
  return Math.min(0.999, Math.max(0.001, value));
}

function logit(value: number) {
  const p = clamp(value);
  return Math.log(p / (1 - p));
}

function inverseLogit(value: number) {
  return 1 / (1 + Math.exp(-value));
}

function logitPool(values: number[]) {
  return inverseLogit(mean(values.map(logit)));
}

function bootstrapMeanCI(values: number[], seedText: string) {
  if (values.length < 2) return { low: values[0] ?? 0, high: values[0] ?? 0 };
  let state = hashSeed(seedText);
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const replicates: number[] = [];
  for (let repeat = 0; repeat < 500; repeat += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      total += values[Math.floor(random() * values.length)];
    }
    replicates.push(total / values.length);
  }
  replicates.sort((a, b) => a - b);
  return {
    low: replicates[Math.floor(replicates.length * 0.025)],
    high: replicates[Math.floor(replicates.length * 0.975)],
  };
}

function hashSeed(text: string) {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function slugify(value: string) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function requiredText(value: unknown, label: string) {
  const text = String(value || "").trim();
  if (!text) throw new ArenaError(400, `${label} is required`);
  return text.slice(0, 300);
}

function safeJson(value: string, fallback: unknown) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export class ArenaError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
