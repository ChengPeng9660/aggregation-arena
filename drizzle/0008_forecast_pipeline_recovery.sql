-- Generated from db/schema.ts with Drizzle; idempotent with runtime bootstrap.
CREATE TABLE IF NOT EXISTS `forecast_batch_lease` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`acquired_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_model_forecast_participant_version
  ON model_forecast_runs(event_id, participant_id, prompt_version, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_model_forecast_created
  ON model_forecast_runs(created_at DESC, id DESC);
--> statement-breakpoint

-- Enforce the existing admission rule atomically with forecast publication.
CREATE TRIGGER IF NOT EXISTS guard_predictions_insert_admission
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
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS guard_predictions_update_admission
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
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS guard_prediction_outcomes_insert_admission
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
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS guard_prediction_outcomes_update_admission
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
END;
