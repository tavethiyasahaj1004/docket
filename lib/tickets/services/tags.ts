import { createId } from "@paralleldrive/cuid2";
import { and, eq } from "drizzle-orm";
import { tags, ticketActivity, tickets, ticketTags } from "@/db/schema";
import { db } from "@/lib/db";
import { getOrCreateTagId, getTicketTags } from "@/lib/tags";
import type { ActivityMetadataExtra, ServiceActor } from "./types";

export interface AddTagInput {
  activityMetadata?: ActivityMetadataExtra;
  actor: ServiceActor;
  /** Already normalized and validated by the caller. */
  name: string;
  now?: Date;
  ticketId: string;
}

export type AddTagResult =
  | { status: "not_found" }
  | {
      status: "added" | "already_linked";
      tags: Awaited<ReturnType<typeof getTicketTags>>;
    };

/** Find-or-creates the tag in the shared pool and links it to the ticket.
 * Idempotent: adding an already-linked tag writes nothing. */
export async function addTagToTicket(
  input: AddTagInput
): Promise<AddTagResult> {
  const { ticketId, actor, name } = input;

  const [ticket] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  if (!ticket) {
    return { status: "not_found" };
  }

  const tagId = await getOrCreateTagId(name);

  const [existingLink] = await db
    .select({ id: ticketTags.id })
    .from(ticketTags)
    .where(and(eq(ticketTags.ticketId, ticketId), eq(ticketTags.tagId, tagId)))
    .limit(1);

  if (existingLink) {
    return {
      status: "already_linked",
      tags: await getTicketTags(ticketId),
    };
  }

  await db.insert(ticketTags).values({
    id: createId(),
    ticketId,
    tagId,
  });

  await db.insert(ticketActivity).values({
    id: createId(),
    ticketId,
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    action: "tag_added",
    metadata: { ...input.activityMetadata, tag: name },
    createdAt: input.now ?? new Date(),
  });

  return { status: "added", tags: await getTicketTags(ticketId) };
}

export interface RemoveTagInput {
  activityMetadata?: ActivityMetadataExtra;
  actor: ServiceActor;
  now?: Date;
  tagId: string;
  ticketId: string;
}

export type RemoveTagResult = { status: "not_linked" } | { status: "removed" };

/** Unlinks a tag from the ticket; the tag itself stays in the shared pool. */
export async function removeTagFromTicket(
  input: RemoveTagInput
): Promise<RemoveTagResult> {
  const { ticketId, actor, tagId } = input;

  const [link] = await db
    .select({ id: ticketTags.id, name: tags.name })
    .from(ticketTags)
    .innerJoin(tags, eq(ticketTags.tagId, tags.id))
    .where(and(eq(ticketTags.ticketId, ticketId), eq(ticketTags.tagId, tagId)))
    .limit(1);
  if (!link) {
    return { status: "not_linked" };
  }

  await db.delete(ticketTags).where(eq(ticketTags.id, link.id));

  await db.insert(ticketActivity).values({
    id: createId(),
    ticketId,
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    action: "tag_removed",
    metadata: { ...input.activityMetadata, tag: link.name },
    createdAt: input.now ?? new Date(),
  });

  return { status: "removed" };
}
