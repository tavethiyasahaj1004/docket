import { createId } from "@paralleldrive/cuid2";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  customers,
  ticketActivity,
  ticketAttachments,
  ticketComments,
  ticketCustomFieldValues,
  ticketLinks,
  ticketReplyDrafts,
  ticketStatuses,
  tickets,
  ticketTags,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { enqueueEmail } from "@/lib/email";
import { ticketMergedTemplate } from "@/lib/email/templates/ticket-merged";
import {
  type CancelledPendingAction,
  cancelledActionAudit,
  cancelPendingActionsForMergedTickets,
} from "@/lib/mcp/pending-actions-core";
import {
  createNotifications,
  ticketOwnerRecipients,
} from "@/lib/notifications";
import {
  publishTicketCommentCreated,
  publishTicketCreated,
} from "@/lib/realtime";
import { textToRichTextJson } from "@/lib/rich-text";
import { getTicketActionSettings } from "@/lib/settings";
import { computeSlaTransition } from "@/lib/sla";
import { storage } from "@/lib/storage";
import { getClosedStatus, getTicketStatuses } from "@/lib/ticket-config";
import {
  checkTicketStorage,
  type TicketStorageCheck,
} from "@/lib/tickets/attachment-limits";
import { getTicketAttachmentBytes } from "@/lib/tickets/attachment-usage";
import { ticketLinkKey } from "@/lib/tickets/links";
import { resolveTicketPortalUrl } from "@/lib/tickets/portal-url";
import {
  CONCURRENT_CHANGE_MESSAGE,
  ConcurrentTicketChangeError,
  recomputeAwaitingReply,
} from "@/lib/tickets/thread-state";
import {
  dispatchWebhookEvent,
  ticketPayloadData,
} from "@/lib/webhooks/dispatch";

/** The ticket a request for `ticketId` should act on: itself, or the ticket it
 * was merged into. Merges never chain (see mergeTickets), so one hop is enough.
 * Unknown ids come back unchanged so the caller's own 404 still fires. */
export async function resolveMergedTicketId(ticketId: string): Promise<string> {
  const [row] = await db
    .select({ mergedIntoTicketId: tickets.mergedIntoTicketId })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  return row?.mergedIntoTicketId ?? ticketId;
}

/** Customer-side forwarding. Validates `token` against the ticket it was issued
 * for, then — if that ticket was merged — swaps in the surviving ticket and ITS
 * token. Safe only because merges are same-customer (enforced below), so the
 * customer is never handed a token for someone else's ticket. Null on a bad
 * id/token pair. */
export async function resolveCustomerTicket(
  ticketId: string,
  token: string
): Promise<{ ticketId: string; token: string; merged: boolean } | null> {
  const [row] = await db
    .select({ mergedIntoTicketId: tickets.mergedIntoTicketId })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.customerToken, token)))
    .limit(1);
  if (!row) {
    return null;
  }
  if (!row.mergedIntoTicketId) {
    return { ticketId, token, merged: false };
  }
  const [target] = await db
    .select({ id: tickets.id, customerToken: tickets.customerToken })
    .from(tickets)
    .where(eq(tickets.id, row.mergedIntoTicketId))
    .limit(1);
  return target
    ? { ticketId: target.id, token: target.customerToken, merged: true }
    : null;
}

/** Inserts a reply and its attachment rows unless `ticketId` has been merged
 * by now. Routes forward merged ids up front, but a merge can land between
 * that check and the insert — which, after a large upload, can be seconds. The
 * row lock (FOR SHARE) waits out an in-flight merge and makes a later merge
 * wait for this insert (so it moves the reply), closing the gap where the
 * reply would land on the hidden, closed shell. False = merged meanwhile; the
 * caller cleans up its uploads and asks the user to resend.
 *
 * With attachments, the row is locked FOR UPDATE instead and the ticket's
 * combined attachment size is re-read inside the transaction, so concurrent
 * replies serialize and can't jointly exceed `storageLimitBytes` (the routes'
 * earlier check is only a fast, friendly pre-check). "storage" = it wouldn't
 * fit; nothing was inserted, so the caller deletes only its own uploads. */
export type InsertReplyResult =
  | { status: "ok" }
  | { status: "merged" }
  | { status: "storage"; check: Extract<TicketStorageCheck, { ok: false }> };

