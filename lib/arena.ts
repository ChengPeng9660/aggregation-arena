import { getD1 } from "@/db";
import { getCurationSnapshot } from "@/lib/polymarket";

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
    description: "所有 forecaster 概率等权平均。",
    color: "#7c4dff",
  },
  {
    id: "agg-median",
    name: "Median Forecast",
    shortName: "Median",
    description: "使用概率中位数，降低极端预测的影响。",
    color: "#a879ff",
  },
  {
    id: "agg-trimmed-mean",
    name: "Trimmed Mean",
    shortName: "Trimmed",
    description: "样本足够时去掉两端预测后求平均。",
    color: "#6f8cff",
  },
  {
    id: "agg-logit-pool",
    name: "Log-odds Pool",
    shortName: "Logit Pool",
    description: "在 log-odds 空间等权聚合，再转回概率。",
    color: "#20b9a8",
  },
  {
    id: "agg-extremized",
    name: "Extremized Mean",
    shortName: "Extremized",
    description: "将等权平均在 log-odds 空间放大 1.2 倍。",
    color: "#efab02",
  },
  {
    id: "agg-performance-weighted",
    name: "Performance Weighted",
    shortName: "Perf. Weighted",
    description: "仅使用此前已结算题目的收缩 Brier 表现动态加权。",
    color: "#f06f56",
  },
];

const DEFAULT_PARTICIPANTS = [
  ["model-a", "Model A", "Frontier Lab", "#8a61ff"],
  ["model-b", "Model B", "Frontier Lab", "#4f7cff"],
  ["model-c", "Model C", "Independent", "#29b7a6"],
  ["model-d", "Model D", "Open Model", "#efab02"],
  ["crowd-median", "Crowd Median", "Human Baseline", "#f06f56"],
] as const;

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
    category TEXT NOT NULL DEFAULT 'General',
    season TEXT NOT NULL DEFAULT 'Season 1',
    close_time TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    resolution INTEGER,
    resolution_note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TEXT
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
];

let schemaReady = false;

export async function ensureArenaReady() {
  if (!schemaReady) {
    const db = getD1();
    await db.batch(SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)));
    schemaReady = true;
  }
  await seedDemoIfEmpty();
}

