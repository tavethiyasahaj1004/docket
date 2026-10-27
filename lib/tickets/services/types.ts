// Shared types for the agent write services (lib/tickets/services/*).

/** Who performs the change. Customers never go through these services. */
export interface ServiceActor {
  id: string;
  name: string;
  role: "agent" | "admin";
}

/** Extra keys merged into an activity row's `metadata` (e.g. the MCP caller
 * passes `{ via: "mcp", credentialId }`). When omitted, the row is written
 * exactly as it always was. */
export type ActivityMetadataExtra = Record<string, string | number | boolean>;

/** Result of the outbound webhook dispatch. "none" = this path dispatches
 * nothing (e.g. internal notes). */
export type WebhookOutcome = "dispatched" | "failed" | "none";

/** What happened to the fire-and-forget email. */
export type EmailOutcome =
  | { requested: true; outboxId: string }
  | { requested: false }
  | { requested: false; error: "email_not_queued" }
  | { requested: true; error: "email_queued_without_job"; outboxId: string };

/** Fire-and-forget email handle: null when the path sends no email, otherwise a
 * promise that never rejects. Routes ignore it; other callers may await it. */
export type EmailHandle = Promise<EmailOutcome> | null;
