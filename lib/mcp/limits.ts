/** Hard limits for the MCP endpoint. Fixed defaults — not admin-configurable. */

export const MCP_MAX_BODY_BYTES = 1_048_576;
/** A serialized tool result above this is shrunk, then treated as an internal error. */
export const MCP_RESULT_HARD_CAP_CHARS = 40_000;
export const MCP_TAG_LIMIT = 200;
export const MCP_INSTRUCTIONS_MAX_CHARS = 2000;
export const MCP_TOOL_CALL_RETENTION_DAYS = 30;

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
