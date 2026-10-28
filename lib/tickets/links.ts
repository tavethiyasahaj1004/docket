import { createId } from "@paralleldrive/cuid2";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { ticketActivity, ticketLinks, tickets, user } from "@/db/schema";
import { db } from "@/lib/db";
import {
  createNotifications,
  ticketOwnerRecipients,
} from "@/lib/notifications";
import { getTicketActionSettings } from "@/lib/settings";
import { type TicketLinkType, ticketLinkLabel } from "@/lib/tickets/link-types";
import { CONCURRENT_CHANGE_MESSAGE } from "@/lib/tickets/thread-state";

export interface TicketLinkView {
  /** Who added the link — null if that user has since been deleted. */
  createdByName: string | null;
  direction: "outgoing" | "incoming";
  id: string;
  ticket: {
    id: string;
    ticketNumber: number;
    subject: string;
    status: string;
  };
  type: TicketLinkType;
}

const otherTicketColumns = {
  id: tickets.id,
  ticketNumber: tickets.ticketNumber,
  subject: tickets.subject,
  status: tickets.status,
};

/** Every link touching `ticketId`, from either end, oldest first. */
export async function getTicketLinks(
  ticketId: string
): Promise<TicketLinkView[]> {
  const [outgoing, incoming] = await Promise.all([
    db
      .select({
        id: ticketLinks.id,
        type: ticketLinks.type,
        createdAt: ticketLinks.createdAt,
        createdByName: user.name,
        ticket: otherTicketColumns,
      })
      .from(ticketLinks)
      .innerJoin(tickets, eq(ticketLinks.linkedTicketId, tickets.id))
      .leftJoin(user, eq(ticketLinks.createdById, user.id))
      .where(eq(ticketLinks.ticketId, ticketId))
      .orderBy(asc(ticketLinks.createdAt)),
    db
      .select({
        id: ticketLinks.id,
        type: ticketLinks.type,
        createdAt: ticketLinks.createdAt,
        createdByName: user.name,
        ticket: otherTicketColumns,
      })
      .from(ticketLinks)
      .innerJoin(tickets, eq(ticketLinks.ticketId, tickets.id))
      .leftJoin(user, eq(ticketLinks.createdById, user.id))
      .where(eq(ticketLinks.linkedTicketId, ticketId))
      .orderBy(asc(ticketLinks.createdAt)),
  ]);

  return [
    ...outgoing.map((l) => ({ ...l, direction: "outgoing" as const })),
    ...incoming.map((l) => ({ ...l, direction: "incoming" as const })),
  ]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map(({ createdAt: _createdAt, ...l }) => ({
      ...l,
      type: l.type as TicketLinkType,
    }));
}

/** For the ticket list: the numbers of every ticket linked to each of
 * `ticketIds`, from either end. Tickets with no links are absent. */
export async function getLinkedTicketNumbers(
  ticketIds: string[]
): Promise<Record<string, number[]>> {
  if (ticketIds.length === 0) {
    return {};
  }
  const [outgoing, incoming] = await Promise.all([
    db
      .select({ id: ticketLinks.ticketId, other: tickets.ticketNumber })
      .from(ticketLinks)
      .innerJoin(tickets, eq(ticketLinks.linkedTicketId, tickets.id))
      .where(inArray(ticketLinks.ticketId, ticketIds)),
    db
      .select({ id: ticketLinks.linkedTicketId, other: tickets.ticketNumber })
      .from(ticketLinks)
      .innerJoin(tickets, eq(ticketLinks.ticketId, tickets.id))
      .where(inArray(ticketLinks.linkedTicketId, ticketIds)),
  ]);
  const result: Record<string, number[]> = {};
  for (const { id, other } of [...outgoing, ...incoming]) {
    result[id] = [...(result[id] ?? []), other];
  }
  for (const numbers of Object.values(result)) {
    numbers.sort((a, b) => a - b);
  }
  return result;
}

interface Actor {
  id: string;
  name: string;
  role: string;
}

