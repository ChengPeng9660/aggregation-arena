CREATE TABLE `model_forecast_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`context_id` text NOT NULL,
	`event_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`model_id` text NOT NULL,
	`prompt_version` text NOT NULL,
	`status` text NOT NULL,
	`yes_probability` real,
	`no_probability` real,
	`rationale` text,
	`cited_sources_json` text DEFAULT '[]' NOT NULL,
	`raw_response` text,
	`latency_ms` integer,
	`error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_forecast_context_participant_unique` ON `model_forecast_runs` (`context_id`,`participant_id`);--> statement-breakpoint
CREATE TABLE `research_contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`selection_run_id` text NOT NULL,
	`provider` text NOT NULL,
	`search_query` text NOT NULL,
	`search_prompt_version` text NOT NULL,
	`sources_json` text NOT NULL,
	`market_snapshot_json` text NOT NULL,
	`source_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`error` text,
	`as_of_time` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_context_event_version_unique` ON `research_contexts` (`event_id`,`search_prompt_version`);