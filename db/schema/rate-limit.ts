import { createId } from "@paralleldrive/cuid2";
import { integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// Fixed-window request counters throttling public, unauthenticated routes: one
// row per (bucketKey, windowStart), incremented by upsert. Postgres-backed, not
// in-memory, so limits hold across restarts and multi-process deployments —
// Postgres is already this app's shared store (see pg-boss).
export const rateLimitHits = pgTable(
  "rate_limit_hits",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    bucketKey: text("bucket_key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(1),
  },
  (t) => [
    uniqueIndex("rate_limit_hits_bucket_window_idx").on(t.bucketKey, t.windowStart),
  ]
);
