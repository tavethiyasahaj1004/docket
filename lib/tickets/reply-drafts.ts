import { and, eq, inArray } from "drizzle-orm";
import { ticketReplyDrafts } from "@/db/schema/reply-drafts";
import { tickets } from "@/db/schema/tickets";
import { db } from "@/lib/db";
import { isRichTextEmpty } from "@/lib/rich-text";

export interface ReplyDraft {
  content: string;
  isInternal: boolean;
  updatedAt: Date;
}

export async function getReplyDraft(
  ticketId: string,
  userId: string
): Promise<ReplyDraft | null> {
  const [row] = await db
    .select({
      content: ticketReplyDrafts.content,
      isInternal: ticketReplyDrafts.isInternal,
      updatedAt: ticketReplyDrafts.updatedAt,
    })
    .from(ticketReplyDrafts)
    .where(
      and(
        eq(ticketReplyDrafts.ticketId, ticketId),
        eq(ticketReplyDrafts.userId, userId)
      )
    )
    .limit(1);
  return row ?? null;
}

/** Ticket IDs (out of `ticketIds`) on which `userId` has an unsent draft —
 * drives the "Draft" marker on the /tickets list. */
export async function getDraftTicketIds(
  ticketIds: string[],
  userId: string
): Promise<Set<string>> {
  if (ticketIds.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ ticketId: ticketReplyDrafts.ticketId })
    .from(ticketReplyDrafts)
    .where(
      and(
        eq(ticketReplyDrafts.userId, userId),
        inArray(ticketReplyDrafts.ticketId, ticketIds)
      )
    );
  return new Set(rows.map((r) => r.ticketId));
}

export async function deleteReplyDraft(ticketId: string, userId: string) {
  await db
    .delete(ticketReplyDrafts)
    .where(
      and(
        eq(ticketReplyDrafts.ticketId, ticketId),
        eq(ticketReplyDrafts.userId, userId)
      )
    );
}

export type SaveReplyDraftResult =
  | { status: "cleared" }
  | { status: "not_found" }
  | { status: "saved"; updatedAt: Date };

/** Upserts the caller's own reply draft. An empty draft deletes the row
 * instead (before any ticket-existence check), so clearing the composer also
 * clears the list's "Draft" marker. */
export async function saveReplyDraft({
  ticketId,
  userId,
  content,
  isInternal,
  now = new Date(),
}: {
  ticketId: string;
  userId: string;
  content: string;
  isInternal: boolean;
  now?: Date;
}): Promise<SaveReplyDraftResult> {
  if (isRichTextEmpty(content)) {
    await deleteReplyDraft(ticketId, userId);
    return { status: "cleared" };
  }

  const [ticket] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  if (!ticket) {
    return { status: "not_found" };
  }

  await db
    .insert(ticketReplyDrafts)
    .values({
      ticketId,
      userId,
      content,
      isInternal,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [ticketReplyDrafts.ticketId, ticketReplyDrafts.userId],
      set: { content, isInternal, updatedAt: now },
    });

  return { status: "saved", updatedAt: now };
}
