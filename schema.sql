PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  event_slug TEXT,
  market_slug TEXT,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'Other',
  rules TEXT,
  outcomes_json TEXT NOT NULL DEFAULT '["Yes","No"]',
  closes_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','resolved','invalid')),
  resolved_outcome INTEGER CHECK (resolved_outcome IN (0,1) OR resolved_outcome IS NULL),
  market_probability REAL CHECK (market_probability BETWEEN 0 AND 1),
  price_change_24h REAL,
  volume_24h REAL NOT NULL DEFAULT 0,
  source_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES events(event_id),
  participant_id TEXT NOT NULL,
  participant_name TEXT NOT NULL,
  participant_type TEXT NOT NULL CHECK (participant_type IN ('forecaster','aggregator','market')),
  track TEXT NOT NULL DEFAULT 'model' CHECK (track IN ('model','market')),
  probability_yes REAL NOT NULL CHECK (probability_yes BETWEEN 0 AND 1),
  rationale TEXT,
  version TEXT NOT NULL DEFAULT 'v1',
  components_json TEXT,
  forecasted_at TEXT NOT NULL,
  locked_at TEXT,
  UNIQUE(event_id, participant_id)
);

CREATE INDEX IF NOT EXISTS idx_events_status_volume ON events(status, volume_24h DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_participant ON predictions(participant_id, event_id);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