type LinkResult = { ok: true } | { ok: false; error: string; status: number };

/** Links `ticketId` → the ticket numbered `linkedTicketNumber`. Rejects self
 * links, merged tickets, and a second link of the same type between the same
 * pair in either direction. Writes an activity row on both tickets. */
export async function addTicketLink(
  ticketId: string,
  linkedTicketNumber: number,
  type: TicketLinkType,
  actor: Actor
): Promise<LinkResult> {
  const [source] = await db
    .select({
      id: tickets.id,
      ticketNumber: tickets.ticketNumber,
      subject: tickets.subject,
      assignedAgentId: tickets.assignedAgentId,
      mergedIntoTicketId: tickets.mergedIntoTicketId,
    })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  if (!source) {
    return { ok: false, error: "This ticket no longer exists.", status: 404 };
  }

  const [target] = await db
    .select({
      id: tickets.id,
      ticketNumber: tickets.ticketNumber,
      subject: tickets.subject,
      assignedAgentId: tickets.assignedAgentId,
      mergedIntoTicketId: tickets.mergedIntoTicketId,
    })
    .from(tickets)
    .where(eq(tickets.ticketNumber, linkedTicketNumber))
    .limit(1);
  if (!target) {
    return {
      ok: false,
      error: `Ticket #${linkedTicketNumber} not found.`,
      status: 404,
    };
  }
  if (target.id === source.id) {
    return {
      ok: false,
      error: "A ticket can't be linked to itself.",
      status: 400,
    };
  }
  if (source.mergedIntoTicketId || target.mergedIntoTicketId) {
    return {
      ok: false,
      error:
        "Merged tickets can't be linked — link the ticket they were merged into.",
      status: 400,
    };
  }

  // One link per pair and type, in either direction: the reverse of
  // related_to is the same link, and reverse duplicate_of / blocks would be a
  // contradiction (A blocks B and B blocks A). The unique index only covers
  // one direction, so the check runs under a lock on both tickets (in id
  // order, like merge/split — no deadlocks): two agents linking A→B and B→A
  // at once serialize, and a merge landing meanwhile is seen here instead of
  // leaving a link on the hidden merged ticket.
  const now = new Date();
  const conflict = await db.transaction(
    async (tx): Promise<LinkResult | null> => {
      const locked = await tx
        .select({
          id: tickets.id,
          mergedIntoTicketId: tickets.mergedIntoTicketId,
        })
        .from(tickets)
        .where(inArray(tickets.id, [source.id, target.id]))
        .orderBy(asc(tickets.id))
        .for("no key update");
      if (locked.length !== 2 || locked.some((t) => t.mergedIntoTicketId)) {
        return { ok: false, error: CONCURRENT_CHANGE_MESSAGE, status: 409 };
      }

      const [existing] = await tx
        .select({ id: ticketLinks.id })
        .from(ticketLinks)
        .where(
          and(
            eq(ticketLinks.type, type),
            or(
              and(
                eq(ticketLinks.ticketId, source.id),
                eq(ticketLinks.linkedTicketId, target.id)
              ),
              and(
                eq(ticketLinks.ticketId, target.id),
                eq(ticketLinks.linkedTicketId, source.id)
              )
            )
          )
        )
        .limit(1);
      if (existing) {
        return {
          ok: false,
          error: "These tickets are already linked.",
          status: 409,
        };
      }

      await tx.insert(ticketLinks).values({
        id: createId(),
        ticketId: source.id,
        linkedTicketId: target.id,
        type,
        createdById: actor.id,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(ticketActivity).values([
        linkActivity(source.id, "ticket_linked", actor, now, {
          type,
          direction: "outgoing",
          ticketNumber: target.ticketNumber,
        }),
        linkActivity(target.id, "ticket_linked", actor, now, {
          type,
          direction: "incoming",
          ticketNumber: source.ticketNumber,
        }),
      ]);
      return null;
    }
  );
  if (conflict) {
    return conflict;
  }

  if ((await getTicketActionSettings()).ticketLinkNotificationsEnabled) {
    await notifyTicketLinked(source, target, type, actor).catch((err) =>
      console.error("[notification.ticket_linked]", err)
    );
  }
  return { ok: true };
}

/** Removes a link, but only one that actually touches `ticketId` — the link id
 * alone isn't trusted to belong to the ticket in the URL. */
export async function removeTicketLink(
  ticketId: string,
  linkId: string,
  actor: Actor
): Promise<LinkResult> {
  const [link] = await db
    .select({
      id: ticketLinks.id,
      ticketId: ticketLinks.ticketId,
      linkedTicketId: ticketLinks.linkedTicketId,
      type: ticketLinks.type,
    })
    .from(ticketLinks)
    .where(
      and(
        eq(ticketLinks.id, linkId),
        or(
          eq(ticketLinks.ticketId, ticketId),
          eq(ticketLinks.linkedTicketId, ticketId)
        )
      )
    )
    .limit(1);
  if (!link) {
    return {
      ok: false,
      error: "This link no longer exists. Refresh the page.",
      status: 404,
    };
  }

  const ends = await db
    .select({ id: tickets.id, ticketNumber: tickets.ticketNumber })
    .from(tickets)
    .where(
      or(eq(tickets.id, link.ticketId), eq(tickets.id, link.linkedTicketId))
    );
  const numberOf = (id: string) =>
    ends.find((t) => t.id === id)?.ticketNumber ?? null;

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.delete(ticketLinks).where(eq(ticketLinks.id, link.id));
    await tx.insert(ticketActivity).values([
      linkActivity(link.ticketId, "ticket_unlinked", actor, now, {
        type: link.type,
        direction: "outgoing",
        ticketNumber: numberOf(link.linkedTicketId),
      }),
      linkActivity(link.linkedTicketId, "ticket_unlinked", actor, now, {
        type: link.type,
        direction: "incoming",
        ticketNumber: numberOf(link.ticketId),
      }),
    ]);
  });
  return { ok: true };
}

