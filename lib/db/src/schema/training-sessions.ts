import { pgTable, uuid, text, integer, real, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// One row per completed Social Styles practice call. Captures the inputs the
// consultant chose (persona/style, intensity, self-reflection), the scored
// outcome, and the full transcript so we can run analytics later. No PII
// beyond what the user typed into the self-reflection note.
export const trainingSessionsTable = pgTable("training_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

  // What the user practiced against.
  style: text("style").notNull(),
  intensity: text("intensity").notNull(),

  // Pre-call self reflection (optional — user may skip).
  selfReportedStyle: text("self_reported_style"),
  selfNote: text("self_note"),

  // Scored outcome.
  tier: text("tier").notNull(),
  userTurns: integer("user_turns").notNull(),
  avgWords: real("avg_words"),
  hits: jsonb("hits").$type<string[]>().notNull().default([]),

  // Session metadata.
  durationMs: integer("duration_ms"),
  clientSessionId: text("client_session_id"),

  // Full transcript: array of { role, text, done }.
  transcript: jsonb("transcript")
    .$type<{ role: "user" | "assistant"; text: string; done: boolean }[]>()
    .notNull()
    .default([]),
});

export const insertTrainingSessionSchema = createInsertSchema(trainingSessionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertTrainingSession = z.infer<typeof insertTrainingSessionSchema>;
export type TrainingSession = typeof trainingSessionsTable.$inferSelect;
