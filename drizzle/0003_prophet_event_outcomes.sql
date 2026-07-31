ALTER TABLE `events` ADD COLUMN `event_type` text DEFAULT 'binary' NOT NULL;
--> statement-breakpoint
ALTER TABLE `events` ADD COLUMN `source_event_id` text;
--> statement-breakpoint
ALTER TABLE `events` ADD COLUMN `outcomes_json` text DEFAULT '["Yes","No"]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `events` ADD COLUMN `resolved_outcome` text;
--> statement-breakpoint
ALTER TABLE `polymarket_candidates` ADD COLUMN `event_title` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `polymarket_candidates` ADD COLUMN `event_neg_risk` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `polymarket_candidates` ADD COLUMN `event_neg_risk_augmented` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `model_forecast_runs` ADD COLUMN `probabilities_json` text;
--> statement-breakpoint
CREATE TABLE `event_outcomes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`outcome_key` text NOT NULL,
	`label` text NOT NULL,
	`market_id` text,
	`source_url` text DEFAULT '' NOT NULL,
	`price_at_selection` real DEFAULT 0 NOT NULL,
	`volume_24h` real DEFAULT 0 NOT NULL,
	`total_volume` real DEFAULT 0 NOT NULL,
	`liquidity` real DEFAULT 0 NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_outcomes_event_key_unique` ON `event_outcomes` (`event_id`,`outcome_key`);
--> statement-breakpoint
CREATE INDEX `event_outcomes_market_idx` ON `event_outcomes` (`market_id`);
--> statement-breakpoint
CREATE TABLE `prediction_outcomes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`participant_name` text NOT NULL,
	`kind` text NOT NULL,
	`outcome_key` text NOT NULL,
	`probability` real NOT NULL,
	`rationale` text,
	`version` text DEFAULT 'v1' NOT NULL,
	`components_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prediction_outcomes_current_unique` ON `prediction_outcomes` (`event_id`,`participant_id`,`outcome_key`);
--> statement-breakpoint
CREATE INDEX `prediction_outcomes_event_idx` ON `prediction_outcomes` (`event_id`,`kind`);
--> statement-breakpoint
CREATE TABLE `prediction_outcome_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`participant_name` text NOT NULL,
	`kind` text NOT NULL,
	`outcome_key` text NOT NULL,
	`probability` real NOT NULL,
	`rationale` text,
	`version` text DEFAULT 'v1' NOT NULL,
	`components_json` text,
	`recorded_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `prediction_outcome_history_event_idx` ON `prediction_outcome_history` (`event_id`,`recorded_at`);