interface LinkEnd {
  assignedAgentId: string | null;
  id: string;
  subject: string;
  ticketNumber: number;
}

/** Notifies the owners of both ends (see ticketOwnerRecipients), so a
 * teammate working the other ticket learns about the link. If one person owns
 * both, they get the message about the other ticket's end. */
async function notifyTicketLinked(
  source: LinkEnd,
  target: LinkEnd,
  type: TicketLinkType,
  actor: Actor
): Promise<void> {
  const [targetRecipients, sourceRecipients] = await ticketOwnerRecipients(
    [target.assignedAgentId, source.assignedAgentId],
    actor.id
  );

  await Promise.all(
    [
      {
        self: target,
        other: source,
        direction: "incoming" as const,
        recipients: targetRecipients,
      },
      {
        self: source,
        other: target,
        direction: "outgoing" as const,
        recipients: sourceRecipients,
      },
    ].map(({ self, other, direction, recipients }) =>
      createNotifications(recipients, {
        type: "ticket_linked",
        title: `${actor.name} linked #${self.ticketNumber} to #${other.ticketNumber}`,
        body: `#${self.ticketNumber} "${self.subject}" is now ${ticketLinkLabel(type, direction).toLowerCase()} #${other.ticketNumber} "${other.subject}".`,
        ticketId: self.id,
        ticketNumber: self.ticketNumber,
      })
    )
  );
}

function linkActivity(
  ticketId: string,
  action: "ticket_linked" | "ticket_unlinked",
  actor: Actor,
  now: Date,
  metadata: Record<string, unknown>
) {
  return {
    id: createId(),
    ticketId,
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    action,
    metadata,
    createdAt: now,
  };
}

/** Identity of a link for duplicate checks: type + unordered pair, matching
 * addTicketLink's "one link per pair and type, either direction" rule. */
export function ticketLinkKey(link: {
  ticketId: string;
  linkedTicketId: string;
  type: string;
}): string {
  const [a, b] = [link.ticketId, link.linkedTicketId].sort();
  return `${link.type}:${a}:${b}`;
}
