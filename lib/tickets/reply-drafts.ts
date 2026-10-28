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

/** Generous ceiling for a Tiptap JSON reply: only here to stop the autosave
 * endpoint (and the MCP draft tool) from being used to park arbitrarily large
 * blobs in the DB. */
export const MAX_DRAFT_LENGTH = 200_000;

export type SaveReplyDraftResult =
  | { status: "cleared" }
  | { status: "not_found" }
  | { status: "saved"; updatedAt: Date };

/** Result of the conditional save (`ifNoDifferentDraft`). */
export type ConditionalSaveReplyDraftResult =
  | { status: "rejected_empty" }
  | { status: "not_found" }
  | { status: "saved"; updatedAt: Date }
  /** The caller already has exactly this draft (same content and visibility). */
  | { status: "unchanged"; updatedAt: Date }
  /** The caller already has a different draft, which was left untouched. */
  | { status: "conflict"; updatedAt: Date };

interface SaveReplyDraftInput {
  content: string;
  isInternal: boolean;
  now?: Date;
  ticketId: string;
  userId: string;
}

/** Inserts the draft unless the caller already has one for this ticket.
 * Returns the new row's timestamp, or null when a draft was already there. */
async function insertDraftIfAbsent(
  input: SaveReplyDraftInput,
  now: Date
): Promise<Date | null> {
  const [inserted] = await db
    .insert(ticketReplyDrafts)
    .values({
      ticketId: input.ticketId,
      userId: input.userId,
      content: input.content,
      isInternal: input.isInternal,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [ticketReplyDrafts.ticketId, ticketReplyDrafts.userId],
    })
    .returning({ updatedAt: ticketReplyDrafts.updatedAt });
  return inserted ? inserted.updatedAt : null;
}

/** The MCP save: writes the draft only when the caller has none. An existing
 * draft is NEVER modified or deleted here, which is what keeps a racing UI
 * autosave safe: the insert either lands first (and the autosave then
 * overwrites it, as any autosave would) or finds the autosaved row and leaves
 * it alone. */
async function saveReplyDraftIfNoDifferent(
  input: SaveReplyDraftInput
): Promise<ConditionalSaveReplyDraftResult> {
  const { ticketId, userId, content, isInternal } = input;
  if (isRichTextEmpty(content)) {
    // Never a delete: an empty body must not wipe the agent's own draft.
    return { status: "rejected_empty" };
  }
  const [ticket] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  if (!ticket) {
    return { status: "not_found" };
  }

  const now = input.now ?? new Date();
  // Twice at most: a draft that vanishes between the failed insert and the
  // read (the agent discarded it) gets one more insert.
  for (let attempt = 0; attempt < 2; attempt++) {
    const insertedAt = await insertDraftIfAbsent(input, now);
    if (insertedAt) {
      return { status: "saved", updatedAt: insertedAt };
    }
    const existing = await getReplyDraft(ticketId, userId);
    if (existing) {
      return {
        status:
          existing.content === content && existing.isInternal === isInternal
            ? "unchanged"
            : "conflict",
        updatedAt: existing.updatedAt,
      };
    }
  }
  // Racing a discard and a re-save twice over: report it as a conflict rather
  // than overwrite whatever is there now.
  const latest = await getReplyDraft(ticketId, userId);
  return { status: "conflict", updatedAt: latest?.updatedAt ?? now };
}

/** Upserts the caller's own reply draft. An empty draft deletes the row
 * instead (before any ticket-existence check), so clearing the composer also
 * clears the list's "Draft" marker.
 *
 * With `ifNoDifferentDraft` it never overwrites or deletes (see
 * {@link saveReplyDraftIfNoDifferent}); without it the behaviour is the
 * upsert the draft route always had. */
export function saveReplyDraft(
  input: SaveReplyDraftInput & { ifNoDifferentDraft: true }
): Promise<ConditionalSaveReplyDraftResult>;
export function saveReplyDraft(
  input: SaveReplyDraftInput & { ifNoDifferentDraft?: false }
): Promise<SaveReplyDraftResult>;
export function saveReplyDraft(
  input: SaveReplyDraftInput & { ifNoDifferentDraft?: boolean }
): Promise<SaveReplyDraftResult | ConditionalSaveReplyDraftResult> {
  if (input.ifNoDifferentDraft) {
    return saveReplyDraftIfNoDifferent(input);
  }
  return saveReplyDraftUpsert(input);
}

async function saveReplyDraftUpsert({
  ticketId,
  userId,
  content,
  isInternal,
  now = new Date(),
}: SaveReplyDraftInput): Promise<SaveReplyDraftResult> {
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