export async function getArenaSnapshot(filters: ArenaFilters = {}) {
  await ensureArenaReady();
  const db = getD1();
  const [eventRows, participantRows, predictionRows, auditRows, curation] = await Promise.all([
    db.prepare("SELECT * FROM events ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, updated_at DESC").all(),
    db.prepare("SELECT * FROM participants WHERE status = 'active' ORDER BY created_at, name").all(),
    db.prepare("SELECT * FROM predictions ORDER BY event_id, CASE kind WHEN 'aggregate' THEN 1 ELSE 0 END, participant_name").all(),
    db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 18").all(),
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
      resolution: row.resolution === null ? null : Number(row.resolution),
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
      leaderIndex: leaderboard[0]?.brierIndex ?? null,
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
      primaryMetric: "Binary Brier Score",
      displayMetric: "Brier Index = (1 - sqrt(Brier)) × 100",
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
  if (!id) throw new ArenaError(400, "参与者名称无法生成有效 ID");
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
  const category = String(payload.category || "General").trim().slice(0, 50);
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
  if (!event) throw new ArenaError(404, "题目不存在");
  if (event.status !== "open") throw new ArenaError(409, "题目已锁定，不能再修改预测");
  const forecasts = Array.isArray(payload.forecasts) ? payload.forecasts : [];
  if (!forecasts.length) throw new ArenaError(400, "至少输入一个概率");
  const participants = await db.prepare("SELECT * FROM participants WHERE status = 'active'").all<Record<string, unknown>>();
  const participantMap = new Map(participants.results.map((row) => [String(row.id), row]));
  const accepted: BaseForecast[] = [];

  for (const item of forecasts) {
    const participantId = String(item.participantId || "");
    const participant = participantMap.get(participantId);
    if (!participant) throw new ArenaError(400, `未知 forecaster: ${participantId}`);
    const probability = Number(item.probability);
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new ArenaError(400, `${participant.name} 的概率必须在 0–1 之间`);
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
  payload: { eventId?: string; resolution?: number | string; note?: string },
  actor: string,
) {
  await ensureArenaReady();
  const eventId = requiredText(payload.eventId, "eventId");
  const resolution = Number(payload.resolution);
  if (![0, 1].includes(resolution)) throw new ArenaError(400, "结算结果必须是 Yes 或 No");
  const db = getD1();
  const event = await db.prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first<Record<string, unknown>>();
  if (!event) throw new ArenaError(404, "题目不存在");
  if (event.status !== "open") throw new ArenaError(409, "题目已经结算或作废");
  const count = await db.prepare(
    "SELECT COUNT(*) AS count FROM predictions WHERE event_id = ? AND kind = 'forecaster'",
  ).bind(eventId).first<{ count: number }>();
  if (Number(count?.count || 0) < 2) throw new ArenaError(409, "至少录入两个 forecaster 概率后才能结算");
  await syncAggregates(eventId);
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE events SET status = 'resolved', resolution = ?, resolution_note = ?,
      resolved_at = ?, updated_at = ? WHERE id = ?
  `).bind(resolution, String(payload.note || "").trim() || null, now, now, eventId).run();
  await writeAudit("event.resolved", "event", eventId, { resolution, note: payload.note || "" }, actor);
  return { eventId, status: "resolved", resolution };
}

export async function changeEventStatus(
  payload: { eventId?: string; status?: "invalid" | "open" },
  actor: string,
) {
  await ensureArenaReady();
  const eventId = requiredText(payload.eventId, "eventId");
  if (!["invalid", "open"].includes(String(payload.status))) throw new ArenaError(400, "不支持的状态");
  const status = payload.status as "invalid" | "open";
  const now = new Date().toISOString();
  const db = getD1();
  const result = await db.prepare(`
    UPDATE events SET status = ?, resolution = NULL, resolution_note = NULL,
      resolved_at = NULL, updated_at = ? WHERE id = ?
  `).bind(status, now, eventId).run();
  if (!Number(result.meta.changes || 0)) throw new ArenaError(404, "题目不存在");
  await writeAudit(`event.${status === "open" ? "reopened" : "invalidated"}`, "event", eventId, {}, actor);
  return { eventId, status };
}

async function buildLeaderboard(
  filters: ArenaFilters,
  participants: { id: unknown; name: unknown; organization: unknown; color: unknown }[],
) {
  const db = getD1();
  const eventRows = await db.prepare(
    "SELECT id, season, category, resolved_at FROM events WHERE status = 'resolved' AND resolution IS NOT NULL",
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
    WHERE e.status = 'resolved' AND e.resolution IS NOT NULL
    ORDER BY e.resolved_at ASC
  `).all<Record<string, unknown>>();
  const track = filters.track ?? "aggregators";
  const filtered = rows.results.filter((row) => {
    if (!eligible.has(String(row.event_id))) return false;
    if (track === "aggregators") return row.kind === "aggregate";
    if (track === "forecasters") return row.kind === "forecaster";
    return true;
  });
  const baselineLoss = new Map<string, number>();
  for (const row of rows.results) {
    if (row.participant_id === "agg-equal-mean" && eligible.has(String(row.event_id))) {
      baselineLoss.set(String(row.event_id), brier(Number(row.probability), Number(row.resolution)));
    }
  }
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of filtered) {
    const id = String(row.participant_id);
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }
  const participantMeta = new Map(participants.map((item) => [String(item.id), item]));
  const methodMeta = new Map(AGGREGATE_METHODS.map((item) => [item.id, item]));

  return [...groups.entries()]
    .map(([id, group]) => {
      const losses = group.map((row) => brier(Number(row.probability), Number(row.resolution)));
      const averageBrier = mean(losses);
      const ci = bootstrapMeanCI(losses, id);
      const baseline = group
        .map((row) => baselineLoss.get(String(row.event_id)))
        .filter((value): value is number => Number.isFinite(value));
      const meanBrier = baseline.length ? mean(baseline) : null;
      const method = methodMeta.get(id);
      const participant = participantMeta.get(id);
      const recent = losses.slice(-8).map((loss) => brierIndex(loss));
      return {
        id,
        name: String(method?.name || group[0].participant_name),
        shortName: method?.shortName || String(group[0].participant_name),
        organization: method ? "Arena Baseline" : String(participant?.organization || "Independent"),
        kind: String(group[0].kind),
        color: method?.color || String(participant?.color || "#7c4dff"),
        brier: averageBrier,
        brierIndex: brierIndex(averageBrier),
        ciLow: brierIndex(ci.high),
        ciHigh: brierIndex(ci.low),
        resolved: losses.length,
        coverage: (losses.length / eligible.size) * 100,
        gainVsMean:
          meanBrier !== null && meanBrier > 0 ? ((meanBrier - averageBrier) / meanBrier) * 100 : null,
        status: losses.length >= 5 ? "listed" : "provisional",
        recent,
        version: String(group[group.length - 1].version || "v1"),
      };
    })
    .sort((a, b) => a.brier - b.brier)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

async function syncAggregates(eventId: string) {
  const db = getD1();
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
  if (!event) throw new ArenaError(404, "题目不存在");
  if (event.status !== "open") throw new ArenaError(409, "题目已锁定，不能写入自动预测");
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

async function seedDemoIfEmpty() {
  const db = getD1();
  const count = await db.prepare("SELECT COUNT(*) AS count FROM events").first<{ count: number }>();
  if (Number(count?.count || 0) > 0) return;
  const now = Date.now();
  for (const [id, name, organization, color] of DEFAULT_PARTICIPANTS) {
    await db.prepare(`
      INSERT OR IGNORE INTO participants (id, name, organization, color, status, created_at)
      VALUES (?, ?, ?, ?, 'active', ?)
    `).bind(id, name, organization, color, new Date(now - 80 * 86400000).toISOString()).run();
  }
  const demo = [
    ["Will the monthly inflation print exceed consensus?", "Economics", 1, [0.62, 0.55, 0.71, 0.48, 0.58]],
    ["Will the central bank hold its policy rate?", "Economics", 1, [0.76, 0.68, 0.81, 0.64, 0.72]],
    ["Will the incumbent coalition retain a majority?", "Politics", 0, [0.44, 0.39, 0.51, 0.47, 0.42]],
    ["Will the benchmark index close the week higher?", "Markets", 1, [0.57, 0.63, 0.54, 0.69, 0.59]],
    ["Will the launch occur before the stated deadline?", "Technology", 0, [0.73, 0.61, 0.67, 0.58, 0.64]],
    ["Will the home team win the series?", "Sports", 1, [0.66, 0.59, 0.74, 0.71, 0.68]],
    ["Will the quarterly revenue beat guidance?", "Business", 1, [0.69, 0.77, 0.65, 0.72, 0.70]],
    ["Will the proposed regulation pass this session?", "Policy", 0, [0.36, 0.43, 0.31, 0.49, 0.39]],
    ["Will the next inflation release fall below 3%?", "Economics", null, [0.48, 0.56, 0.51, 0.44, 0.52]],
    ["Will the AI safety bill advance to a final vote?", "Policy", null, [0.61, 0.53, 0.66, 0.57, 0.59]],
  ] as const;
  for (let index = 0; index < demo.length; index += 1) {
    const [title, category, resolution, values] = demo[index];
    const id = `demo-${String(index + 1).padStart(2, "0")}`;
    const createdAt = new Date(now - (70 - index * 6) * 86400000).toISOString();
    const closeTime = new Date(now + (resolution === null ? 21 + index : -60 + index * 7) * 86400000).toISOString();
    await db.prepare(`
      INSERT OR IGNORE INTO events (
        id, title, description, category, season, close_time, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'Demo Season', ?, 'open', ?, ?)
    `).bind(id, title, "Seeded example event. Replace or extend it with your own benchmark questions.", category, closeTime, createdAt, createdAt).run();
    for (let participantIndex = 0; participantIndex < DEFAULT_PARTICIPANTS.length; participantIndex += 1) {
      const [participantId, participantName] = DEFAULT_PARTICIPANTS[participantIndex];
      await upsertPrediction(
        id,
        {
          participantId,
          participantName,
          probability: values[participantIndex],
          rationale: null,
        },
        "forecaster",
        "demo-v1",
        null,
      );
    }
    await syncAggregates(id);
    if (resolution !== null) {
      const resolvedAt = new Date(now - (58 - index * 7) * 86400000).toISOString();
      await db.prepare(`
        UPDATE events SET status = 'resolved', resolution = ?, resolution_note = 'Seeded demo resolution',
          resolved_at = ?, updated_at = ? WHERE id = ?
      `).bind(resolution, resolvedAt, resolvedAt, id).run();
    }
  }
  await writeAudit("benchmark.seeded", "benchmark", "demo-season", { events: demo.length }, "system");
}

function brier(probability: number, resolution: number) {
  return (probability - resolution) ** 2;
}

function brierIndex(score: number) {
  return (1 - Math.sqrt(Math.max(0, score))) * 100;
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
  if (!text) throw new ArenaError(400, `${label} 不能为空`);
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
