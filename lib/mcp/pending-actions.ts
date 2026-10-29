// Human approval for MCP requests that reach the customer (WP4). An MCP client
// can only ASK to close a ticket or send a reply; the token owner then decides
// in Docket, and an approval runs the very same service the UI runs, as the
// owner. Nothing here is reachable by a token: creating a request touches
// nothing the customer sees.
//
// Every state change is a single conditional UPDATE (compare-and-set), so
// concurrent clicks, retries and the sweeper can never both win. Customers never
// see any of this: the portal and the v1 API do not read mcp_pending_actions.
import { createId } from "@paralleldrive/cuid2";
import { and, asc, desc, eq, isNull, lte } from "drizzle-orm";
import { mcpAccessTokens, mcpPendingActions, tickets, user } from "@/db/schema";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { MCP_PENDING_ACTION_TTL_MS } from "@/lib/mcp/limits";
import {
  actionablePendingSql,
  type PendingAction,
  type PendingActionKind,
  replyGateOpenSql,
} from "@/lib/mcp/pending-actions-core";
import { isEligibleMcpRole } from "@/lib/mcp-tokens";
import { createNotifications } from "@/lib/notifications";
import { publishPushToUsers } from "@/lib/push";
import { isRichTextEmpty, richTextToPlainText } from "@/lib/rich-text";
import { getAttachmentLimits } from "@/lib/settings";
import { isClosedStatusSlug } from "@/lib/ticket-config";
import { closeTicket } from "@/lib/tickets/services/close";
import {
  addTicketComment,
  loadCommentTarget,
} from "@/lib/tickets/services/comments";
import type {
  ActivityMetadataExtra,
  EmailHandle,
  ServiceActor,
  WebhookOutcome,
} from "@/lib/tickets/services/types";

export type { PendingAction, PendingActionKind };

/** Why an approved action ended `failed` (also its `status_reason`). */
export type PendingActionFailure =
  | "ticket_merged"
  | "ticket_closed"
  | "ticket_not_found"
  | "no_closed_status";

function logFailure(label: string, err: unknown) {
  console.error(label, err);
}

/* ------------------------------------------------------------- creating */

export type CreatePendingActionInput = {
  /** The id to create the request under: the ledger call's planned entity id.
   * A request that already exists under it (in any state) is returned as
   * `existing` and nothing else happens, so re-running the same ledger call
   * can never create a second request. Omitted: a fresh id. */
  id?: string;
  userId: string;
  credentialId: string;
  ticketId: string;
  kind: PendingActionKind;
  /** `{}` (or omitted) for a close; `{ content }` for a reply, where content is
   * the Tiptap JSON string exactly as it will be stored on the comment. */
  payload?: unknown;
  /** The mcp_tool_calls row that created it, for tracing. */
  toolCallId?: string | null;
  now?: Date;
};

export type CreatePendingActionResult =
  | { status: "created"; action: PendingAction }
  | { status: "existing"; action: PendingAction }
  | {
      status:
        | "not_permitted"
        | "ticket_not_found"
        | "ticket_merged"
        | "ticket_closed"
        | "invalid_content";
    };

function normalizePayload(
  kind: PendingActionKind,
  payload: unknown
): Record<string, unknown> | null {
  if (kind === "close") {
    const empty =
      payload === undefined ||
      (typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        Object.keys(payload).length === 0);
    return empty ? {} : null;
  }
  const content =
    typeof payload === "object" && payload !== null
      ? (payload as { content?: unknown }).content
      : undefined;
  if (typeof content !== "string" || isRichTextEmpty(content)) {
    return null;
  }
  return { content };
}

/** Records a request for the owner to approve. It closes nothing, writes no
 * comment, sends no email or webhook and leaves the owner's reply draft alone;
 * it only notifies the owner. A repeat while one is pending returns the
 * existing request. */
