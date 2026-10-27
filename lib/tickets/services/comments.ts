import { createId } from "@paralleldrive/cuid2";
import { and, eq, isNull } from "drizzle-orm";
import { customers, ticketActivity, tickets } from "@/db/schema";
import { db } from "@/lib/db";
import { ticketRepliedTemplate } from "@/lib/email/templates/ticket-replied";
import { publishTicketCommentCreated } from "@/lib/realtime";
import { computeSlaTransition } from "@/lib/sla";
import type { TicketStorageCheck } from "@/lib/tickets/attachment-limits";
import { insertReplyUnlessMerged } from "@/lib/tickets/merge";
import { resolveTicketPortalUrl } from "@/lib/tickets/portal-url";
import { deleteReplyDraft } from "@/lib/tickets/reply-drafts";
import { isUniqueViolation } from "@/lib/tickets/route-input";
import {
  dispatchWebhookEvent,
  ticketPayloadData,
} from "@/lib/webhooks/dispatch";
import { awaitWebhook, queueTicketEmail } from "./outcomes";
import type {
  ActivityMetadataExtra,
  EmailHandle,
  ServiceActor,
  WebhookOutcome,
} from "./types";

/** The ticket + customer columns a comment needs (agent branch of the route). */
export async function loadCommentTarget(ticketId: string) {
  const [ticket] = await db
    .select({
      status: tickets.status,
      customerName: customers.name,
      customerEmail: customers.email,
      customerToken: tickets.customerToken,
      ticketNumber: tickets.ticketNumber,
      subject: tickets.subject,
      category: tickets.category,
      priority: tickets.priority,
      assignedAgentId: tickets.assignedAgentId,
      apiKeyId: tickets.apiKeyId,
      awaitingReply: tickets.awaitingReply,
      waitingSince: tickets.waitingSince,
      firstRespondedAt: tickets.firstRespondedAt,
    })
    .from(tickets)
    .innerJoin(customers, eq(tickets.customerId, customers.id))
    .where(eq(tickets.id, ticketId))
    .limit(1);
  return ticket ?? null;
}

export type CommentTarget = NonNullable<
  Awaited<ReturnType<typeof loadCommentTarget>>
>;

/** An attachment whose file is already in storage. */
export interface UploadedAttachment {
  filename: string;
  fileSize: number;
  id: string;
  mimeType: string;
  storageKey: string;
}

export interface AddTicketCommentInput {
  activityId?: string;
  activityMetadata?: ActivityMetadataExtra;
  actor: ServiceActor;
  attachments: UploadedAttachment[];
  /** Caller-supplied id (idempotency): a unique violation on it answers
   * `exists`. Omit to have one generated. */
  commentId?: string;
  content: string;
  contentText: string;
  isInternal: boolean;
  maxPerTicketSizeBytes: number;
  now?: Date;
  target: CommentTarget;
  ticketId: string;
}

export type AddTicketCommentResult =
  | {
      status: "ok";
      commentId: string;
      activityId: string;
      webhook: WebhookOutcome;
      email: EmailHandle;
    }
  | { status: "merged" }
  | { status: "storage"; check: Extract<TicketStorageCheck, { ok: false }> }
  | { status: "exists" };

/** Adds an agent/admin reply or internal note. Storage uploads/cleanup stay
 * with the caller. */
