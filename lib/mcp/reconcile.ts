// Recovery checks for write calls whose outcome is unknown: a pending
// mcp_tool_calls row whose lease expired (MCP_SECURITY.md 7.3). Each reconciler
// answers one question — did the original attempt already do its write? — from
// the database alone. None of them re-executes or notifies anything.
import { and, eq, gte, ne } from "drizzle-orm";
import {
  type mcpToolCalls,
  ticketActivity,
  ticketComments,
  tickets,
} from "@/db/schema";
import { db } from "@/lib/db";
import { MCP_WRITE_LEASE_MS } from "@/lib/mcp/limits";
import { isClosedStatusSlug } from "@/lib/ticket-config";

export type McpToolCallRow = typeof mcpToolCalls.$inferSelect;

export type ReconcileOutcome =
  | { done: false }
  | {
      done: true;
      /** Ids, numbers, booleans and slugs only (see result-json.ts). */
      result: Record<string, unknown>;
      /** The write happened, but the notifications after it may not have. */
      sideEffectsUncertain: boolean;
    };

export type Reconciler = (row: McpToolCallRow) => Promise<ReconcileOutcome>;

/** Comment-creating tools: the comment insert is atomic, so it either exists
 * under the planned id or it does not. */
export const reconcileCommentCall: Reconciler = async (row) => {
  if (!row.plannedEntityId) {
    return { done: false };
  }
  const [comment] = await db
    .select({ id: ticketComments.id })
    .from(ticketComments)
    .where(eq(ticketComments.id, row.plannedEntityId))
    .limit(1);
  if (!comment) {
    return { done: false };
  }
  return {
    done: true,
    result: { commentId: comment.id },
    sideEffectsUncertain: true,
  };
};

/** `close_ticket`: did this call cause the close? Cases 1-5 of 7.3. The claim
 * time is the row's `createdAt` and the planned id is the id of the
 * `ticket_closed` activity row the call would write.
 *
 * The call's OWN activity row is checked first (7.3 case 2), before looking at
 * the ticket's status. A close that landed and was then reopened (the call
 * crashed before it was finalized, someone reopened the ticket) must still
 * count as done: answering "not closed, run again" would let a retry close the
 * reopened ticket a second time under the same planned id, with no new
 * activity, email or webhook. Only when no such row exists does the ticket's
 * state decide (cases 1, 3, 4, 5, in that order). Same order as `settleClose`
 * in pending-actions-reconcile.ts.
 *
 * Registered with the sweeper (`DEFAULT_PENDING_RECONCILERS`); no tool uses it
 * until Phase 6. Cases 3 and 4 rely on P10 (only one closer's conditional
 * update can succeed), which the email-sending close paths now have. */
export const reconcileCloseCall: Reconciler = async (row) => {
  if (!(row.targetTicketId && row.plannedEntityId)) {
    return { done: false };
  }
  const ticketId = row.targetTicketId;

  // 2. Our own activity row exists: this call closed the ticket, whatever its
  // status is now (it may have been reopened since). The notifications after
  // the close may or may not have run.
  const [own] = await db
    .select({ id: ticketActivity.id })
    .from(ticketActivity)
    .where(eq(ticketActivity.id, row.plannedEntityId))
    .limit(1);
  if (own) {
    return {
      done: true,
      result: { activityId: own.id },
      sideEffectsUncertain: true,
    };
  }

  const [ticket] = await db
    .select({ status: tickets.status, closedAt: tickets.closedAt })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);

  // 1. Not closed and no activity row of ours: nothing happened yet, so the
  // call can run again.
  if (!(ticket && (await isClosedStatusSlug(ticket.status)))) {
    return { done: false };
  }

  // 3. Closed clearly before the claim. A gap under the lease window could be
  // clock skew between app instances, so it falls through (conservatively) to
  // case 5.
  const claimedAt = row.createdAt.getTime();
  if (
    ticket.closedAt &&
    ticket.closedAt.getTime() < claimedAt - MCP_WRITE_LEASE_MS
  ) {
    return {
      done: true,
      result: { alreadyClosed: true },
      sideEffectsUncertain: false,
    };
  }

  // 4. Another actor's close activity since the claim: their update won.
  const [other] = await db
    .select({ id: ticketActivity.id })
    .from(ticketActivity)
    .where(
      and(
        eq(ticketActivity.ticketId, ticketId),
        eq(ticketActivity.action, "ticket_closed"),
        ne(ticketActivity.id, row.plannedEntityId),
        gte(ticketActivity.createdAt, row.createdAt)
      )
    )
    .limit(1);
  if (other) {
    return {
      done: true,
      result: { alreadyClosed: true },
      sideEffectsUncertain: false,
    };
  }

  // 5. Closed since the claim with no close activity: this call's update may
  // have committed just before a crash, and it cannot be told apart from
  // another closer that crashed at the same point.
  return {
    done: true,
    result: { alreadyClosed: true },
    sideEffectsUncertain: true,
  };
};
