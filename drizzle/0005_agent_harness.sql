CREATE TABLE IF NOT EXISTS `aggregation_harness_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`method_id` text NOT NULL,
	`method_version` text NOT NULL,
	`information_set` text NOT NULL,
	`input_as_of_time` text NOT NULL,
	`input_snapshot_json` text NOT NULL,
	`input_hash` text NOT NULL,
	`component_map_json` text NOT NULL,
	`model_id` text NOT NULL,
	`prompt_version` text NOT NULL,
	`status` text NOT NULL,
	`weights_json` text,
	`final_weights_json` text,
	`probabilities_json` text,
	`rationale` text,
	`raw_response` text,
	`fallback_reason` text,
	`latency_ms` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `aggregation_harness_event_method_version_unique`
ON `aggregation_harness_runs` (`event_id`,`method_id`,`method_version`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_harness_runs_event`
ON `aggregation_harness_runs` (`event_id`,`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_harness_runs_method`
ON `aggregation_harness_runs` (`method_id`,`status`,`completed_at`);