export async function createPendingAction(
  input: CreatePendingActionInput
): Promise<CreatePendingActionResult> {
  const now = input.now ?? new Date();
  const payload = normalizePayload(input.kind, input.payload);
  if (!payload) {
    return { status: "invalid_content" };
  }

  // Lock order: ticket, then the owner's pending rows, then the token — the
  // same order as a merge (ticket, then pending rows) and an app revoke
  // (pending rows, then token). A trigger-driven revoke takes the token first,
  // so racing one while a stale row is being expired can deadlock; PostgreSQL
  // then aborts one transaction and nothing is left half-done.
  const outcome = await db.transaction(async (tx) => {
    // A re-execution of the ledger call that already created this request. Checked
    // first so it touches nothing: no expiry sweep, no notification, no audit.
    if (input.id !== undefined) {
      const [known] = await tx
        .select()
        .from(mcpPendingActions)
        .where(eq(mcpPendingActions.id, input.id))
        .limit(1);
      if (known) {
        return { status: "existing" as const, action: known };
      }
    }

    // FOR SHARE conflicts with a merge's lock on the ticket, so the merge either
    // commits first (we then see it merged) or waits for us (its cancel sweep
    // then sees our new row).
    const [ticket] = await tx
      .select({
        ticketNumber: tickets.ticketNumber,
        subject: tickets.subject,
        status: tickets.status,
        mergedIntoTicketId: tickets.mergedIntoTicketId,
      })
      .from(tickets)
      .where(eq(tickets.id, input.ticketId))
      .for("share");

    // A stale pending row that is past its expiry but not yet marked would
    // otherwise hold the partial unique index and block the new request.
    await tx
      .update(mcpPendingActions)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(mcpPendingActions.ticketId, input.ticketId),
          eq(mcpPendingActions.kind, input.kind),
          eq(mcpPendingActions.requestedById, input.userId),
          eq(mcpPendingActions.status, "pending"),
          lte(mcpPendingActions.expiresAt, now)
        )
      );

    // FOR SHARE: a revoke (or a ban's trigger) must wait for this transaction,
    // and its cancel trigger then sees the row inserted below.
    const [token] = await tx
      .select({
        userId: mcpAccessTokens.userId,
        revokedAt: mcpAccessTokens.revokedAt,
        expiresAt: mcpAccessTokens.expiresAt,
      })
      .from(mcpAccessTokens)
      .where(eq(mcpAccessTokens.id, input.credentialId))
      .for("share");
    const [owner] = await tx
      .select({ email: user.email, role: user.role, banned: user.banned })
      .from(user)
      .where(eq(user.id, input.userId))
      .limit(1);

    if (
      !(token && owner) ||
      token.userId !== input.userId ||
      token.revokedAt !== null ||
      token.expiresAt.getTime() <= now.getTime() ||
      !isEligibleMcpRole(owner.role) ||
      owner.banned === true
    ) {
      return { status: "not_permitted" as const };
    }
    if (!ticket) {
      return { status: "ticket_not_found" as const };
    }
    if (ticket.mergedIntoTicketId) {
      return { status: "ticket_merged" as const };
    }
    if (await isClosedStatusSlug(ticket.status)) {
      return { status: "ticket_closed" as const };
    }

    // ON CONFLICT DO NOTHING against the partial unique index: of any number of
    // concurrent requests exactly one inserts; the rest read its row back.
    for (let attempt = 0; attempt < 2; attempt++) {
      const [created] = await tx
        .insert(mcpPendingActions)
        .values({
          id: input.id ?? createId(),
          kind: input.kind,
          ticketId: input.ticketId,
          requestedById: input.userId,
          credentialId: input.credentialId,
          toolCallId: input.toolCallId ?? null,
          payload,
          status: "pending",
          expiresAt: new Date(now.getTime() + MCP_PENDING_ACTION_TTL_MS),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (created) {
        return {
          status: "created" as const,
          action: created,
          ticketNumber: ticket.ticketNumber,
          subject: ticket.subject,
          ownerEmail: owner.email,
        };
      }
      const [existing] = await tx
        .select()
        .from(mcpPendingActions)
        .where(
          and(
            eq(mcpPendingActions.ticketId, input.ticketId),
            eq(mcpPendingActions.kind, input.kind),
            eq(mcpPendingActions.requestedById, input.userId),
            eq(mcpPendingActions.status, "pending")
          )
        )
        .limit(1);
      if (existing) {
        return { status: "existing" as const, action: existing };
      }
      // The conflicting row was settled between the insert and the read; the
      // index is free again, so insert once more.
    }
    throw new Error("Could not record the pending action.");
  });

  if (outcome.status !== "created") {
    return outcome.status === "existing"
      ? { status: "existing", action: outcome.action }
      : { status: outcome.status };
  }

  const { action, ticketNumber, subject, ownerEmail } = outcome;
  const title =
    action.kind === "close"
      ? `Your AI assistant asks to close #${ticketNumber}`
      : `Your AI assistant asks to send a reply on #${ticketNumber}`;

  // Best effort and never throwing: the request exists either way. None of this
  // carries the reply's content.
  await Promise.all([
    createNotifications([input.userId], {
      type: "mcp_action_pending",
      title,
      body: subject,
      ticketId: input.ticketId,
      ticketNumber,
    }).catch((err) => logFailure("[mcp.action_pending notification]", err)),
    publishPushToUsers([input.userId], {
      title,
      body: subject,
      deepLink: `${env.NEXT_PUBLIC_APP_URL}/tickets/${ticketNumber}`,
      tag: `mcp-action-${action.id}`,
    }).catch((err) => logFailure("[mcp.action_pending push]", err)),
    audit({
      action: "mcp.action_requested",
      entityType: "mcp_pending_action",
      entityId: action.id,
      actorId: input.userId,
      actorEmail: ownerEmail,
      description:
        action.kind === "close"
          ? `AI assistant asked to close ticket #${ticketNumber}`
          : `AI assistant asked to send a reply on ticket #${ticketNumber}`,
      metadata: {
        via: "mcp",
        credentialId: input.credentialId,
        kind: action.kind,
        ticketId: input.ticketId,
        ticketNumber,
        toolCallId: input.toolCallId ?? null,
      },
    }),
  ]);

  return { status: "created", action };
}

