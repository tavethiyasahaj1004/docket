import { createHmac, hkdfSync } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { mcpToolCalls } from "@/db/schema";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { canUseTool } from "@/lib/mcp/authorize";
import { MCP_RESULT_HARD_CAP_CHARS, type McpErrorCode } from "@/lib/mcp/limits";

type ToolContext<T extends Record<string, unknown>> = {
  tool: string;
  principal: McpPrincipal;
  requestId: string;
  /** The validated arguments. Only a keyed hash of them is ever stored. */
  args: unknown;
  /** Returns a smaller version of an oversized result. */
  shrink?: (result: T) => T;
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

function errorResult(code: McpErrorCode, message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: { code, message } },
    isError: true,
  };
}

async function recordCall(
  ctx: Pick<ToolContext<never>, "tool" | "principal" | "requestId" | "args">,
  outcome: { status: "succeeded" | "failed"; errorCode: McpErrorCode | null },
  durationMs: number
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
      durationMs,
    });
  } catch (error) {
    // The trace is best-effort: a failed write never fails the tool call.
    console.error(`[mcp] tool_call_record_failed ref=${ctx.requestId}`, error);
  }
}

/** Wraps every tool handler: re-checks authorization, turns any thrown error
 * into an opaque "Internal error (ref: ...)" (the message only goes to the server
 * log), caps result size, and records one trace row plus one log line per call. */
export async function safeHandler<T extends Record<string, unknown>>(
  ctx: ToolContext<T>,
  fn: () => Promise<T>
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
      "This tool is not available to this token."
    );
  }

  try {
    let result = await fn();
    let text = JSON.stringify(result);
    if (text.length > MCP_RESULT_HARD_CAP_CHARS && ctx.shrink) {
      result = ctx.shrink(result);
      text = JSON.stringify(result);
    }
    if (text.length > MCP_RESULT_HARD_CAP_CHARS) {
      throw new Error("Tool result exceeds the size cap.");
    }
    const ms = Date.now() - started;
    console.log(line("ok", ms));
    await recordCall(ctx, { status: "succeeded", errorCode: null }, ms);
    return {
      content: [{ type: "text", text }],
      structuredContent: result,
    };
  } catch (error) {
    const ms = Date.now() - started;
    // The detail goes to the server log only, never into the result.
    console.error(line("internal", ms), error);
    await recordCall(ctx, { status: "failed", errorCode: "internal" }, ms);
    return errorResult("internal", `Internal error (ref: ${requestId})`);
  }
}
