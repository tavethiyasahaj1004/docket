// The parts of the MCP approval flow (WP4) that other modules need without the
// approve/dismiss service itself: the "actionable" predicate, the cancellation
// helpers the revoke/merge paths call, and expiry. Kept free of the ticket
// services on purpose — lib/tickets/merge.ts imports it, and the services
// import merge.ts.
import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { ADMIN_ROLE, AGENT_ROLE } from "@/config/platform";
import {
  mcpAccessTokens,
  mcpPendingActions,
  oauthConsent,
  platformSettings,
  user,
} from "@/db/schema";
import type { AuditInput } from "@/lib/audit";
import { db } from "@/lib/db";
import type { DbOrTx } from "@/lib/user-deletion";

export type PendingAction = typeof mcpPendingActions.$inferSelect;
export type PendingActionKind = PendingAction["kind"];

/** Why a pending action was cancelled (the cancellation audit's `reason`). */
export type CancelReason =
  | "token_revoked"
  | "ticket_merged"
  | "replies_disabled";

/** What a cancellation returns, for the caller's audit rows. */
export type CancelledPendingAction = Pick<
  PendingAction,
  | "id"
  | "ticketId"
  | "kind"
  | "credentialId"
  | "oauthConsentId"
  | "requestedById"
>;

const CANCELLED_COLUMNS = {
  id: mcpPendingActions.id,
  ticketId: mcpPendingActions.ticketId,
  kind: mcpPendingActions.kind,
  credentialId: mcpPendingActions.credentialId,
  oauthConsentId: mcpPendingActions.oauthConsentId,
  requestedById: mcpPendingActions.requestedById,
};

/** The one definition of "this request can still be decided", reused by the
 * approve/dismiss compare-and-set and by every read: still pending, not past
 * its expiry, and its credential and owner both still in good standing. The
 * credential is either a personal access token (not revoked, owned by the
 * requester) or an OAuth grant (its oauth_consent row still exists and belongs
 * to the requester). Neither path can approve anything: the decision is always
 * the owner's, made in Docket.
 *
 * Token *expiry* is deliberately not part of it — only revocation is. The
 * human approval inside Docket is the control, so a request an assistant made
 * just before its token expired can still be decided by its owner. */
export function actionablePendingSql(now: Date): SQL {
  return and(
    eq(mcpPendingActions.status, "pending"),
    gt(mcpPendingActions.expiresAt, now),
    or(
      and(
        isNotNull(mcpPendingActions.credentialId),
        exists(
          db
            .select({ one: sql`1` })
            .from(mcpAccessTokens)
            .where(
              and(
                eq(mcpAccessTokens.id, mcpPendingActions.credentialId),
                eq(mcpAccessTokens.userId, mcpPendingActions.requestedById),
                isNull(mcpAccessTokens.revokedAt)
              )
            )
        )
      ),
      and(
        isNotNull(mcpPendingActions.oauthConsentId),
        exists(
          db
            .select({ one: sql`1` })
            .from(oauthConsent)
            .where(
              and(
                eq(oauthConsent.id, mcpPendingActions.oauthConsentId),
                eq(oauthConsent.userId, mcpPendingActions.requestedById)
              )
            )
        )
      )
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(user)
        .where(
          and(
            eq(user.id, mcpPendingActions.requestedById),
            inArray(user.role, [AGENT_ROLE, ADMIN_ROLE]),
            sql`${user.banned} IS NOT TRUE`
          )
        )
    )
  ) as SQL;
}

/** The extra condition on approving or dismissing a request: a close always
 * passes, a reply only while the admin setting for customer replies is on, so a
 * reply can't be decided once the setting is off (turning it off also cancels
 * the pending ones, see {@link cancelPendingRepliesForGateOff}). */
export function replyGateOpenSql(): SQL {
  return or(
    eq(mcpPendingActions.kind, "close"),
    exists(
      db
        .select({ one: sql`1` })
        .from(platformSettings)
        .where(
          and(
            eq(platformSettings.id, "default"),
            eq(platformSettings.mcpCustomerRepliesEnabled, true)
          )
        )
    )
  ) as SQL;
}