/* ------------------------------------------------------------ deciding */

type DecisionRefusal = { status: "not_found" } | { status: "not_pending" };

/** Why a decision matched no row. The same `not_found` answer for a row that
 * doesn't exist, belongs to someone else, or whose owner or credential is no
 * longer in good standing — nothing distinguishes them to the caller. */
async function classifyRefusal(
  actionId: string,
  userId: string
): Promise<DecisionRefusal> {
  const [row] = await db
    .select({
      requestedById: mcpPendingActions.requestedById,
      credentialId: mcpPendingActions.credentialId,
    })
    .from(mcpPendingActions)
    .where(eq(mcpPendingActions.id, actionId))
    .limit(1);
  if (!row || row.requestedById !== userId || !row.credentialId) {
    return { status: "not_found" };
  }
  const [[token], [owner]] = await Promise.all([
    db
      .select({
        userId: mcpAccessTokens.userId,
        revokedAt: mcpAccessTokens.revokedAt,
      })
      .from(mcpAccessTokens)
      .where(eq(mcpAccessTokens.id, row.credentialId))
      .limit(1),
    db
      .select({ role: user.role, banned: user.banned })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1),
  ]);
  if (
    !(token && owner) ||
    token.userId !== userId ||
    token.revokedAt !== null ||
    !isEligibleMcpRole(owner.role) ||
    owner.banned === true
  ) {
    return { status: "not_found" };
  }
  return { status: "not_pending" };
}

async function loadDecisionContext(action: PendingAction) {
  const [[owner], [ticket]] = await Promise.all([
    db
      .select({ name: user.name, email: user.email, role: user.role })
      .from(user)
      .where(eq(user.id, action.requestedById))
      .limit(1),
    db
      .select({ ticketNumber: tickets.ticketNumber })
      .from(tickets)
      .where(eq(tickets.id, action.ticketId))
      .limit(1),
  ]);
  return { owner: owner ?? null, ticketNumber: ticket?.ticketNumber ?? null };
}

export type ApproveOutcome = "closed" | "already_closed" | "replied";

export type ApprovePendingActionResult =
  | DecisionRefusal
  | { status: "approved"; outcome: ApproveOutcome }
  | { status: "failed"; reason: PendingActionFailure }
  // The service threw. The row stays `approved` with no result and the sweeper
  // settles it from the database; nothing is ever re-run.
  | { status: "error" };

/** Settles an approved row; a no-op if the sweeper already did. */
async function settleApproved(
  actionId: string,
  set: Partial<typeof mcpPendingActions.$inferInsert>
) {
  await db
    .update(mcpPendingActions)
    .set({ ...set, updatedAt: new Date() })
    .where(
      and(
        eq(mcpPendingActions.id, actionId),
        eq(mcpPendingActions.status, "approved"),
        isNull(mcpPendingActions.result)
      )
    );
}

async function failApproved(
  actionId: string,
  reason: PendingActionFailure
): Promise<ApprovePendingActionResult> {
  await settleApproved(actionId, { status: "failed", statusReason: reason });
  return { status: "failed", reason };
}

/** What went wrong with the customer-facing notifications, if anything. */
async function notificationErrorsOf(
  email: EmailHandle,
  webhook: WebhookOutcome
): Promise<string[]> {
  const errors: string[] = [];
  const emailError = ((email ? await email : null) as { error?: string } | null)
    ?.error;
  if (emailError) {
    errors.push(emailError);
  }
  if (webhook === "failed") {
    errors.push("webhook_dispatch_failed");
  }
  return errors;
}

