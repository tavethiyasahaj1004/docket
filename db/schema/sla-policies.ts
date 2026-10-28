import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Admin-configurable SLA targets, optionally scoped to a priority and/or
// category slug (null means "any"). Most-specific-wins precedence lives in
// lib/sla-policies.ts. Exactly one row should be is_default with both scopes
// null — enforced at the API layer, as with ticket_priorities.is_default.
export const slaPolicies = pgTable("sla_policies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  priority: text("priority"),
  category: text("category"),
  firstResponseMinutes: integer("first_response_minutes").notNull(),
  nextResponseMinutes: integer("next_response_minutes").notNull(),
  resolutionMinutes: integer("resolution_minutes").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