/** Cancels the pending actions of still-live tokens, so call it BEFORE the
 * revoke (a revoked token no longer matches). `{ userId }` covers all of a
 * user's tokens (ban, sign out everywhere); `{ tokenId, ownerId }` one token,
 * and `ownerId` keeps a user from ever cancelling someone else's actions.
 * Returns the cancelled rows for the caller to audit. The database trigger from
 * migration 0018 covers every other revoke path. */
export async function cancelPendingActionsForLiveTokens(
  tx: DbOrTx,
  filter: { userId: string } | { tokenId: string; ownerId?: string }
): Promise<CancelledPendingAction[]> {
  const tokenMatch =
    "userId" in filter
      ? eq(mcpAccessTokens.userId, filter.userId)
      : and(
          eq(mcpAccessTokens.id, filter.tokenId),
          filter.ownerId === undefined
            ? undefined
            : eq(mcpAccessTokens.userId, filter.ownerId)
        );
  return await tx
    .update(mcpPendingActions)
    .set({
      status: "cancelled",
      statusReason: "token_revoked",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mcpPendingActions.status, "pending"),
        inArray(
          mcpPendingActions.credentialId,
          tx
            .select({ id: mcpAccessTokens.id })
            .from(mcpAccessTokens)
            .where(and(isNull(mcpAccessTokens.revokedAt), tokenMatch))
        )
      )
    )
    .returning(CANCELLED_COLUMNS);
}

/** Cancels the pending actions of tickets that were just merged away. Runs
 * inside the merge transaction; the actions of the merge TARGET are untouched. */
export async function cancelPendingActionsForMergedTickets(
  tx: DbOrTx,
  sourceTicketIds: string[]
): Promise<CancelledPendingAction[]> {
  if (sourceTicketIds.length === 0) {
    return [];
  }
  return await tx
    .update(mcpPendingActions)
    .set({
      status: "cancelled",
      statusReason: "ticket_merged",
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(mcpPendingActions.ticketId, sourceTicketIds),
        eq(mcpPendingActions.status, "pending")
      )
    )
    .returning(CANCELLED_COLUMNS);
}

/** Cancels every pending reply request (closes are untouched). Runs in the same
 * transaction that turns the customer-replies setting off. Returns the
 * cancelled rows for the caller to audit. */
export async function cancelPendingRepliesForGateOff(
  tx: DbOrTx
): Promise<CancelledPendingAction[]> {
  return await tx
    .update(mcpPendingActions)
    .set({
      status: "cancelled",
      statusReason: "replies_disabled",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mcpPendingActions.kind, "reply"),
        eq(mcpPendingActions.status, "pending")
      )
    )
    .returning(CANCELLED_COLUMNS);
}

/** The audit row for one cancelled action. `actor` is whoever caused the
 * cancellation (the user revoking, the admin banning or merging). */
export function cancelledActionAudit(
  row: CancelledPendingAction,
  input: {
    actorId: string;
    actorEmail?: string | null;
    reason: CancelReason;
  }
): AuditInput {
  return {
    action: "mcp.action_cancelled",
    actorEmail: input.actorEmail,
    actorId: input.actorId,
    description: `Cancelled a pending MCP ${row.kind} request (${input.reason})`,
    entityId: row.id,
    entityType: "mcp_pending_action",
    metadata: {
      via: "mcp",
      kind: row.kind,
      ticketId: row.ticketId,
      credentialId: row.credentialId,
      oauthConsentId: row.oauthConsentId,
      requestedById: row.requestedById,
      reason: input.reason,
    },
  };
}

/** Marks pending actions past their expiry as `expired`. Reads already treat
 * them as expired (see {@link actionablePendingSql}); this just settles the
 * rows. Run by the daily prune job. */
export async function expirePendingActions(
  now: Date = new Date()
): Promise<void> {
  await db
    .update(mcpPendingActions)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(mcpPendingActions.status, "pending"),
        lte(mcpPendingActions.expiresAt, now)
      )
    );
}