async function executeApproved(
  action: PendingAction,
  plannedEntityId: string,
  actor: ServiceActor
): Promise<ApprovePendingActionResult> {
  const activityMetadata: ActivityMetadataExtra = {
    via: "mcp",
    approvedRequestId: action.id,
    ...(action.credentialId ? { credentialId: action.credentialId } : {}),
  };

  if (action.kind === "close") {
    const closed = await closeTicket({
      ticketId: action.ticketId,
      actor,
      activityId: plannedEntityId,
      activityMetadata,
    });
    switch (closed.status) {
      case "closed": {
        const notificationErrors = await notificationErrorsOf(
          closed.email,
          closed.webhook
        );
        await settleApproved(action.id, {
          result: {
            activityId: closed.activityId,
            ...(notificationErrors.length > 0 ? { notificationErrors } : {}),
          },
        });
        return { status: "approved", outcome: "closed" };
      }
      case "already_closed":
        // closeTicket sends nothing in this case.
        await settleApproved(action.id, { result: { alreadyClosed: true } });
        return { status: "approved", outcome: "already_closed" };
      case "merged":
        return await failApproved(action.id, "ticket_merged");
      case "not_found":
        return await failApproved(action.id, "ticket_not_found");
      case "no_closed_status":
        return await failApproved(action.id, "no_closed_status");
      default:
        throw new Error("Unexpected close result.");
    }
  }

  const content = (action.payload as { content?: unknown } | null)?.content;
  if (typeof content !== "string" || isRichTextEmpty(content)) {
    throw new Error("Pending reply has no content.");
  }
  const target = await loadCommentTarget(action.ticketId);
  if (!target) {
    return await failApproved(action.id, "ticket_not_found");
  }
  // The UI refuses replies on a closed ticket, and so does an approval.
  if (await isClosedStatusSlug(target.status)) {
    return await failApproved(action.id, "ticket_closed");
  }
  const limits = await getAttachmentLimits();
  const added = await addTicketComment({
    ticketId: action.ticketId,
    target,
    actor,
    content,
    contentText: richTextToPlainText(content),
    isInternal: false,
    attachments: [],
    commentId: plannedEntityId,
    // The owner's own composer draft is not the reply being sent.
    keepReplyDraft: true,
    maxPerTicketSizeBytes: limits.maxPerTicketSizeBytes,
    activityMetadata,
  });
  switch (added.status) {
    case "ok": {
      const notificationErrors = await notificationErrorsOf(
        added.email,
        added.webhook
      );
      await settleApproved(action.id, {
        result: {
          commentId: added.commentId,
          ...(notificationErrors.length > 0 ? { notificationErrors } : {}),
        },
      });
      return { status: "approved", outcome: "replied" };
    }
    case "exists":
      // The comment is already there under the planned id (another execution
      // got there first); whether its notifications ran is unknown.
      await settleApproved(action.id, {
        result: { commentId: plannedEntityId },
        sideEffectsUncertain: true,
      });
      return { status: "approved", outcome: "replied" };
    case "merged":
      return await failApproved(action.id, "ticket_merged");
    default:
      // No attachments are sent, so a storage check cannot fail.
      throw new Error("Unexpected reply result.");
  }
}

/** The owner approves: one compare-and-set claims the request, then the same
 * service the UI runs executes it as the owner. Only one approval can win. */
export async function approvePendingAction(input: {
  actionId: string;
  userId: string;
}): Promise<ApprovePendingActionResult> {
  const now = new Date();
  const plannedEntityId = createId();
  const [action] = await db
    .update(mcpPendingActions)
    .set({
      status: "approved",
      plannedEntityId,
      decidedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(mcpPendingActions.id, input.actionId),
        eq(mcpPendingActions.requestedById, input.userId),
        actionablePendingSql(now),
        replyGateOpenSql()
      )
    )
    .returning();
  if (!action) {
    return await classifyRefusal(input.actionId, input.userId);
  }

  try {
    const { owner, ticketNumber } = await loadDecisionContext(action);
    if (!owner || (owner.role !== "agent" && owner.role !== "admin")) {
      throw new Error("Approver not found.");
    }
    await audit({
      action: "mcp.action_approved",
      entityType: "mcp_pending_action",
      entityId: action.id,
      actorId: input.userId,
      actorEmail: owner.email,
      description:
        action.kind === "close"
          ? `Approved the AI assistant's request to close ticket #${ticketNumber}`
          : `Approved the AI assistant's reply on ticket #${ticketNumber}`,
      metadata: {
        via: "mcp",
        credentialId: action.credentialId,
        kind: action.kind,
        ticketId: action.ticketId,
        ticketNumber,
        plannedEntityId,
      },
    });
    return await executeApproved(action, plannedEntityId, {
      id: input.userId,
      name: owner.name || owner.email,
      role: owner.role,
    });
  } catch (err) {
    logFailure(
      `[mcp] pending_action_execute_failed id=${action.id}`,
      err instanceof Error ? err.name : typeof err
    );
    return { status: "error" };
  }
}

