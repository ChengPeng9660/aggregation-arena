export async function lockEvent(
  db: D1Database,
  options: {
    eventId: string;
    reason: string;
    actor: string;
    detail?: Record<string, unknown>;
    lockedAt?: string;
  },
) {
  const lockedAt = options.lockedAt || new Date().toISOString();
  const result = await db.prepare(`
    UPDATE events
    SET status='locked', locked_at=COALESCE(locked_at, ?), lock_reason=?, updated_at=?
    WHERE id=? AND status='open'
  `).bind(lockedAt, options.reason, lockedAt, options.eventId).run();
  if (!Number(result.meta.changes || 0)) return false;

  await db.prepare(`
    INSERT INTO audit_log (action, entity_type, entity_id, detail_json, actor, created_at)
    VALUES ('curation.event_locked', 'event', ?, ?, ?, ?)
  `).bind(
    options.eventId,
    JSON.stringify({ reason: options.reason, ...(options.detail || {}) }),
    options.actor,
    lockedAt,
  ).run();
  return true;
}