export async function insertReplyUnlessMerged(
  ticketId: string,
  comment: typeof ticketComments.$inferInsert,
  attachments: (typeof ticketAttachments.$inferInsert)[],
  storageLimitBytes: number
): Promise<InsertReplyResult> {
  return await db.transaction(async (tx) => {
    const lockQuery = tx
      .select({ mergedIntoTicketId: tickets.mergedIntoTicketId })
      .from(tickets)
      .where(eq(tickets.id, ticketId));
    const [row] =
      attachments.length > 0
        ? await lockQuery.for("update")
        : await lockQuery.for("share");
    if (row?.mergedIntoTicketId) {
      return { status: "merged" };
    }
    if (attachments.length > 0) {
      const check = checkTicketStorage({
        usedBytes: await getTicketAttachmentBytes(tx, ticketId),
        incomingBytes: attachments.reduce((n, a) => n + a.fileSize, 0),
        limitBytes: storageLimitBytes,
      });
      if (!check.ok) {
        return { status: "storage", check };
      }
    }
    await tx.insert(ticketComments).values(comment);
    if (attachments.length > 0) {
      await tx.insert(ticketAttachments).values(attachments);
    }
    return { status: "ok" };
  });
}

/** 409 for a state change (close / reopen / status / field edit) sent to a
 * merged ticket. Those are deliberately NOT forwarded: a stale tab or an
 * integrator's stored id would otherwise silently close or reassign the
 * surviving ticket — a different conversation than the caller meant. Reads
 * and replies still forward. */
export const MERGED_TICKET_CHANGE_MESSAGE =
  "This ticket was merged into another ticket, so it can't be changed. Refresh the page to open the ticket it was merged into.";

export const MERGED_DURING_REPLY_MESSAGE =
  "This ticket was just merged into another ticket, so your message wasn't sent. Refresh the page and send it again.";

/** Hard-deletes `ticketIds` plus every ticket merged into one of them —
 * otherwise a deleted ticket's merged shells would have their pointer nulled
 * by the FK and resurface in lists as closed tickets still holding their
 * original description. The tickets are locked first (FOR UPDATE conflicts
 * with merge's NO KEY UPDATE and its FK check), so a merge into one of them
 * can't land between collecting the shells and deleting: it waits, then finds
 * its target gone and answers 409. Storage files go before the DB rows, per
 * the project rule; a storage failure is non-fatal. */
export async function deleteTicketsWithMergedShells(
  ticketIds: string[]
): Promise<void> {
  if (ticketIds.length === 0) {
    return;
  }
  await db.transaction(async (tx) => {
    await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(inArray(tickets.id, ticketIds))
      .orderBy(asc(tickets.id))
      .for("update");
    const shells = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(inArray(tickets.mergedIntoTicketId, ticketIds));
    const deleteIds = [...new Set([...ticketIds, ...shells.map((t) => t.id)])];

    const attachments = await tx
      .select({ storageKey: ticketAttachments.storageKey })
      .from(ticketAttachments)
      .where(inArray(ticketAttachments.ticketId, deleteIds));
    for (const att of attachments) {
      await storage.delete(att.storageKey).catch(() => undefined);
    }

    // Cascade removes comments, activity, attachments, links, drafts.
    await tx.delete(tickets).where(inArray(tickets.id, deleteIds));
  });
}

/** Before an admin deletes a status / category / priority, moves the merged
 * tickets still using its slug onto a valid value. Merged tickets are hidden
 * and can't be edited (PATCH answers 409), so they're left out of the
 * delete's "in use" count — without this they'd block the delete forever, or
 * keep pointing at a slug that no longer exists. Category/priority take the
 * value of the ticket they were merged into (which can't be using the slug —
 * the caller already checked no visible ticket does); status takes another
 * closed status, since a merged ticket must stay closed. False when merged
 * tickets use the status and no other closed status exists. */
