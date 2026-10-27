import { eq } from "drizzle-orm";
import { tickets } from "@/db/schema/tickets";
import { db } from "@/lib/db";
import { invalidInput, notFound } from "@/lib/mcp/errors";
import { parseTicketNumber } from "@/lib/tickets/route-input";

const TICKET_ID_PATTERN = /^[a-z0-9]{20,32}$/;

export type ParsedTicketRef =
  | { kind: "number"; number: number; id: string | null }
  | { kind: "id"; id: string };

/** Interprets a `ticket` argument: a number (`1042`, `"1042"`, `"#1042"`) or a
 * cuid2 id. Numbers win; a cuid never parses as a positive integer. Null when
 * it is neither. */
export function parseTicketRef(value: unknown): ParsedTicketRef | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const number = parseTicketNumber(value);
  const id =
    typeof value === "string" && TICKET_ID_PATTERN.test(value.trim())
      ? value.trim()
      : null;
  if (number !== null) {
    return { kind: "number", number, id };
  }
  return id ? { kind: "id", id } : null;
}

export type ResolvedTicket = {
  id: string;
  ticketNumber: number;
  /** Set when the requested ticket was merged: the ticket asked for. */
  mergedFrom?: { requested: string };
};

async function findByNumber(number: number) {
  const [row] = await db
    .select({
      id: tickets.id,
      ticketNumber: tickets.ticketNumber,
      mergedIntoTicketId: tickets.mergedIntoTicketId,
    })
    .from(tickets)
    .where(eq(tickets.ticketNumber, number))
    .limit(1);
  return row;
}

async function findById(id: string) {
  const [row] = await db
    .select({
      id: tickets.id,
      ticketNumber: tickets.ticketNumber,
      mergedIntoTicketId: tickets.mergedIntoTicketId,
    })
    .from(tickets)
    .where(eq(tickets.id, id))
    .limit(1);
  return row;
}

/** Resolves a `ticket` argument for a READ: a merged ticket forwards to the
 * ticket it was merged into (merges never chain, so one hop), reported as
 * `mergedFrom`. An unknown ticket is a hint-free `not_found`; a malformed
 * reference is `invalid_input`. */
export async function resolveTicketRef(
  value: unknown
): Promise<ResolvedTicket> {
  const parsed = parseTicketRef(value);
  if (!parsed) {
    throw invalidInput(
      'Invalid ticket reference. Use a ticket number such as 1042 or "#1042", or a ticket id.'
    );
  }

  let found: Awaited<ReturnType<typeof findByNumber>>;
  if (parsed.kind === "number") {
    found = await findByNumber(parsed.number);
    if (!found && parsed.id) {
      found = await findById(parsed.id);
    }
  } else {
    found = await findById(parsed.id);
  }
  if (!found) {
    throw notFound("ticket");
  }

  if (!found.mergedIntoTicketId) {
    return { id: found.id, ticketNumber: found.ticketNumber };
  }
  const target = await findById(found.mergedIntoTicketId);
  if (!target) {
    return { id: found.id, ticketNumber: found.ticketNumber };
  }
  return {
    id: target.id,
    ticketNumber: target.ticketNumber,
    mergedFrom: { requested: `#${found.ticketNumber}` },
  };
}
