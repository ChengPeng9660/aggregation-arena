import { desc, sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const participants = sqliteTable("participants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  organization: text("organization").notNull().default("Independent"),
  kind: text("kind").notNull().default("forecaster"),
  color: text("color").notNull().default("#7c4dff"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  category: text("category").notNull().default("Entertainment"),
  season: text("season").notNull().default("Season 1"),
  closeTime: text("close_time"),
  status: text("status").notNull().default("open"),
  resolution: integer("resolution"),
  resolutionNote: text("resolution_note"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  resolvedAt: text("resolved_at"),
  lockedAt: text("locked_at"),
  lockReason: text("lock_reason"),
  eventType: text("event_type").notNull().default("binary"),
  sourceEventId: text("source_event_id"),
  outcomesJson: text("outcomes_json").notNull().default('["Yes","No"]'),
  resolvedOutcome: text("resolved_outcome"),
});

export const predictions = sqliteTable(
  "predictions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    participantId: text("participant_id").notNull(),
    participantName: text("participant_name").notNull(),
    kind: text("kind").notNull(),
    probability: real("probability").notNull(),
    rationale: text("rationale"),
    version: text("version").notNull().default("v1"),
    componentsJson: text("components_json"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("predictions_event_participant").on(table.eventId, table.participantId)],
);

export const predictionHistory = sqliteTable("prediction_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: text("event_id").notNull(),
  participantId: text("participant_id").notNull(),
  participantName: text("participant_name").notNull(),
  kind: text("kind").notNull(),
  probability: real("probability").notNull(),
  rationale: text("rationale"),
  version: text("version").notNull().default("v1"),
  componentsJson: text("components_json"),
  recordedAt: text("recorded_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  detailJson: text("detail_json"),
  actor: text("actor").notNull().default("local-admin"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const polymarketCandidates = sqliteTable("polymarket_candidates", {
  marketId: text("market_id").primaryKey(),
  sourceEventId: text("source_event_id").notNull(),
  eventSlug: text("event_slug").notNull().default(""),
  marketSlug: text("market_slug").notNull().default(""),
  seriesId: text("series_id").notNull().default(""),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  rules: text("rules").notNull().default(""),
  category: text("category").notNull(),
  categoryConfidence: real("category_confidence").notNull().default(0),
  tagsJson: text("tags_json").notNull().default("[]"),
  outcomesJson: text("outcomes_json").notNull().default("[]"),
  closeTime: text("close_time"),
  startTime: text("start_time"),
  yesPrice: real("yes_price").notNull().default(0),
  volume24h: real("volume_24h").notNull().default(0),
  totalVolume: real("total_volume").notNull().default(0),
  liquidity: real("liquidity").notNull().default(0),
  volumePercentile: real("volume_percentile").notNull().default(0),
  selectionScore: real("selection_score").notNull().default(0),
  eligible: integer("eligible").notNull().default(0),
  rejectionReasonsJson: text("rejection_reasons_json").notNull().default("[]"),
  sourceUrl: text("source_url").notNull().default(""),
  rawJson: text("raw_json").notNull().default("{}"),
  firstSeenAt: text("first_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  eventTitle: text("event_title").notNull().default(""),
  eventNegRisk: integer("event_neg_risk").notNull().default(0),
  eventNegRiskAugmented: integer("event_neg_risk_augmented").notNull().default(0),
});

export const marketSnapshots = sqliteTable("market_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  marketId: text("market_id").notNull(),
  capturedAt: text("captured_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  yesPrice: real("yes_price").notNull(),
  volume24h: real("volume_24h").notNull(),
  totalVolume: real("total_volume").notNull(),
  liquidity: real("liquidity").notNull(),
});

export const curationSyncRuns = sqliteTable("curation_sync_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  status: text("status").notNull(),
  fetchedEvents: integer("fetched_events").notNull().default(0),
  fetchedMarkets: integer("fetched_markets").notNull().default(0),
  eligibleMarkets: integer("eligible_markets").notNull().default(0),
  detailJson: text("detail_json").notNull().default("{}"),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
});

export const selectionRuns = sqliteTable("selection_runs", {
  id: text("id").primaryKey(),
  configVersion: text("config_version").notNull(),
  taxonomyVersion: text("taxonomy_version").notNull(),
  status: text("status").notNull(),
  candidateCount: integer("candidate_count").notNull().default(0),
  eligibleCount: integer("eligible_count").notNull().default(0),
  selectedCount: integer("selected_count").notNull().default(0),
  categoryCountsJson: text("category_counts_json").notNull().default("{}"),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
});

export const selectionItems = sqliteTable(
  "selection_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    marketId: text("market_id").notNull(),
    eventId: text("event_id").notNull(),
    category: text("category").notNull(),
    rank: integer("rank").notNull(),
    selectionScore: real("selection_score").notNull(),
    priceAtSelection: real("price_at_selection").notNull(),
    volume24h: real("volume_24h").notNull(),
    totalVolume: real("total_volume").notNull(),
    liquidity: real("liquidity").notNull(),
    selectedAt: text("selected_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("selection_items_market_unique").on(table.marketId),
    uniqueIndex("selection_items_run_market_unique").on(table.runId, table.marketId),
  ],
);

export const researchContexts = sqliteTable(
  "research_contexts",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    selectionRunId: text("selection_run_id").notNull(),
    provider: text("provider").notNull(),
    searchQuery: text("search_query").notNull(),
    searchPromptVersion: text("search_prompt_version").notNull(),
    sourcesJson: text("sources_json").notNull(),
    marketSnapshotJson: text("market_snapshot_json").notNull(),
    sourceCount: integer("source_count").notNull().default(0),
    status: text("status").notNull().default("ready"),
    error: text("error"),
    asOfTime: text("as_of_time").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("research_context_event_version_unique").on(table.eventId, table.searchPromptVersion)],
);

export const forecastBatchLease = sqliteTable("forecast_batch_lease", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  acquiredAt: text("acquired_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const modelForecastRuns = sqliteTable(
  "model_forecast_runs",
  {
    id: text("id").primaryKey(),
    contextId: text("context_id").notNull(),
    eventId: text("event_id").notNull(),
    participantId: text("participant_id").notNull(),
    modelId: text("model_id").notNull(),
    promptVersion: text("prompt_version").notNull(),
    status: text("status").notNull(),
    yesProbability: real("yes_probability"),
    noProbability: real("no_probability"),
    rationale: text("rationale"),
    citedSourcesJson: text("cited_sources_json").notNull().default("[]"),
    rawResponse: text("raw_response"),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
    probabilitiesJson: text("probabilities_json"),
  },
  (table) => [
    uniqueIndex("model_forecast_context_participant_unique").on(table.contextId, table.participantId),
    index("idx_model_forecast_participant_version").on(table.eventId, table.participantId, table.promptVersion, desc(table.createdAt), desc(table.id)),
    index("idx_model_forecast_created").on(desc(table.createdAt), desc(table.id)),
  ],
);

export const aggregationHarnessRuns = sqliteTable(
  "aggregation_harness_runs",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    methodId: text("method_id").notNull(),
    methodVersion: text("method_version").notNull(),
    informationSet: text("information_set").notNull(),
    inputAsOfTime: text("input_as_of_time").notNull(),
    inputSnapshotJson: text("input_snapshot_json").notNull(),
    inputHash: text("input_hash").notNull(),
    componentMapJson: text("component_map_json").notNull(),
    modelId: text("model_id").notNull(),
    promptVersion: text("prompt_version").notNull(),
    status: text("status").notNull(),
    weightsJson: text("weights_json"),
    finalWeightsJson: text("final_weights_json"),
    probabilitiesJson: text("probabilities_json"),
    rationale: text("rationale"),
    rawResponse: text("raw_response"),
    fallbackReason: text("fallback_reason"),
    latencyMs: integer("latency_ms"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("aggregation_harness_event_method_version_unique")
      .on(table.eventId, table.methodId, table.methodVersion),
  ],
);

export const eventOutcomes = sqliteTable(
  "event_outcomes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    outcomeKey: text("outcome_key").notNull(),
    label: text("label").notNull(),
    marketId: text("market_id"),
    sourceUrl: text("source_url").notNull().default(""),
    priceAtSelection: real("price_at_selection").notNull().default(0),
    volume24h: real("volume_24h").notNull().default(0),
    totalVolume: real("total_volume").notNull().default(0),
    liquidity: real("liquidity").notNull().default(0),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("event_outcomes_event_key_unique").on(table.eventId, table.outcomeKey)],
);

export const predictionOutcomes = sqliteTable(
  "prediction_outcomes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    participantId: text("participant_id").notNull(),
    participantName: text("participant_name").notNull(),
    kind: text("kind").notNull(),
    outcomeKey: text("outcome_key").notNull(),
    probability: real("probability").notNull(),
    rationale: text("rationale"),
    version: text("version").notNull().default("v1"),
    componentsJson: text("components_json"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("prediction_outcomes_current_unique").on(table.eventId, table.participantId, table.outcomeKey)],
);

export const predictionOutcomeHistory = sqliteTable("prediction_outcome_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: text("event_id").notNull(),
  participantId: text("participant_id").notNull(),
  participantName: text("participant_name").notNull(),
  kind: text("kind").notNull(),
  outcomeKey: text("outcome_key").notNull(),
  probability: real("probability").notNull(),
  rationale: text("rationale"),
  version: text("version").notNull().default("v1"),
  componentsJson: text("components_json"),
  recordedAt: text("recorded_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