export async function addTicketComment(
  input: AddTicketCommentInput
): Promise<AddTicketCommentResult> {
  const { ticketId, target, actor, isInternal, contentText } = input;
  const callerSuppliedId = input.commentId !== undefined;
  const commentId = input.commentId ?? createId();
  const activityId = input.activityId ?? createId();
  const now = input.now ?? new Date();

  let inserted: Awaited<ReturnType<typeof insertReplyUnlessMerged>>;
  try {
    inserted = await insertReplyUnlessMerged(
      ticketId,
      {
        id: commentId,
        ticketId,
        authorId: actor.id,
        authorName: actor.name,
        authorRole: actor.role,
        content: input.content,
        isInternal,
        createdAt: now,
        updatedAt: now,
      },
      input.attachments.map((a) => ({
        id: a.id,
        ticketId,
        commentId,
        filename: a.filename,
        storageKey: a.storageKey,
        fileSize: a.fileSize,
        mimeType: a.mimeType,
        uploadedById: actor.id,
        uploadedByName: actor.name,
        uploadedByRole: actor.role,
        createdAt: now,
      })),
      input.maxPerTicketSizeBytes
    );
  } catch (err) {
    if (callerSuppliedId && isUniqueViolation(err)) {
      return { status: "exists" };
    }
    throw err;
  }
  if (inserted.status !== "ok") {
    return inserted;
  }

  // The reply is out — drop the agent's saved draft for this ticket so the
  // composer and the /tickets "Draft" marker don't resurrect it. Best
  // effort: the comment row is already written, so a failure here must not
  // report the reply as failed (the agent would resend it, duplicating it).
  await deleteReplyDraft(ticketId, actor.id).catch((err) =>
    console.error("[reply-draft.delete]", err)
  );

  // Maintain the "awaiting reply" flag + unread count. Internal notes don't
  // change it (they're not customer-facing conversation), nor SLA pause/resume
  // (see lib/sla.ts), which rides the same awaitingReply signal.
  const awaitingUpdate = isInternal
    ? {}
    : { awaitingReply: false, pendingReplies: 0 };
  const slaUpdate = isInternal
    ? {}
    : computeSlaTransition(
        {
          awaitingReply: target.awaitingReply,
          waitingSince: target.waitingSince,
        },
        false,
        now
      );
  const firstResponseUpdate =
    !isInternal && !target.firstRespondedAt ? { firstRespondedAt: now } : {};

  await db
    .update(tickets)
    .set({
      updatedAt: now,
      ...awaitingUpdate,
      ...slaUpdate,
      ...firstResponseUpdate,
    })
    .where(and(eq(tickets.id, ticketId), isNull(tickets.mergedIntoTicketId)));

  await db.insert(ticketActivity).values({
    id: activityId,
    ticketId,
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    action: isInternal ? "internal_note_added" : "comment_added",
    ...(input.activityMetadata
      ? { metadata: { ...input.activityMetadata } }
      : {}),
    createdAt: now,
  });

  // Live-refresh anyone currently viewing this ticket. No-op unless Pusher
  // Channels is configured.
  await publishTicketCommentCreated(ticketId).catch((err) =>
    console.error("[realtime.comment_created]", err)
  );

  if (isInternal) {
    // Internal notes never leave the building: no webhook, no customer email.
    return {
      status: "ok",
      commentId,
      activityId,
      webhook: "none",
      email: null,
    };
  }

  const webhook = await awaitWebhook(
    "[webhook.ticket_replied]",
    dispatchWebhookEvent("ticket.replied", "ticket", ticketId, {
      ticket: ticketPayloadData({
        id: ticketId,
        ticketNumber: target.ticketNumber,
        subject: target.subject,
        status: target.status,
        priority: target.priority,
        category: target.category,
        customerName: target.customerName,
        customerEmail: target.customerEmail,
        createdAt: now,
        updatedAt: now,
      }),
      comment: {
        authorName: actor.name,
        authorRole: actor.role,
        content: contentText,
        createdAt: now.toISOString(),
      },
    })
  );

  // Notify the customer of the public reply (fire-and-forget).
  const ticketUrl = await resolveTicketPortalUrl(
    ticketId,
    target.customerToken,
    target.apiKeyId
  );
  const email = queueTicketEmail({
    label: "[ticket.replied email]",
    to: target.customerEmail,
    render: () =>
      ticketRepliedTemplate({
        customerName: target.customerName,
        ticketNumber: target.ticketNumber,
        ticketSubject: target.subject,
        replyContent: contentText,
        ticketUrl,
        agentName: actor.name,
      }),
  });

  return { status: "ok", commentId, activityId, webhook, email };
}
