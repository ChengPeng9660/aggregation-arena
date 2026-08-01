UPDATE polymarket_candidates
SET category = CASE
  WHEN lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*sports*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*football*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*basketball*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*tennis*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*soccer*' THEN 'Sports'
  WHEN lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*election*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*president*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*congress*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*parliament*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*war*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*ceasefire*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*politic*' THEN 'Politics'
  WHEN lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*science*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*health*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*disease*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*vaccine*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*clinical trial*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*space*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*nasa*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*technology*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*artificial intelligence*'
    OR lower(title || ' ' || event_title || ' ' || tags_json) GLOB '*ai model*' THEN 'Science'
  WHEN category IN ('Economics', 'Finance & Crypto', 'Business & Technology') THEN 'Economics'
  WHEN category IN ('Politics & Policy') THEN 'Politics'
  WHEN category IN ('Science & Health') THEN 'Science'
  WHEN category = 'Sports' THEN 'Sports'
  ELSE 'Entertainment'
END;
--> statement-breakpoint
UPDATE events
SET category = CASE
  WHEN category IN ('Politics', 'Politics & Policy', 'Policy') THEN 'Politics'
  WHEN category IN ('Economics', 'Finance & Crypto', 'Business & Technology', 'Business', 'Markets', 'Finance') THEN 'Economics'
  WHEN category IN ('Science', 'Science & Health', 'Technology', 'Health') THEN 'Science'
  WHEN category = 'Sports' THEN 'Sports'
  ELSE 'Entertainment'
END;
--> statement-breakpoint
UPDATE selection_items
SET category = COALESCE((SELECT category FROM events WHERE events.id=selection_items.event_id), 'Entertainment');
--> statement-breakpoint
UPDATE selection_runs
SET category_counts_json = json_object(
  'Politics', (SELECT COUNT(*) FROM selection_items WHERE selection_items.run_id=selection_runs.id AND category='Politics'),
  'Economics', (SELECT COUNT(*) FROM selection_items WHERE selection_items.run_id=selection_runs.id AND category='Economics'),
  'Science', (SELECT COUNT(*) FROM selection_items WHERE selection_items.run_id=selection_runs.id AND category='Science'),
  'Sports', (SELECT COUNT(*) FROM selection_items WHERE selection_items.run_id=selection_runs.id AND category='Sports'),
  'Entertainment', (SELECT COUNT(*) FROM selection_items WHERE selection_items.run_id=selection_runs.id AND category='Entertainment')
);
