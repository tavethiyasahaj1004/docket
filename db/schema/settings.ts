import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const platformSettings = pgTable("platform_settings", {
  id: text("id").primaryKey().default("default"),
  theme: text("theme").notNull().default("default"),
  appearanceMode: text("appearance_mode").notNull().default("auto"),
  // White-label branding — null means "use the PRODUCT_NAME/wordmark default".
  brandName: text("brand_name"),
  logoKey: text("logo_key"),
  // Square icon-only mark for the browser tab — a full logo (often a
  // wordmark+icon lockup) reads as mush at 16px. Null falls back to logoKey.
  faviconKey: text("favicon_key"),
  // Accent color (hex) used for buttons/links/highlights in outgoing emails —
  // null means "use the built-in default (#384959)". Body text and headings
  // stay a fixed neutral dark regardless, for guaranteed readability.
  emailAccentColor: text("email_accent_color"),
  // Per-method sign-in toggles. A fresh install has only password on; an admin
  // enables magic link/Google from /admin/appearance. Google additionally needs
  // credentials configured, regardless of this flag.
  passwordLoginEnabled: boolean("password_login_enabled").notNull().default(true),
  magicLinkEnabled: boolean("magic_link_enabled").notNull().default(false),
  googleLoginEnabled: boolean("google_login_enabled").notNull().default(false),
  // Ticket lifecycle emails sent by Docket's own SMTP. Teams that consume the
  // same events via outbound webhooks and mail from their own backend turn this
  // off to avoid duplicates. Auth emails always send, regardless of this flag.
  ticketEmailNotificationsEnabled: boolean("ticket_email_notifications_enabled")
    .notNull()
    .default(true),
  // Ticket actions (Admin → Ticket Config). Each action has a feature switch
  // (off hides its UI and the API refuses it; existing links stay visible) and
  // a switch for the in-app notifications it sends. All on by default.
  ticketMergeEnabled: boolean("ticket_merge_enabled").notNull().default(true),
  ticketMergeNotificationsEnabled: boolean(
    "ticket_merge_notifications_enabled"
  )
    .notNull()
    .default(true),
  // Email the customer on merge (the "Ticket Merged" email template). Also
  // gated by ticketEmailNotificationsEnabled, like every ticket email.
  ticketMergeCustomerEmailEnabled: boolean(
    "ticket_merge_customer_email_enabled"
  )
    .notNull()
    .default(true),
  ticketSplitEnabled: boolean("ticket_split_enabled").notNull().default(true),
  ticketSplitNotificationsEnabled: boolean(
    "ticket_split_notifications_enabled"
  )
    .notNull()
    .default(true),
  ticketLinkEnabled: boolean("ticket_link_enabled").notNull().default(true),
  ticketLinkNotificationsEnabled: boolean("ticket_link_notifications_enabled")
    .notNull()
    .default(true),
  // Attachment caps (admin-configurable). Validated/clamped on read by
  // resolveAttachmentLimits in lib/tickets/attachment-limits.ts.
  attachmentMaxPerMessage: integer("attachment_max_per_message")
    .notNull()
    .default(5),
  // DEPRECATED + unused: Docket no longer caps attachments per ticket. Kept
  // (not dropped) so no destructive migration is needed; nothing reads or
  // writes it.
  attachmentMaxPerTicket: integer("attachment_max_per_ticket")
    .notNull()
    .default(25),
  attachmentMaxFileSizeMb: integer("attachment_max_file_size_mb")
    .notNull()
    .default(10),
  // Combined size of every attachment on one ticket, in MB (count is
  // unlimited). Separate from the deprecated attachment_max_per_ticket above.
  attachmentMaxPerTicketSizeMb: integer("attachment_max_per_ticket_size_mb")
    .notNull()
    .default(250),
  // Admin toggle for the MCP endpoint — off by default.
  mcpEnabled: boolean("mcp_enabled").notNull().default(false),
  // Admin gate for customer replies requested over MCP (reply_to_customer) —
  // off by default. A reply still needs its token owner's approval in Docket;
  // turning this off cancels the pending reply requests.
  mcpCustomerRepliesEnabled: boolean("mcp_customer_replies_enabled")
    .notNull()
    .default(false),
  // Set only once the wizard's Integrations step is finished or skipped. Null
  // means the admin account exists but the wizard doesn't, so `/setup` resumes
  // rather than treating setup as done — see isSetupComplete vs hasAdminUser.
  setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
