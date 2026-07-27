import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  category: text("category").notNull().default("General"),
  season: text("season").notNull().default("Season 1"),
  closeTime: text("close_time"),
  status: text("status").notNull().default("open"),
  resolution: integer("resolution"),
  resolutionNote: text("resolution_note"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  resolvedAt: text("resolved_at"),
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