export async function moveMergedTicketsOffSlug(
  column: "status" | "category" | "priority",
  slug: string
): Promise<boolean> {
  if (column === "status") {
    const [replacement] = await db
      .select({ slug: ticketStatuses.slug })
      .from(ticketStatuses)
      .where(
        and(
          eq(ticketStatuses.isClosedState, true),
          ne(ticketStatuses.slug, slug)
        )
      )
      .orderBy(asc(ticketStatuses.sortOrder))
      .limit(1);
    const shells = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          eq(tickets.status, slug),
          sql`${tickets.mergedIntoTicketId} IS NOT NULL`
        )
      )
      .limit(1);
    if (shells.length === 0) {
      return true;
    }
    if (!replacement) {
      return false;
    }
    await db
      .update(tickets)
      .set({ status: replacement.slug })
      .where(
        and(
          eq(tickets.status, slug),
          sql`${tickets.mergedIntoTicketId} IS NOT NULL`
        )
      );
    return true;
  }
  const col = sql.identifier(column);
  await db.execute(sql`
    UPDATE "tickets" AS shell
    SET ${col} = target.${col}
    FROM "tickets" AS target
    WHERE shell."merged_into_ticket_id" = target."id"
      AND shell.${col} = ${slug}
  `);
  return true;
}

/** Route-level forwarding: what every ticket route calls first, so a request
 * for a merged ticket (stale portal tab, old API id) acts on the survivor.
 * With a `token`, it's validated against the requested ticket and swapped for
 * the survivor's; an invalid token is passed through untouched for the
 * route's own token check to reject. */
export async function forwardMergedTicket(
  ticketId: string,
  token?: string
): Promise<{ ticketId: string; token?: string }> {
  if (token) {
    const customer = await resolveCustomerTicket(ticketId, token);
    if (customer) {
      return { ticketId: customer.ticketId, token: customer.token };
    }
  }
  return { ticketId: await resolveMergedTicketId(ticketId), token };
}

