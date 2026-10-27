/** Hard limits for the MCP endpoint. Fixed defaults — not admin-configurable. */

export const MCP_MAX_BODY_BYTES = 1_048_576;
/** A serialized tool result above this (even after shrinking) is an internal error. */
export const MCP_RESULT_HARD_CAP_CHARS = 40_000;
/** A result above this is shrunk by tools that can (dropping trailing items or
 * shortening bodies) until it fits. */
export const MCP_RESULT_TARGET_CHARS = 30_000;
export const MCP_TAG_LIMIT = 200;
export const MCP_INSTRUCTIONS_MAX_CHARS = 2000;
export const MCP_TOOL_CALL_RETENTION_DAYS = 30;
/** How long a write call holds its claim before another caller may take it
 * over (MCP_SECURITY.md 7.2). */
export const MCP_WRITE_LEASE_MS = 60_000;
/** A pending write call older than this is settled by the daily sweeper. */
export const MCP_PENDING_SWEEP_AFTER_MS = 60 * 60 * 1000;

export const MCP_RATE_LIMITS = {
  /** Every authenticated call, per user. */
  allCallsPerMinute: 120,
  /** Failed authentications, per token prefix (`dkm_` + 8 chars). */
  authFailuresPerPrefixPerMinute: 20,
  /** Failed authentications, per client IP. */
  authFailuresPerIpPerMinute: 60,
  // Not enforced yet — reserved for the write tools of later phases.
  writesPerMinute: 30,
  manageWritesPerMinute: 20,
  repliesPerMinute: 10,
  repliesPerDay: 100,
} as const;

export const MCP_ERROR_CODES = [
  "invalid_input",
  "not_found",
  "merged",
  "ticket_closed",
  "ticket_open",
  "conflict",
  "draft_exists",
  "in_progress",
  "idempotency_key_reused",
  "duplicate_suspected",
  "disabled",
  "rate_limited",
  "internal",
  "interrupted",
] as const;
export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

export const MCP_NOTIFICATION_ERRORS = [
  "email_not_queued",
  "email_queued_without_job",
  "webhook_dispatch_failed",
] as const;
export type McpNotificationError = (typeof MCP_NOTIFICATION_ERRORS)[number];
