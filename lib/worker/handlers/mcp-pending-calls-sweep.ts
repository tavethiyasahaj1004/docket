import type { Job } from "pg-boss";
import type { Reconciler } from "@/lib/mcp/reconcile";
import {
  DEFAULT_PENDING_RECONCILERS,
  sweepExpiredLeasePendingCalls,
} from "@/lib/worker/handlers/mcp-tool-calls-prune";

/** Every 5 minutes: settles pending MCP write calls whose lease expired more
 * than 5 minutes ago (a crashed attempt), which frees their per-ticket lock.
 * See `sweepExpiredLeasePendingCalls`. */
export async function handleMcpPendingCallsSweep(
  _jobs: Job<Record<string, never>>[],
  reconcilers: Readonly<
    Record<string, Reconciler>
  > = DEFAULT_PENDING_RECONCILERS
) {
  await sweepExpiredLeasePendingCalls(reconcilers);
}
