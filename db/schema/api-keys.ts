import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "@/db/schema/auth";

// Caller identity for the public API — a third auth mode beside agent sessions
// and customer ticket tokens. The raw key is shown once at creation and never
// stored; only a sha256 hash (lookup) and a short prefix (display) persist.
export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  createdById: text("created_by_id").references(() => user.id, {
    onDelete: "set null",
  }),
  createdByName: text("created_by_name").notNull(),
  // Optional URL template for tickets created through this key, e.g.
  // "https://myapp.com/support/{{ticketId}}?token={{token}}", pointing emails and
  // API responses at the integrator's own page. Null = the default /ticket/:id.
  portalUrlTemplate: text("portal_url_template"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  // Soft revoke — the row stays for audit history (tickets.apiKeyId keeps
  // resolving) instead of being deleted.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