export type DismissPendingActionResult =
  | DecisionRefusal
  | { status: "dismissed" };

/** The owner declines the request. Nothing else happens. */
export async function dismissPendingAction(input: {
  actionId: string;
  userId: string;
}): Promise<DismissPendingActionResult> {
  const now = new Date();
  const [action] = await db
    .update(mcpPendingActions)
    .set({ status: "dismissed", decidedAt: now, updatedAt: now })
    .where(
      and(
        eq(mcpPendingActions.id, input.actionId),
        eq(mcpPendingActions.requestedById, input.userId),
        actionablePendingSql(now),
        replyGateOpenSql()
      )
    )
    .returning();
  if (!action) {
    return await classifyRefusal(input.actionId, input.userId);
  }

  const { owner, ticketNumber } = await loadDecisionContext(action);
  await audit({
    action: "mcp.action_dismissed",
    entityType: "mcp_pending_action",
    entityId: action.id,
    actorId: input.userId,
    actorEmail: owner?.email ?? null,
    description:
      action.kind === "close"
        ? `Dismissed the AI assistant's request to close ticket #${ticketNumber}`
        : `Dismissed the AI assistant's reply on ticket #${ticketNumber}`,
    metadata: {
      via: "mcp",
      credentialId: action.credentialId,
      kind: action.kind,
      ticketId: action.ticketId,
      ticketNumber,
    },
  });
  return { status: "dismissed" };
}

/* ------------------------------------------------------------- reading */

export type ViewerPendingAction = {
  id: string;
  kind: PendingActionKind;
  /** The reply as stored (Tiptap JSON); null for a close. */
  content: string | null;
  createdAt: Date;
  expiresAt: Date;
  credentialName: string | null;
};

/** The requests the viewer can still decide on one ticket: only their own, and
 * only while actionable. This is what the ticket-page banner shows. */
export async function listActionablePendingActionsForViewer(
  ticketId: string,
  viewerId: string,
  now: Date = new Date()
): Promise<ViewerPendingAction[]> {
  const rows = await db
    .select({
      id: mcpPendingActions.id,
      kind: mcpPendingActions.kind,
      payload: mcpPendingActions.payload,
      createdAt: mcpPendingActions.createdAt,
      expiresAt: mcpPendingActions.expiresAt,
      credentialName: mcpAccessTokens.name,
    })
    .from(mcpPendingActions)
    .leftJoin(
      mcpAccessTokens,
      eq(mcpAccessTokens.id, mcpPendingActions.credentialId)
    )
    .where(
      and(
        eq(mcpPendingActions.ticketId, ticketId),
        eq(mcpPendingActions.requestedById, viewerId),
        actionablePendingSql(now)
      )
    )
    .orderBy(asc(mcpPendingActions.createdAt), asc(mcpPendingActions.id));
  return rows.map((row) => {
    const content = (row.payload as { content?: unknown } | null)?.content;
    return {
      id: row.id,
      kind: row.kind,
      content:
        row.kind === "reply" && typeof content === "string" ? content : null,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      credentialName: row.credentialName,
    };
  });
}

export type AdminPendingAction = {
  id: string;
  kind: PendingActionKind;
  createdAt: Date;
  expiresAt: Date;
  ticketNumber: number;
  ticketSubject: string;
  ownerName: string;
  ownerEmail: string;
};

/** Every request still awaiting its owner, newest first, for the read-only
 * admin list. Deliberately no payload: an admin sees that a reply is waiting,
 * not what it says. */
export async function listPendingActionsForAdmin(
  now: Date = new Date()
): Promise<AdminPendingAction[]> {
  return await db
    .select({
      id: mcpPendingActions.id,
      kind: mcpPendingActions.kind,
      createdAt: mcpPendingActions.createdAt,
      expiresAt: mcpPendingActions.expiresAt,
      ticketNumber: tickets.ticketNumber,
      ticketSubject: tickets.subject,
      ownerName: user.name,
      ownerEmail: user.email,
    })
    .from(mcpPendingActions)
    .innerJoin(tickets, eq(tickets.id, mcpPendingActions.ticketId))
    .innerJoin(user, eq(user.id, mcpPendingActions.requestedById))
    .where(actionablePendingSql(now))
    .orderBy(desc(mcpPendingActions.createdAt), desc(mcpPendingActions.id));
}
