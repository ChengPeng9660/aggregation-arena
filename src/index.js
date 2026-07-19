import { brier, buildAggregates } from "./scoring.js";

const GAMMA_API = "https://gamma-api.polymarket.com";
const PARTICIPANT_COLORS = ["#3151c6", "#b68116", "#7a56a8", "#248e82", "#68717e", "#9297a3", "#c38c24"];

export default {
  async fetch(request, env, context) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    try {
      return await route(request, env, context);
    } catch (error) {
      console.error(error);
      const status = error instanceof HttpError ? error.status : 500;
      return json({ error: status === 500 ? "internal_error" : "request_error", message: error.message }, status, request, env);
    }
  },

  async scheduled(_controller, env, context) {
    context.waitUntil(runScheduledSync(env));
  }
};

async function route(request, env, context) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/") {
    return json({ name: "Aggregation Arena API", status: "ok", docs: "/api/health" }, 200, request, env);
  }
  if (request.method === "GET" && url.pathname === "/api/health") return health(request, env);
  if (request.method === "GET" && url.pathname === "/api/markets") return listMarkets(request, env, url);
  if (request.method === "GET" && url.pathname === "/api/leaderboard") return leaderboard(request, env, url);
  if (request.method === "POST" && url.pathname === "/api/predictions") {
    requireAdmin(request, env);
    return acceptPrediction(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/aggregate") {
    requireAdmin(request, env);
    return aggregatePredictions(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/sync") {
    requireAdmin(request, env);
    context.waitUntil(runScheduledSync(env));
    return json({ accepted: true, message: "Sync queued" }, 202, request, env);
  }
  return json({ error: "not_found" }, 404, request, env);
}

async function health(request, env) {
  const latest = await env.DB.prepare("SELECT job, status, detail, finished_at FROM sync_runs ORDER BY id DESC LIMIT 1").first();
  const counts = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_markets,
      SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved_markets
    FROM events
  `).first();
  return json({
    status: "ok",
    source: "Polymarket Gamma API",
    open_markets: Number(counts?.open_markets || 0),
    resolved_markets: Number(counts?.resolved_markets || 0),
    latest_sync: latest || null
  }, 200, request, env);
}

async function listMarkets(request, env, url) {
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)));
  const rows = await env.DB.prepare(`
    SELECT e.*,
      (SELECT probability_yes FROM predictions p WHERE p.event_id = e.event_id AND p.participant_id = 'adaptive-logit-pool') AS ensemble_probability,
      (SELECT COUNT(*) FROM predictions p WHERE p.event_id = e.event_id AND p.participant_type = 'forecaster') AS forecaster_count
    FROM events e
    WHERE e.status = 'open'
    ORDER BY e.volume_24h DESC
    LIMIT ?
  `).bind(limit).all();
  return json({
    markets: rows.results.map(row => ({
      id: row.event_id,
      source: "Polymarket",
      title: row.title,
      description: row.description,
      category: row.category,
      outcomes: safeJson(row.outcomes_json, ["Yes", "No"]),
      price: row.market_probability,
      move_24h: row.price_change_24h,
      volume_24h: row.volume_24h,
      closes_at: row.closes_at,
      url: row.source_url,
      ensemble_probability: row.ensemble_probability,
      forecaster_count: Number(row.forecaster_count || 0)
    })),
    updated_at: new Date().toISOString()
  }, 200, request, env);
}

async function leaderboard(request, env, url) {
  const track = ["model", "market"].includes(url.searchParams.get("track")) ? url.searchParams.get("track") : "all";
  const resolved = await env.DB.prepare(`
    SELECT p.participant_id, p.participant_name, p.participant_type, p.track, p.probability_yes,
      p.version, p.event_id, e.resolved_outcome
    FROM predictions p JOIN events e ON e.event_id = p.event_id
    WHERE e.status = 'resolved' AND e.resolved_outcome IS NOT NULL
    ORDER BY p.participant_id, e.event_id
  `).all();

  const byParticipant = new Map();
  for (const row of resolved.results) {
    if (track !== "all" && row.track !== track) continue;
    const item = byParticipant.get(row.participant_id) || { ...row, losses: [], events: new Set() };
    item.losses.push(brier(row.probability_yes, row.resolved_outcome));
    item.events.add(row.event_id);
    byParticipant.set(row.participant_id, item);
  }

  const allResolvedCount = Number((await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE status = 'resolved'").first())?.count || 0);
  const participantEventLoss = new Map(resolved.results.map(row => [`${row.participant_id}:${row.event_id}`, brier(row.probability_yes, row.resolved_outcome)]));
  const rows = [...byParticipant.values()].map((item, index) => {
    const averageBrier = item.losses.reduce((sum, value) => sum + value, 0) / item.losses.length;
    const comparableMean = [...item.events].map(eventId => participantEventLoss.get(`equal-mean:${eventId}`)).filter(Number.isFinite);
    const comparableMarket = [...item.events].map(eventId => participantEventLoss.get(`polymarket:${eventId}`)).filter(Number.isFinite);
    const meanBrier = comparableMean.length ? comparableMean.reduce((a, b) => a + b, 0) / comparableMean.length : null;
    const marketBrier = comparableMarket.length ? comparableMarket.reduce((a, b) => a + b, 0) / comparableMarket.length : null;
    return {
      participant_id: item.participant_id,
      name: item.participant_name,
      type: item.participant_type,
      track: item.track,
      version: item.version,
      brier: averageBrier,
      index: (1 - averageBrier) * 100,
      vs_mean: meanBrier ? ((meanBrier - averageBrier) / meanBrier) * 100 : null,
      vs_market: marketBrier ? ((marketBrier - averageBrier) / marketBrier) * 100 : null,
      resolved: item.losses.length,
      coverage: allResolvedCount ? (item.losses.length / allResolvedCount) * 100 : 0,
      color: PARTICIPANT_COLORS[index % PARTICIPANT_COLORS.length]
    };
  }).sort((a, b) => a.brier - b.brier).map((row, index) => ({ rank: index + 1, ...row }));

  return json({
    leaderboard: rows,
    resolved_markets: allResolvedCount,
    provisional: allResolvedCount < 50,
    scoring: "binary_brier",
    updated_at: new Date().toISOString()
  }, 200, request, env);
}

async function acceptPrediction(request, env) {
  const payload = await request.json();
  const eventId = String(payload.event_id || payload.event_ticker || "");
  const participantId = slugify(payload.participant_id || payload.model_id || payload.forecaster_id || "");
  if (!eventId || !participantId) throw new HttpError(400, "event_id and participant_id are required");
  const event = await env.DB.prepare("SELECT * FROM events WHERE event_id = ?").bind(eventId).first();
  if (!event) throw new HttpError(404, "Unknown event_id");
  if (event.status !== "open" || (event.closes_at && Date.parse(event.closes_at) <= Date.now())) throw new HttpError(409, "Predictions are locked for this event");

  const probability = readYesProbability(payload);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new HttpError(400, "A Yes probability between 0 and 1 is required");
  await upsertPrediction(env, {
    event_id: eventId,
    participant_id: participantId,
    participant_name: String(payload.participant_name || payload.model_name || participantId),
    participant_type: "forecaster",
    track: "model",
    probability_yes: probability,
    rationale: payload.rationale || null,
    version: String(payload.model_version || payload.version || "v1"),
    components_json: null
  });
  const aggregates = await recomputeEventAggregates(env, eventId);
  return json({ accepted: true, event_id: eventId, probability_yes: probability, aggregates }, 201, request, env);
}

async function aggregatePredictions(request, env) {
  const payload = await request.json().catch(() => ({}));
  const eventId = String(payload.event_id || "");
  if (eventId) {
    const aggregates = await recomputeEventAggregates(env, eventId);
    return json({ event_id: eventId, aggregates }, 200, request, env);
  }
  const open = await env.DB.prepare("SELECT event_id FROM events WHERE status = 'open'").all();
  let count = 0;
  for (const row of open.results) count += (await recomputeEventAggregates(env, row.event_id)).length;
  return json({ events: open.results.length, aggregates_written: count }, 200, request, env);
}

async function runScheduledSync(env) {
  const started = new Date().toISOString();
  try {
    const active = await syncActiveMarkets(env);
    const forecasts = await callConfiguredForecaster(env);
    const resolved = await resolveClosedMarkets(env);
    await env.DB.prepare("INSERT INTO sync_runs (job, status, detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?)")
      .bind("scheduled-sync", "ok", JSON.stringify({ active, forecasts, resolved }), started, new Date().toISOString()).run();
  } catch (error) {
    console.error("Scheduled sync failed", error);
    await env.DB.prepare("INSERT INTO sync_runs (job, status, detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?)")
      .bind("scheduled-sync", "error", error.message, started, new Date().toISOString()).run();
  }
}

async function syncActiveMarkets(env) {
  const limit = Math.min(100, Math.max(5, Number(env.MAX_ACTIVE_MARKETS || 20)));
  const response = await fetch(`${GAMMA_API}/events?active=true&closed=false&limit=100`, {
    headers: { Accept: "application/json", "User-Agent": "AggregationArena/0.2" }
  });
  if (!response.ok) throw new Error(`Polymarket active sync returned ${response.status}`);
  const events = await response.json();
  const normalized = events.flatMap(event => (event.markets || []).map(market => normalizePolymarket(event, market)))
    .filter(Boolean)
    .sort((a, b) => b.volume_24h - a.volume_24h)
    .slice(0, limit);
  const now = new Date().toISOString();
  for (const row of normalized) {
    await env.DB.prepare(`
      INSERT INTO events (event_id, event_slug, market_slug, title, description, category, rules, outcomes_json, closes_at, status,
        market_probability, price_change_24h, volume_24h, source_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        market_probability = excluded.market_probability,
        price_change_24h = excluded.price_change_24h,
        volume_24h = excluded.volume_24h,
        source_url = excluded.source_url,
        updated_at = excluded.updated_at
    `).bind(row.event_id, row.event_slug, row.market_slug, row.title, row.description, row.category, row.rules,
      JSON.stringify(row.outcomes), row.closes_at, row.market_probability, row.price_change_24h, row.volume_24h, row.source_url, now, now).run();
    await upsertPrediction(env, {
      event_id: row.event_id,
      participant_id: "polymarket",
      participant_name: "Polymarket Midpoint",
      participant_type: "market",
      track: "market",
      probability_yes: row.market_probability,
      rationale: "Frozen Polymarket probability at first ingestion",
      version: "snapshot-v1",
      components_json: null,
      insert_only: true
    });
  }
  return normalized.length;
}

async function callConfiguredForecaster(env) {
  if (!env.FORECAST_ENDPOINT || !env.FORECASTER_ID) return 0;
  const pending = await env.DB.prepare(`
    SELECT e.* FROM events e
    WHERE e.status = 'open' AND NOT EXISTS (
      SELECT 1 FROM predictions p WHERE p.event_id = e.event_id AND p.participant_id = ?
    ) ORDER BY e.volume_24h DESC LIMIT 10
  `).bind(slugify(env.FORECASTER_ID)).all();
  let accepted = 0;
  for (const event of pending.results) {
    try {
      const response = await fetch(env.FORECAST_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.FORECAST_API_TOKEN ? { Authorization: `Bearer ${env.FORECAST_API_TOKEN}` } : {})
        },
        body: JSON.stringify({
          event_ticker: event.event_id,
          market_ticker: event.event_id,
          title: event.title,
          description: event.description,
          category: event.category,
          rules: event.rules,
          close_time: event.closes_at,
          outcomes: safeJson(event.outcomes_json, ["Yes", "No"]),
          resolved_outcome: null
        })
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const probability = readYesProbability(payload);
      if (!Number.isFinite(probability)) continue;
      await upsertPrediction(env, {
        event_id: event.event_id,
        participant_id: slugify(env.FORECASTER_ID),
        participant_name: env.FORECASTER_NAME || env.FORECASTER_ID,
        participant_type: "forecaster",
        track: "model",
        probability_yes: probability,
        rationale: payload.rationale || null,
        version: payload.model_version || env.FORECASTER_VERSION || "v1",
        components_json: null
      });
      await recomputeEventAggregates(env, event.event_id);
      accepted += 1;
    } catch (error) {
      console.warn("Forecast endpoint failed", event.event_id, error.message);
    }
  }
  return accepted;
}

async function resolveClosedMarkets(env) {
  const candidates = await env.DB.prepare(`
    SELECT event_id FROM events
    WHERE status = 'open' AND closes_at IS NOT NULL AND datetime(closes_at) <= datetime('now')
    ORDER BY closes_at LIMIT 30
  `).all();
  let resolved = 0;
  for (const row of candidates.results) {
    const response = await fetch(`${GAMMA_API}/markets/${encodeURIComponent(row.event_id)}`, { headers: { Accept: "application/json" } });
    if (!response.ok) continue;
    const market = await response.json();
    const prices = parseList(market.outcomePrices).map(Number);
    const outcomes = parseList(market.outcomes);
    const yesIndex = outcomes.findIndex(value => String(value).toLowerCase() === "yes");
    const yes = prices[yesIndex];
    if (market.closed && (yes >= 0.999 || yes <= 0.001)) {
      await env.DB.prepare("UPDATE events SET status = 'resolved', resolved_outcome = ?, resolved_at = ?, updated_at = ? WHERE event_id = ?")
        .bind(yes >= 0.999 ? 1 : 0, new Date().toISOString(), new Date().toISOString(), row.event_id).run();
      resolved += 1;
    } else if (market.closed) {
      await env.DB.prepare("UPDATE events SET status = 'closed', updated_at = ? WHERE event_id = ?").bind(new Date().toISOString(), row.event_id).run();
    }
  }
  return resolved;
}

async function recomputeEventAggregates(env, eventId) {
  const event = await env.DB.prepare("SELECT event_id, status, closes_at, market_probability FROM events WHERE event_id = ?").bind(eventId).first();
  if (!event || event.status !== "open" || (event.closes_at && Date.parse(event.closes_at) <= Date.now())) return [];
  const forecasts = await env.DB.prepare(`
    SELECT participant_id, probability_yes FROM predictions
    WHERE event_id = ? AND participant_type = 'forecaster'
    ORDER BY participant_id
  `).bind(eventId).all();
  if (!forecasts.results.length) return [];
  const weights = await performanceWeights(env, forecasts.results.map(row => row.participant_id));
  const aggregates = buildAggregates(forecasts.results, event.market_probability, weights);
  for (const row of aggregates) await upsertPrediction(env, { event_id: eventId, participant_type: "aggregator", rationale: null, ...row });
  return aggregates;
}

async function performanceWeights(env, participantIds) {
  const weights = {};
  for (const id of participantIds) {
    const rows = await env.DB.prepare(`
      SELECT p.probability_yes, e.resolved_outcome
      FROM predictions p JOIN events e ON e.event_id = p.event_id
      WHERE p.participant_id = ? AND e.status = 'resolved'
    `).bind(id).all();
    const losses = rows.results.map(row => brier(row.probability_yes, row.resolved_outcome));
    const average = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0.25;
    weights[id] = 1 / Math.max(0.02, average);
  }
  return weights;
}

async function upsertPrediction(env, row) {
  const now = new Date().toISOString();
  const conflict = row.insert_only ? "DO NOTHING" : `DO UPDATE SET
    participant_name = excluded.participant_name,
    probability_yes = excluded.probability_yes,
    rationale = excluded.rationale,
    version = excluded.version,
    components_json = excluded.components_json,
    forecasted_at = excluded.forecasted_at`;
  await env.DB.prepare(`
    INSERT INTO predictions (event_id, participant_id, participant_name, participant_type, track, probability_yes, rationale, version, components_json, forecasted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id, participant_id) ${conflict}
  `).bind(row.event_id, row.participant_id, row.participant_name, row.participant_type, row.track || "model",
    Number(row.probability_yes), row.rationale || null, row.version || "v1", row.components_json || null, now).run();
}

function normalizePolymarket(event, market) {
  if (market.active === false || market.closed === true || market.acceptingOrders === false) return null;
  const outcomes = parseList(market.outcomes);
  if (outcomes.length !== 2 || !outcomes.some(value => String(value).toLowerCase() === "yes")) return null;
  const prices = parseList(market.outcomePrices).map(Number);
  const yesIndex = outcomes.findIndex(value => String(value).toLowerCase() === "yes");
  const probability = Number(prices[yesIndex]);
  if (!Number.isFinite(probability)) return null;
  return {
    event_id: String(market.id),
    event_slug: event.slug || null,
    market_slug: market.slug || null,
    title: market.question || event.title,
    description: market.description || event.description || "",
    rules: market.resolutionSource || event.resolutionSource || "",
    outcomes,
    category: inferCategory(event, market),
    closes_at: market.endDate || event.endDate || null,
    market_probability: probability,
    price_change_24h: Number(market.oneDayPriceChange || 0),
    volume_24h: Number(market.volume24hr || event.volume24hr || market.volume || 0),
    source_url: `https://polymarket.com/event/${encodeURIComponent(event.slug || market.slug || "")}`
  };
}

function inferCategory(event, market) {
  const text = `${event.category || ""} ${event.title || ""} ${market.question || ""} ${(event.tags || []).map(tag => tag.label || "").join(" ")}`.toLowerCase();
  if (/sport|nba|nfl|mlb|nhl|soccer|football|tennis|cricket|ufc|formula/.test(text)) return "Sports";
  if (/ai|tech|bitcoin|crypto|ethereum|software|spacex|apple|google|openai/.test(text)) return "Technology";
  if (/election|president|congress|senate|minister|party|politic|war|ceasefire/.test(text)) return "Politics";
  return "Economics";
}

function readYesProbability(payload) {
  if (Number.isFinite(Number(payload.probability_yes))) return Number(payload.probability_yes);
  if (payload.probabilities && !Array.isArray(payload.probabilities) && Number.isFinite(Number(payload.probabilities.Yes))) return Number(payload.probabilities.Yes);
  const item = Array.isArray(payload.probabilities) ? payload.probabilities.find(row => String(row.market || row.outcome).toLowerCase() === "yes") : null;
  return item ? Number(item.probability) : NaN;
}

function parseList(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || "[]"); } catch { return []; }
}

function safeJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function slugify(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function requireAdmin(request, env) {
  if (!env.AGGREGATION_API_TOKEN) throw new HttpError(503, "AGGREGATION_API_TOKEN is not configured");
  if (request.headers.get("Authorization") !== `Bearer ${env.AGGREGATION_API_TOKEN}`) throw new HttpError(401, "Unauthorized");
}

function corsHeaders(request, env) {
  const requestOrigin = request.headers.get("Origin");
  const configured = env.ALLOWED_ORIGIN || "*";
  const allowed = configured === "*" || requestOrigin === configured ? (requestOrigin || configured) : configured;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
    "Cache-Control": "no-store"
  };
}

function json(payload, status, request, env) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(request, env) } });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
