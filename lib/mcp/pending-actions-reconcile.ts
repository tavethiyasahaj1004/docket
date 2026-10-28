// Crash recovery for approved MCP actions (WP4). An approval claims the row
// (`approved`, with a planned id) and only then runs the close or the reply; if
// the process dies in between, the row stays `approved` with no result. This
// settles such rows from the database alone — the same questions as
// `reconcileCloseCall` / `reconcileCommentCall`, answered about the approval —
// and never re-executes or notifies anything.
import { and, asc, eq, gte, isNull, lt, ne } from "drizzle-orm";
import {
  mcpPendingActions,
  ticketActivity,
  ticketComments,
  tickets,
} from "@/db/schema";
import { db } from "@/lib/db";
import {
  MCP_PENDING_ACTION_RECONCILE_AFTER_MS,
  MCP_WRITE_LEASE_MS,
} from "@/lib/mcp/limits";
import type { PendingAction } from "@/lib/mcp/pending-actions-core";
import { isClosedStatusSlug } from "@/lib/ticket-config";

type Settlement =
  | { result: Record<string, unknown>; sideEffectsUncertain: boolean }
  | "interrupted";

async function settleReply(plannedEntityId: string): Promise<Settlement> {
  const [comment] = await db
    .select({ id: ticketComments.id })
    .from(ticketComments)
    .where(eq(ticketComments.id, plannedEntityId))
    .limit(1);
  // The comment insert is atomic: it exists under the planned id or it doesn't.
  // Whether its email and webhook went out is unknown.
  return comment
    ? { result: { commentId: comment.id }, sideEffectsUncertain: true }
    : "interrupted";
}

/** Did this approval close the ticket? The claim time is `decided_at`, and the
 * planned id is the id of the `ticket_closed` activity row it would write. The
 * order differs from `reconcileCloseCall` in one place: the approval's own
 * activity row is checked FIRST, so a close that landed and was later reopened
 * still counts as landed. */
async function settleClose(
  action: PendingAction,
  plannedEntityId: string,
  decidedAt: Date
): Promise<Settlement> {
  const [own] = await db
    .select({ id: ticketActivity.id })
    .from(ticketActivity)
    .where(eq(ticketActivity.id, plannedEntityId))
    .limit(1);
  if (own) {
    return {
      result: { activityId: own.id },
      sideEffectsUncertain: true,
    };
  }

  const [ticket] = await db
    .select({ status: tickets.status, closedAt: tickets.closedAt })
    .from(tickets)
    .where(eq(tickets.id, action.ticketId))
    .limit(1);
  if (!(ticket && (await isClosedStatusSlug(ticket.status)))) {
    return "interrupted";
  }

  // Closed clearly before the approval: someone else did it. A gap under the
  // lease window could be clock skew between app instances, so it falls through
  // (conservatively) to the uncertain case.
  if (
    ticket.closedAt &&
    ticket.closedAt.getTime() < decidedAt.getTime() - MCP_WRITE_LEASE_MS
  ) {
    return { result: { alreadyClosed: true }, sideEffectsUncertain: false };
  }

  // Another actor's close activity since the approval: their update won.
  const [other] = await db
    .select({ id: ticketActivity.id })
    .from(ticketActivity)
    .where(
      and(
        eq(ticketActivity.ticketId, action.ticketId),
        eq(ticketActivity.action, "ticket_closed"),
        ne(ticketActivity.id, plannedEntityId),
        gte(ticketActivity.createdAt, decidedAt)
      )
    )
    .limit(1);
  if (other) {
    return { result: { alreadyClosed: true }, sideEffectsUncertain: false };
  }

  // Closed since the approval with no close activity: this approval's update may
  // have committed just before the crash, and it cannot be told apart from
  // another closer that crashed at the same point.
  return { result: { alreadyClosed: true }, sideEffectsUncertain: true };
}

async function settleOne(action: PendingAction, now: Date) {
  let settlement: Settlement = "interrupted";
  if (action.plannedEntityId && action.decidedAt) {
    settlement =
      action.kind === "reply"
        ? await settleReply(action.plannedEntityId)
        : await settleClose(action, action.plannedEntityId, action.decidedAt);
  }
  await db
    .update(mcpPendingActions)
    .set(
      settlement === "interrupted"
        ? { status: "failed", statusReason: "interrupted", updatedAt: now }
        : {
            result: settlement.result,
            sideEffectsUncertain: settlement.sideEffectsUncertain,
            updatedAt: now,
          }
    )
    .where(
      and(
        eq(mcpPendingActions.id, action.id),
        eq(mcpPendingActions.status, "approved"),
        isNull(mcpPendingActions.result)
      )
    );
}

/** Settles `approved` rows with no result whose approval is older than
 * MCP_PENDING_ACTION_RECONCILE_AFTER_MS (a crash between the claim and the
 * action). Landed -> the result is recorded; not landed -> `failed:
 * interrupted`. A row still `approved` and recent is a live approval and is left
 * alone. Each row is conditional on still being unsettled, so a late finalize
 * by the live attempt is never overwritten. */
export async function sweepStuckApprovedActions(
  now: Date = new Date()
): Promise<void> {
  const cutoff = new Date(
    now.getTime() - MCP_PENDING_ACTION_RECONCILE_AFTER_MS
  );
  const rows = await db
    .select()
    .from(mcpPendingActions)
    .where(
      and(
        eq(mcpPendingActions.status, "approved"),
        isNull(mcpPendingActions.result),
        lt(mcpPendingActions.decidedAt, cutoff)
      )
    )
    .orderBy(asc(mcpPendingActions.decidedAt), asc(mcpPendingActions.id));
  for (const action of rows) {
    try {
      await settleOne(action, now);
    } catch (err) {
      console.error(
        `[mcp] pending_action_reconcile_failed id=${action.id}`,
        err instanceof Error ? err.name : typeof err
      );
    }
  }
}
