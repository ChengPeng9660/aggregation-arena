CREATE TABLE `curation_sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text NOT NULL,
	`fetched_events` integer DEFAULT 0 NOT NULL,
	`fetched_markets` integer DEFAULT 0 NOT NULL,
	`eligible_markets` integer DEFAULT 0 NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `market_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`market_id` text NOT NULL,
	`captured_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`yes_price` real NOT NULL,
	`volume_24h` real NOT NULL,
	`total_volume` real NOT NULL,
	`liquidity` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `polymarket_candidates` (
	`market_id` text PRIMARY KEY NOT NULL,
	`source_event_id` text NOT NULL,
	`event_slug` text DEFAULT '' NOT NULL,
	`market_slug` text DEFAULT '' NOT NULL,
	`series_id` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`rules` text DEFAULT '' NOT NULL,
	`category` text NOT NULL,
	`category_confidence` real DEFAULT 0 NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`outcomes_json` text DEFAULT '[]' NOT NULL,
	`close_time` text,
	`start_time` text,
	`yes_price` real DEFAULT 0 NOT NULL,
	`volume_24h` real DEFAULT 0 NOT NULL,
	`total_volume` real DEFAULT 0 NOT NULL,
	`liquidity` real DEFAULT 0 NOT NULL,
	`volume_percentile` real DEFAULT 0 NOT NULL,
	`selection_score` real DEFAULT 0 NOT NULL,
	`eligible` integer DEFAULT 0 NOT NULL,
	`rejection_reasons_json` text DEFAULT '[]' NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`raw_json` text DEFAULT '{}' NOT NULL,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `selection_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`market_id` text NOT NULL,
	`event_id` text NOT NULL,
	`category` text NOT NULL,
	`rank` integer NOT NULL,
	`selection_score` real NOT NULL,
	`price_at_selection` real NOT NULL,
	`volume_24h` real NOT NULL,
	`total_volume` real NOT NULL,
	`liquidity` real NOT NULL,
	`selected_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `selection_items_market_unique` ON `selection_items` (`market_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `selection_items_run_market_unique` ON `selection_items` (`run_id`,`market_id`);--> statement-breakpoint
CREATE TABLE `selection_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`config_version` text NOT NULL,
	`taxonomy_version` text NOT NULL,
	`status` text NOT NULL,
	`candidate_count` integer DEFAULT 0 NOT NULL,
	`eligible_count` integer DEFAULT 0 NOT NULL,
	`selected_count` integer DEFAULT 0 NOT NULL,
	`category_counts_json` text DEFAULT '{}' NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
