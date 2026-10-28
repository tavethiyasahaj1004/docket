import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Admin-editable overrides for the customer-facing notification emails, one row
// per type created on first save — an absent row or null column means "use the
// built-in default". `body` is Tiptap JSON, as elsewhere, so the existing
// rich-text editor and renderer are reused as-is.
export const emailTemplates = pgTable("email_templates", {
  id: text("id").primaryKey(),
  type: text("type").notNull().unique(),
  subject: text("subject"),
  body: text("body"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
