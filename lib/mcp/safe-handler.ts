import { createHmac, hkdfSync } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { mcpToolCalls } from "@/db/schema";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { canUseTool } from "@/lib/mcp/authorize";
import { FORBIDDEN_OUTPUT_PATTERNS } from "@/lib/mcp/dto";
import {
  MCP_ERROR_DETAIL_KEYS,
  type McpErrorDetails,
  McpToolError,
} from "@/lib/mcp/errors";
import {
  MCP_RESULT_HARD_CAP_CHARS,
  MCP_RESULT_TARGET_CHARS,
  type McpErrorCode,
} from "@/lib/mcp/limits";

type ToolContext<T extends Record<string, unknown>> = {
  tool: string;
  principal: McpPrincipal;
  requestId: string;
  /** The validated arguments. Only a keyed hash of them is ever stored. */
  args: unknown;
  /** Returns a smaller version of an oversized result. */
  shrink?: (result: T) => T;
};

type CallTarget = { ticketId?: string; customerId?: string };

/** What a tool tells the handler while it runs, for the trace row. */
export type ToolCallInfo = {
  /** Records the entity a call resolved to (ids only, never names or bodies). */
  setTarget(target: CallTarget): void;
};

let argsHmacKey: Buffer | null = null;

function getArgsHmacKey(): Buffer {
  argsHmacKey ??= Buffer.from(
    hkdfSync("sha256", env.APP_SECRET, "", "docket:mcp:args-hmac:v1", 32)
  );
  return argsHmacKey;
}

/** JSON with object keys sorted, so equal arguments always hash equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => {
        if (a < b) {
          return -1;
        }
        return a > b ? 1 : 0;
      })
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function hmacToolArgs(args: unknown): string {
  return createHmac("sha256", getArgsHmacKey())
    .update(canonicalJson(args ?? {}))
    .digest("hex");
}

const DETAIL_STRING_MAX_CHARS = 200;
const DETAIL_ARRAY_MAX_ITEMS = 50;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;

export function isSafeDetailString(value: string): boolean {
  if (value.length > DETAIL_STRING_MAX_CHARS || EMAIL_PATTERN.test(value)) {
    return false;
  }
  return !FORBIDDEN_OUTPUT_PATTERNS.some((p) =>
    typeof p === "string" ? value.includes(p) : p.test(value)
  );
}

function isSafeDetailScalar(value: unknown): value is string | number {
  if (typeof value === "string") {
    return isSafeDetailString(value);
  }
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeDetailValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return (
      value.length <= DETAIL_ARRAY_MAX_ITEMS && value.every(isSafeDetailScalar)
    );
  }
  return isSafeDetailScalar(value);
}

/** Keeps only allowlisted keys with small, non-sensitive values. Everything
 * else is dropped; only the dropped key's name is logged, never its value.
 * Returns undefined when nothing is left. */
export function sanitizeErrorDetails(
  details: McpErrorDetails | undefined,
  requestId: string
): Record<string, unknown> | undefined {
  if (!details || typeof details !== "object") {
    return;
  }
  const allowed: readonly string[] = MCP_ERROR_DETAIL_KEYS;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) {
      continue;
    }
    if (allowed.includes(key) && isSafeDetailValue(value)) {
      kept[key] = value;
    } else {
      console.warn(
        `[mcp] error_detail_dropped key=${key.slice(0, 60)} ref=${requestId}`
      );
    }
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** The one place an error result is built. The text block is exactly
 * `JSON.stringify(structuredContent)`: clients such as Claude Code pass only
 * the text to the model, so the code and details must be in it. */
function errorResult(
  code: McpErrorCode,
  message: string,
  requestId: string,
  details?: McpErrorDetails
): CallToolResult {
  const safe = sanitizeErrorDetails(details, requestId);
  const structuredContent = {
    error: { code, message, ...(safe ? { details: safe } : {}) },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
}

/** A log-safe description of an unexpected error: class names, database error
 * codes and stack frames only. Messages are dropped because a failed query's
 * message embeds its parameters, which can be a customer email or note text. */
export function describeErrorForLog(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++) {
    if (!(current instanceof Error)) {
      parts.push(typeof current);
      break;
    }
    const code = (current as Error & { code?: unknown }).code;
    parts.push(
      typeof code === "string" ? `${current.name} code=${code}` : current.name
    );
    current = (current as Error & { cause?: unknown }).cause;
  }
  // Frames are taken only from after the message: a multi-line message can hold
  // lines that look like frames (a query parameter such as "\n    at x@y").
  const messageEnd =
    error instanceof Error && error.stack
      ? error.stack.indexOf(error.message)
      : -1;
  const frames =
    error instanceof Error && error.stack && messageEnd >= 0
      ? error.stack
          .slice(messageEnd + error.message.length)
          .split("\n")
          .filter((l) => /^\s+at /.test(l))
          .slice(0, 8)
      : [];
  return [parts.join(" <- "), ...frames].join("\n");
}

