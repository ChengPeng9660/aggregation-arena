INSERT INTO `audit_log` (`action`, `entity_type`, `entity_id`, `detail_json`, `actor`, `created_at`)
SELECT
  'curation.event_locked',
  'event',
  `events`.`id`,
  json_object(
    'reason', `events`.`lock_reason`,
    'scheduledCloseTime', `events`.`close_time`,
    'detectedBy', 'event_locking_migration'
  ),
  'market-curation-migration',
  `events`.`locked_at`
FROM `events`
WHERE `events`.`status`='locked'
  AND `events`.`lock_reason`='scheduled_close_backfill'
  AND NOT EXISTS (
    SELECT 1 FROM `audit_log`
    WHERE `audit_log`.`action`='curation.event_locked'
      AND `audit_log`.`entity_id`=`events`.`id`
  );
