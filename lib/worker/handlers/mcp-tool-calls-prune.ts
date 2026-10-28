import { and, eq, lt } from "drizzle-orm";
import type { Job } from "pg-boss";
import { mcpToolCalls } from "@/db/schema";
import { db } from "@/lib/db";
import {
  MCP_PENDING_SWEEP_AFTER_MS,
  MCP_TOOL_CALL_RETENTION_DAYS,
} from "@/lib/mcp/limits";
import {
  type McpToolCallRow,
  type Reconciler,
  reconcileCloseCall,
  reconcileCommentCall,
} from "@/lib/mcp/reconcile";
import { sanitizeResultJson } from "@/lib/mcp/result-json";

/** Which reconciler settles a stuck pending row of each tool.
 *
 * `reconcileCloseCall` relies on P10 (only one closer's conditional update can
 * succeed), which every email-sending close path now has. No `close_ticket`,
 * `add_internal_note` or `reply_to_customer` tool exists yet in this build, so
 * this map is inert until Phase 6 adds them. */
export const DEFAULT_PENDING_RECONCILERS: Readonly<Record<string, Reconciler>> =
  {
    add_internal_note: reconcileCommentCall,
    close_ticket: reconcileCloseCall,
    reply_to_customer: reconcileCommentCall,
  };

async function isDone(
  row: McpToolCallRow,
  reconcilers: Readonly<Record<string, Reconciler>>
) {
  const reconcile = reconcilers[row.tool];
  if (!reconcile) {
    return null;
  }
  try {
    const found = await reconcile(row);
    return found.done ? found : null;
  } catch (err) {
    console.error(
      `[mcp] sweeper_reconcile_failed tool=${row.tool} id=${row.id}`,
      err instanceof Error ? err.name : typeof err
    );
    return null;
  }
}

/** Settles `pending` rows older than an hour: the same reconcile check as a
 * retry (7.3), then `failed: interrupted` for whatever it cannot confirm. Never
 * re-executes anything, and only touches a row still pending in the attempt it
 * read, so a late finalize or takeover is not overwritten. */
export async function sweepStalePendingCalls(
  reconcilers: Readonly<
    Record<string, Reconciler>
  > = DEFAULT_PENDING_RECONCILERS,
  now: Date = new Date()
) {
  const cutoff = new Date(now.getTime() - MCP_PENDING_SWEEP_AFTER_MS);
  const stale = await db
    .select()
    .from(mcpToolCalls)
    .where(
      and(
        eq(mcpToolCalls.status, "pending"),
        lt(mcpToolCalls.createdAt, cutoff)
      )
    );
  for (const row of stale) {
    const found = await isDone(row, reconcilers);
    await db
      .update(mcpToolCalls)
      .set(
        found
          ? {
              status: "succeeded",
              errorCode: null,
              resultJson: sanitizeResultJson(found.result),
              sideEffectsUncertain: true,
              updatedAt: now,
            }
          : {
              status: "failed",
              errorCode: "interrupted",
              updatedAt: now,
            }
      )
      .where(
        and(
          eq(mcpToolCalls.id, row.id),
          eq(mcpToolCalls.status, "pending"),
          eq(mcpToolCalls.attempts, row.attempts)
        )
      );
  }
}

export async function handleMcpToolCallsPrune(
  _jobs: Job<Record<string, never>>[],
  reconcilers: Readonly<
    Record<string, Reconciler>
  > = DEFAULT_PENDING_RECONCILERS
) {
  await sweepStalePendingCalls(reconcilers);
  const cutoff = new Date(
    Date.now() - MCP_TOOL_CALL_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );
  await db.delete(mcpToolCalls).where(lt(mcpToolCalls.createdAt, cutoff));
}