interface Actor {
  email?: string;
  id: string;
  name: string;
  role: string;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type MergeResult =
  | { ok: true; targetTicketNumber: number; mergedTicketNumbers: number[] }
  | { ok: false; error: string; status: number };

/** Most tickets one merge can fold in — far above any real duplicate set, it
 * only bounds the single transaction. */
export const MAX_MERGE_SOURCES = 50;

const mergeColumns = {
  id: tickets.id,
  ticketNumber: tickets.ticketNumber,
  subject: tickets.subject,
  description: tickets.description,
  status: tickets.status,
  priority: tickets.priority,
  category: tickets.category,
  customerId: tickets.customerId,
  customerName: customers.name,
  customerEmail: customers.email,
  customerToken: tickets.customerToken,
  apiKeyId: tickets.apiKeyId,
  mergedIntoTicketId: tickets.mergedIntoTicketId,
  assignedAgentId: tickets.assignedAgentId,
  awaitingReply: tickets.awaitingReply,
  waitingSince: tickets.waitingSince,
  firstRespondedAt: tickets.firstRespondedAt,
  closedAt: tickets.closedAt,
  createdAt: tickets.createdAt,
};

/** Merges `sourceId` into the ticket numbered `targetTicketNumber` — the
 * single-ticket case of mergeTicketsInto. */
export function mergeTickets(
  sourceId: string,
  targetTicketNumber: number,
  actor: Actor
): Promise<MergeResult> {
  return mergeTicketsInto([sourceId], targetTicketNumber, actor);
}

/** Merges every ticket in `sourceIds` into the ticket numbered
 * `targetTicketNumber`, all in one transaction — either every source merges or
 * none does. Each source is kept — closed and pointing at the target — so its
 * portal link and API id keep working; everything customer-visible moves to
 * the target. Same-customer only, target must be open, irreversible. The
 * customer gets ONE "Ticket Merged" email covering every source unless an
 * admin turned it off (Ticket Config → Ticket Actions). */
export async function mergeTicketsInto(
  sourceIds: string[],
  targetTicketNumber: number,
  actor: Actor
): Promise<MergeResult> {
  const uniqueSourceIds = [...new Set(sourceIds)];
  if (uniqueSourceIds.length === 0) {
    return {
      ok: false,
      error: "Choose at least one ticket to merge.",
      status: 400,
    };
  }
  if (uniqueSourceIds.length > MAX_MERGE_SOURCES) {
    return {
      ok: false,
      error: `At most ${MAX_MERGE_SOURCES} tickets can be merged at once.`,
      status: 400,
    };
  }

  const [sourceRows, [target]] = await Promise.all([
    db
      .select(mergeColumns)
      .from(tickets)
      .innerJoin(customers, eq(tickets.customerId, customers.id))
      .where(inArray(tickets.id, uniqueSourceIds)),
    db
      .select(mergeColumns)
      .from(tickets)
      .innerJoin(customers, eq(tickets.customerId, customers.id))
      .where(eq(tickets.ticketNumber, targetTicketNumber))
      .limit(1),
  ]);

  if (sourceRows.length !== uniqueSourceIds.length) {
    return {
      ok: false,
      error:
        uniqueSourceIds.length === 1
          ? "This ticket no longer exists."
          : "One of the selected tickets no longer exists. Refresh and try again.",
      status: 404,
    };
  }
  if (!target) {
    return {
      ok: false,
      error: `Ticket #${targetTicketNumber} not found.`,
      status: 404,
    };
  }
  // Oldest first, so the thread notes and the customer email list them in
  // the order the customer opened them.
  const sources = sourceRows.sort((a, b) => a.ticketNumber - b.ticketNumber);
  if (sources.some((s) => s.id === target.id)) {
    return {
      ok: false,
      error: "A ticket can't be merged into itself.",
      status: 400,
    };
  }
  const alreadyMerged = sources.find((s) => s.mergedIntoTicketId);
  if (alreadyMerged) {
    return {
      ok: false,
      error:
        sources.length === 1
          ? "This ticket has already been merged."
          : `Ticket #${alreadyMerged.ticketNumber} has already been merged.`,
      status: 400,
    };
  }
  if (target.mergedIntoTicketId) {
    return {
      ok: false,
      error: `Ticket #${target.ticketNumber} has already been merged into another ticket. Merge into that ticket instead.`,
      status: 400,
    };
  }
  // A source's old portal link forwards to the target with the target's
  // token — across customers that would expose one customer's thread to another.
  if (sources.some((s) => s.customerId !== target.customerId)) {
    return {
      ok: false,
      error: "Only tickets from the same customer can be merged.",
      status: 400,
    };
  }

  const [statuses, closedStatus] = await Promise.all([
    getTicketStatuses(),
    getClosedStatus(),
  ]);
  const isClosed = (slug: string) =>
    statuses.find((s) => s.slug === slug)?.isClosedState ?? false;
  // The customer gets forwarded to the target — it must be one they can reply on.
  if (isClosed(target.status)) {
    return {
      ok: false,
      error: `Ticket #${target.ticketNumber} is closed. Reopen it first.`,
      status: 400,
    };
  }
  // Each source's final status, re-derived from its locked row inside the
  // transaction (for the webhook payload).
  const sourceStatuses = new Map<string, string>();
  // MCP approval requests on the merged-away tickets, cancelled in the
  // transaction and audited once it commits.
  const cancelledActions: CancelledPendingAction[] = [];

  const now = new Date();

  try {
    await runMerge();
  } catch (err) {
    if (err instanceof ConcurrentTicketChangeError) {
      return { ok: false, error: CONCURRENT_CHANGE_MESSAGE, status: 409 };
    }
    throw err;
  }

  // The checks above ran outside the transaction. Lock every row (in id order,
  // so two overlapping merges can't deadlock) and re-check, or two agents
  // merging A→B and B→A at once would leave the pair pointing at each other.
  // NO KEY UPDATE serializes merges/splits without blocking customer replies
  // (their FK check only takes KEY SHARE).
  async function runMerge() {
    await db.transaction(async (tx) => {
      const locked = await tx
        .select({
          id: tickets.id,
          status: tickets.status,
          mergedIntoTicketId: tickets.mergedIntoTicketId,
          awaitingReply: tickets.awaitingReply,
          waitingSince: tickets.waitingSince,
          firstRespondedAt: tickets.firstRespondedAt,
          closedAt: tickets.closedAt,
          createdAt: tickets.createdAt,
        })
        .from(tickets)
        .where(inArray(tickets.id, [target.id, ...uniqueSourceIds]))
        .orderBy(asc(tickets.id))
        .for("no key update");
      const lockedTarget = locked.find((t) => t.id === target.id);
      if (
        !lockedTarget ||
        locked.length !== uniqueSourceIds.length + 1 ||
        locked.some((t) => t.mergedIntoTicketId) ||
        isClosed(lockedTarget.status)
      ) {
        throw new ConcurrentTicketChangeError();
      }

      for (const source of sources) {
        const lockedSource = locked.find((t) => t.id === source.id);
        if (!lockedSource) {
          throw new ConcurrentTicketChangeError();
        }
        await mergeOneSource(tx, source, lockedSource);
      }

      // A pending AI-assistant request on a source would otherwise outlive the
      // ticket it was made on. The target's own requests stay.
      cancelledActions.push(
        ...(await cancelPendingActionsForMergedTickets(tx, uniqueSourceIds))
      );

      // The target's thread was rewritten — recompute "awaiting reply".
      // First response: the target's own; else the earliest source response
      // that came after the target existed — an earlier one would put the
      // first response before the ticket's creation (negative report averages).
      await recomputeAwaitingReply(tx, lockedTarget, now);
      const sourceResponses = locked
        .filter((t) => t.id !== target.id)
        .map((t) => t.firstRespondedAt)
        .filter((d): d is Date => d !== null && d >= lockedTarget.createdAt)
        .sort((a, b) => a.getTime() - b.getTime());
      const firstRespondedAt =
        lockedTarget.firstRespondedAt ?? sourceResponses[0] ?? null;
      await tx
        .update(tickets)
        .set({ firstRespondedAt, updatedAt: now })
        .where(eq(tickets.id, target.id));

      // Paper trail: one internal note on the target (keeps each source's
      // subject, which otherwise only lives on the closed source).
      const mergedList = sources
        .map((s) => `#${s.ticketNumber} ("${s.subject}")`)
        .join(", ");
      await tx.insert(ticketComments).values({
        id: createId(),
        ticketId: target.id,
        authorId: actor.id,
        authorName: actor.name,
        authorRole: actor.role,
        content: textToRichTextJson(
          sources.length === 1
            ? `Ticket ${mergedList} was merged into this ticket. Its messages and attachments now appear here.`
            : `Tickets ${mergedList} were merged into this ticket. Their messages and attachments now appear here.`
        ),
        isInternal: true,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  /** Steps 1–7 for one source, inside the shared transaction. Each step reads
   * the current (in-transaction) state, so a later source sees the links and
   * tags an earlier one already moved onto the target. */
  async function mergeOneSource(
    tx: Tx,
    source: (typeof sources)[number],
    lockedSource: {
      status: string;
      closedAt: Date | null;
      awaitingReply: boolean;
      waitingSince: Date | null;
      createdAt: Date;
    }
  ) {
    // Everything stateful below (SLA clocks, status) uses the locked row,
    // not the pre-lock read — a reply may have moved it in between.
    const sourceWasClosed = isClosed(lockedSource.status);
    const sourceStatus = sourceWasClosed
      ? lockedSource.status
      : (closedStatus?.slug ?? "closed");
    sourceStatuses.set(source.id, sourceStatus);

    // 1. The source's opening message becomes a customer comment on the target,
    // back-dated so it sorts into the thread where it really happened. Its
    // ticket-level attachments ride along on that comment.
    const descriptionCommentId = createId();
    await tx.insert(ticketComments).values({
      id: descriptionCommentId,
      ticketId: target.id,
      authorName: source.customerName,
      authorRole: "customer",
      content: source.description,
      isInternal: false,
      createdAt: source.createdAt,
      updatedAt: now,
    });
    await tx
      .update(ticketAttachments)
      .set({ ticketId: target.id, commentId: descriptionCommentId })
      .where(
        and(
          eq(ticketAttachments.ticketId, source.id),
          isNull(ticketAttachments.commentId)
        )
      );

    // 2. Move the rest of the thread and its files. Storage keys are opaque
    // strings — the files themselves don't move.
    await tx
      .update(ticketComments)
      .set({ ticketId: target.id })
      .where(eq(ticketComments.ticketId, source.id));
    await tx
      .update(ticketAttachments)
      .set({ ticketId: target.id })
      .where(eq(ticketAttachments.ticketId, source.id));

    // 3. Tags: union. Custom fields: the target's own values win; a source
    // only fills fields still empty (the oldest source first).
    const sourceTags = await tx
      .select({ tagId: ticketTags.tagId })
      .from(ticketTags)
      .where(eq(ticketTags.ticketId, source.id));
    if (sourceTags.length > 0) {
      await tx
        .insert(ticketTags)
        .values(
          sourceTags.map((t) => ({
            id: createId(),
            ticketId: target.id,
            tagId: t.tagId,
            createdAt: now,
          }))
        )
        .onConflictDoNothing();
    }
    const sourceFields = await tx
      .select({
        fieldId: ticketCustomFieldValues.fieldId,
        value: ticketCustomFieldValues.value,
      })
      .from(ticketCustomFieldValues)
      .where(eq(ticketCustomFieldValues.ticketId, source.id));
    if (sourceFields.length > 0) {
      await tx
        .insert(ticketCustomFieldValues)
        .values(
          sourceFields.map((f) => ({
            id: createId(),
            ticketId: target.id,
            fieldId: f.fieldId,
            value: f.value,
            createdAt: now,
            updatedAt: now,
          }))
        )
        .onConflictDoNothing();
    }

    // 4. Drafts can't move — the same agent may already have one on the target.
    await tx
      .delete(ticketReplyDrafts)
      .where(eq(ticketReplyDrafts.ticketId, source.id));

    // 5. Links: re-point the source's links at the target, dropping any that
    // would become a self-link (incl. a link between two merged sources) or
    // duplicate an existing one.
    const sourceLinks = await tx
      .select()
      .from(ticketLinks)
      .where(
        or(
          eq(ticketLinks.ticketId, source.id),
          eq(ticketLinks.linkedTicketId, source.id)
        )
      );
    if (sourceLinks.length > 0) {
      await tx.delete(ticketLinks).where(
        inArray(
          ticketLinks.id,
          sourceLinks.map((l) => l.id)
        )
      );
      const repointed = sourceLinks
        .map((l) => ({
          ...l,
          id: createId(),
          ticketId: l.ticketId === source.id ? target.id : l.ticketId,
          linkedTicketId:
            l.linkedTicketId === source.id ? target.id : l.linkedTicketId,
          updatedAt: now,
        }))
        .filter((l) => l.ticketId !== l.linkedTicketId);
      // Drop any that duplicate a link the target already has (or each
      // other) in either direction — onConflictDoNothing only catches the
      // exact same direction.
      const targetLinks = await tx
        .select({
          ticketId: ticketLinks.ticketId,
          linkedTicketId: ticketLinks.linkedTicketId,
          type: ticketLinks.type,
        })
        .from(ticketLinks)
        .where(
          or(
            eq(ticketLinks.ticketId, target.id),
            eq(ticketLinks.linkedTicketId, target.id)
          )
        );
      const seen = new Set(targetLinks.map(ticketLinkKey));
      const toInsert = repointed.filter((l) => {
        const key = ticketLinkKey(l);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
      if (toInsert.length > 0) {
        await tx.insert(ticketLinks).values(toInsert).onConflictDoNothing();
      }
    }

    // 6. Tickets previously merged into the source now forward straight to the
    // target, so resolution is always a single hop.
    await tx
      .update(tickets)
      .set({ mergedIntoTicketId: target.id, updatedAt: now })
      .where(eq(tickets.mergedIntoTicketId, source.id));

    // 7. Close the source and point it at the target.
    await tx
      .update(tickets)
      .set({
        status: sourceStatus,
        closedAt: lockedSource.closedAt ?? now,
        mergedIntoTicketId: target.id,
        mergedAt: now,
        awaitingReply: false,
        pendingReplies: 0,
        updatedAt: now,
        ...(sourceWasClosed
          ? {}
          : computeSlaTransition(lockedSource, false, now, "closing")),
      })
      .where(eq(tickets.id, source.id));

    await tx.insert(ticketActivity).values([
      {
        id: createId(),
        ticketId: source.id,
        actorId: actor.id,
        actorName: actor.name,
        actorRole: actor.role,
        action: "merged_into",
        metadata: { ticketNumber: target.ticketNumber },
        createdAt: now,
      },
      {
        id: createId(),
        ticketId: target.id,
        actorId: actor.id,
        actorName: actor.name,
        actorRole: actor.role,
        action: "merged_from",
        metadata: { ticketNumber: source.ticketNumber },
        createdAt: now,
      },
    ]);
  }

  for (const cancelled of cancelledActions) {
    await audit(
      cancelledActionAudit(cancelled, {
        actorEmail: actor.email,
        actorId: actor.id,
        reason: "ticket_merged",
      })
    );
  }

  // Side effects, best effort — the merge itself is committed. Refresh anyone
  // viewing any of the tickets or the list (no-op without Pusher Channels).
  await Promise.all([
    ...sources.map((s) => publishTicketCommentCreated(s.id)),
    publishTicketCommentCreated(target.id),
    publishTicketCreated(),
  ]).catch((err) => console.error("[realtime.ticket_merged]", err));

  const actionSettings = await getTicketActionSettings();
  const sourceNumbers = sources.map((s) => `#${s.ticketNumber}`).join(", ");

  // Tell the customer where the conversation continues — one email for the
  // whole merge, not one per source. Same-customer only, so the target's link
  // (and token) is theirs. enqueueEmail drops it when the admin turned ticket
  // emails off altogether.
  if (actionSettings.ticketMergeCustomerEmailEnabled) {
    const ticketUrl = await resolveTicketPortalUrl(
      target.id,
      target.customerToken,
      target.apiKeyId
    );
    await ticketMergedTemplate({
      customerName: target.customerName,
      mergedTickets: sources.map((s) => ({
        ticketNumber: s.ticketNumber,
        subject: s.subject,
      })),
      ticketNumber: target.ticketNumber,
      ticketSubject: target.subject,
      ticketUrl,
    })
      .then(({ subject: emailSubject, html, text }) =>
        enqueueEmail({
          to: target.customerEmail,
          subject: emailSubject,
          html,
          text,
          category: "ticket",
        })
      )
      .catch((err) => console.error("[ticket.merged email]", err));
  }

  // Tell the owners: the sources' owners see their tickets vanish from the
  // list, the target's owner gets new messages in theirs. Each person gets
  // one notification (routeOwnerRecipients dedupes across tickets); all of
  // them open the target — the sources only redirect there anyway.
  if (actionSettings.ticketMergeNotificationsEnabled) {
    const title = `${actor.name} merged ${sourceNumbers} into #${target.ticketNumber}`;
    await ticketOwnerRecipients(
      [target.assignedAgentId, ...sources.map((s) => s.assignedAgentId)],
      actor.id
    )
      .then(([targetRecipients, ...sourceRecipients]) =>
        Promise.all([
          createNotifications(targetRecipients, {
            type: "ticket_merged",
            title,
            body: `Messages and attachments from ${sourceNumbers} were added to #${target.ticketNumber}.`,
            ticketId: target.id,
            ticketNumber: target.ticketNumber,
          }),
          createNotifications(sourceRecipients.flat(), {
            type: "ticket_merged",
            title,
            body: `${sourceNumbers} ${sources.length === 1 ? "is" : "are"} closed; the conversation now continues in #${target.ticketNumber} "${target.subject}".`,
            ticketId: target.id,
            ticketNumber: target.ticketNumber,
          }),
        ])
      )
      .catch((err) => console.error("[notification.ticket_merged]", err));
  }

  // Per source, so the audit log and integrators see the same one-ticket
  // record whether it was merged alone or alongside others. Irreversible, so
  // it goes in the admin audit log. Only ticket.merged — not also
  // ticket.closed for the source, since integrators commonly email the
  // customer on ticket.closed, and the merge has its own customer email.
  for (const source of sources) {
    await audit({
      action: "ticket.merged",
      actorEmail: actor.email,
      actorId: actor.id,
      description: `Merged ticket #${source.ticketNumber} into #${target.ticketNumber}`,
      entityId: target.id,
      entityType: "ticket",
      metadata: {
        sourceTicketId: source.id,
        sourceTicketNumber: source.ticketNumber,
        targetTicketNumber: target.ticketNumber,
      },
    }).catch((err) => console.error("[audit.ticket_merged]", err));

    await dispatchWebhookEvent("ticket.merged", "ticket", target.id, {
      ticket: ticketPayloadData({ ...target, updatedAt: now }),
      mergedTicket: ticketPayloadData({
        ...source,
        status: sourceStatuses.get(source.id) ?? source.status,
        updatedAt: now,
      }),
    }).catch((err) => console.error("[webhook.ticket_merged]", err));
  }

  return {
    ok: true,
    targetTicketNumber: target.ticketNumber,
    mergedTicketNumbers: sources.map((s) => s.ticketNumber),
  };
}
