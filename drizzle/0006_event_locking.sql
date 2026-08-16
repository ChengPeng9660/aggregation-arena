ALTER TABLE `events` ADD `locked_at` text;
--> statement-breakpoint
ALTER TABLE `events` ADD `lock_reason` text;
--> statement-breakpoint
UPDATE `events`
SET `status`='locked',
    `locked_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    `lock_reason`='scheduled_close_backfill',
    `updated_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE `status`='open'
  AND `close_time` IS NOT NULL
  AND datetime(`close_time`) <= datetime('now');
