import type { McpErrorCode } from "@/lib/mcp/limits";

/** A domain error a tool raises on purpose (bad input, unknown entity). The
 * safe handler turns it into an `isError` result carrying exactly `code` and
 * `message`, so the message must be written for the model and never contain
 * internal detail or echo stored data. Anything else thrown is "internal". */
export class McpToolError extends Error {
  readonly code: McpErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: McpErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
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
