CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`detail_json` text,
	`actor` text DEFAULT 'local-admin' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`category` text DEFAULT 'General' NOT NULL,
	`season` text DEFAULT 'Season 1' NOT NULL,
	`close_time` text,
	`status` text DEFAULT 'open' NOT NULL,
	`resolution` integer,
	`resolution_note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE TABLE `participants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`organization` text DEFAULT 'Independent' NOT NULL,
	`kind` text DEFAULT 'forecaster' NOT NULL,
	`color` text DEFAULT '#7c4dff' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prediction_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`participant_name` text NOT NULL,
	`kind` text NOT NULL,
	`probability` real NOT NULL,
	`rationale` text,
	`version` text DEFAULT 'v1' NOT NULL,
	`components_json` text,
	`recorded_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `predictions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`participant_name` text NOT NULL,
	`kind` text NOT NULL,
	`probability` real NOT NULL,
	`rationale` text,
	`version` text DEFAULT 'v1' NOT NULL,
	`components_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `predictions_event_participant` ON `predictions` (`event_id`,`participant_id`);