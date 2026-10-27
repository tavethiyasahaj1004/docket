import type { McpErrorCode } from "@/lib/mcp/limits";

/** The only keys an error may carry in `details`. The text block of an error
 * result is the serialized `structuredContent` and goes straight to the model,
 * so details are limited to small, actionable, non-sensitive values. Anything
 * else is dropped by the safe handler (and its key name logged). */
export const MCP_ERROR_DETAIL_KEYS = [
  /** Number of the ticket a merged ticket was forwarded to (code `merged`). */
  "mergedIntoTicketNumber",
  /** Seconds to wait before retrying (code `rate_limited`). */
  "retryAfterSeconds",
  /** Id of an existing comment the call duplicates or conflicts with. */
  "commentId",
  /** Slug of the ticket status found when a precondition failed. */
  "currentStatus",
  /** ISO timestamp of the ticket's current `updatedAt` (stale-write conflicts). */
  "currentUpdatedAt",
  /** Number of the ticket the error is about. */
  "ticketNumber",
  /** Name of the input field at fault (a schema property, never a value). */
  "field",
  /** The slugs that would have been accepted (statuses, priorities, ...). */
  "allowed",
] as const;
export type McpErrorDetailKey = (typeof MCP_ERROR_DETAIL_KEYS)[number];

export type McpErrorDetailValue =
  | string
  | number
  | boolean
  | null
  | (string | number)[];

/** Details as a tool raises them. Values are still checked at the boundary:
 * see `sanitizeErrorDetails` in safe-handler.ts. */
export type McpErrorDetails = Partial<
  Record<McpErrorDetailKey, McpErrorDetailValue>
>;

/** A domain error a tool raises on purpose (bad input, unknown entity). The
 * safe handler turns it into an `isError` result carrying `code`, `message`
 * and any allowlisted `details`, so the message must be written for the model
 * and never contain internal detail or echo stored data. Anything else thrown
 * is "internal". */
export class McpToolError extends Error {
  readonly code: McpErrorCode;
  readonly details?: McpErrorDetails;

  constructor(code: McpErrorCode, message: string, details?: McpErrorDetails) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    this.details = details;
  }
}

export const invalidInput = (message: string) =>
  new McpToolError("invalid_input", message);

/** Deliberately hint-free: it never says which part of a lookup missed. */
export const notFound = (what: "ticket" | "customer") =>
  new McpToolError("not_found", `No such ${what}.`);