async function recordCall(
  ctx: Pick<ToolContext<never>, "tool" | "principal" | "requestId" | "args">,
  outcome: { status: "succeeded" | "failed"; errorCode: McpErrorCode | null },
  durationMs: number,
  target: CallTarget = {}
): Promise<void> {
  try {
    await db.insert(mcpToolCalls).values({
      requestId: ctx.requestId,
      userId: ctx.principal.userId,
      authMethod: ctx.principal.authMethod,
      credentialId: ctx.principal.credentialId,
      tool: ctx.tool,
      status: outcome.status,
      errorCode: outcome.errorCode,
      argsHmac: hmacToolArgs(ctx.args),
      targetTicketId: target.ticketId ?? null,
      targetCustomerId: target.customerId ?? null,
      durationMs,
    });
  } catch (error) {
    // The trace is best-effort: a failed write never fails the tool call.
    console.error(
      `[mcp] tool_call_record_failed ref=${ctx.requestId}`,
      describeErrorForLog(error)
    );
  }
}

/** Wraps every tool handler: re-checks authorization, turns any thrown error
 * into an opaque "Internal error (ref: ...)" (only its class, code and stack
 * frames go to the server log), caps result size, and records one trace row plus
 * one log line per call. */
export async function safeHandler<T extends Record<string, unknown>>(
  ctx: ToolContext<T>,
  fn: (call: ToolCallInfo) => Promise<T>
): Promise<CallToolResult> {
  const started = Date.now();
  const { tool, principal, requestId } = ctx;
  const line = (outcome: string, ms: number) =>
    `[mcp] tool=${tool} user=${principal.userId} outcome=${outcome} ms=${ms} ref=${requestId}`;

  // Unpermitted tools are not registered at all, so this is defence in depth.
  if (!canUseTool(principal, tool)) {
    const ms = Date.now() - started;
    console.log(line("invalid_input", ms));
    await recordCall(ctx, { status: "failed", errorCode: "invalid_input" }, ms);
    return errorResult(
      "invalid_input",
      "This tool is not available to this token.",
      requestId
    );
  }

  const target: CallTarget = {};
  const call: ToolCallInfo = {
    setTarget: (t) => {
      Object.assign(target, t);
    },
  };

  try {
    let result = await fn(call);
    let text = JSON.stringify(result);
    // Tools that can shrink are trimmed back to the target size; the hard cap
    // is the limit nothing may exceed.
    if (text.length > MCP_RESULT_TARGET_CHARS && ctx.shrink) {
      result = ctx.shrink(result);
      text = JSON.stringify(result);
    }
    if (text.length > MCP_RESULT_HARD_CAP_CHARS) {
      throw new Error("Tool result exceeds the size cap.");
    }
    const ms = Date.now() - started;
    console.log(line("ok", ms));
    await recordCall(ctx, { status: "succeeded", errorCode: null }, ms, target);
    return {
      content: [{ type: "text", text }],
      structuredContent: result,
    };
  } catch (error) {
    const ms = Date.now() - started;
    if (error instanceof McpToolError) {
      // A deliberate domain error: its message was written for the model.
      console.log(line(error.code, ms));
      await recordCall(
        ctx,
        { status: "failed", errorCode: error.code },
        ms,
        target
      );
      return errorResult(error.code, error.message, requestId, error.details);
    }
    // The detail goes to the server log only, never into the result.
    console.error(line("internal", ms), describeErrorForLog(error));
    await recordCall(
      ctx,
      { status: "failed", errorCode: "internal" },
      ms,
      target
    );
    return errorResult(
      "internal",
      `Internal error (ref: ${requestId})`,
      requestId
    );
  }
}
