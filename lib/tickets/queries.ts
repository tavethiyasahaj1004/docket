import { asc, count, desc, eq } from "drizzle-orm";
import { user } from "@/db/schema/auth";
import { customers } from "@/db/schema/customers";
import {
  ticketActivity,
  ticketAttachments,
  ticketComments,
  tickets,
} from "@/db/schema/tickets";
import { db } from "@/lib/db";
import { getTicketTags } from "@/lib/tags";
import { resolveMergedTicketId } from "@/lib/tickets/merge";
import {
  buildTicketsWhereClause,
  parseTicketListSort,
  SORT_COLUMNS,
  type TicketListSearchParams,
} from "@/lib/tickets-list-query";

export const DEFAULT_PAGE_SIZE = 25;
// 2 is included alongside the "real" sizes so pagination can be exercised
// with a handful of seeded tickets during local development.
export const PAGE_SIZE_OPTIONS = [2, 10, 25, 50, 100];

/** The agent tickets list: filter/sort/paginate per the URL params. Merged
 * tickets, views and filters are handled by buildTicketsWhereClause. */
export async function listTicketsForAgent({
  params,
  agentId,
  openStatusSlugs,
  pageSizeOverride,
}: {
  params: TicketListSearchParams;
  agentId: string;
  openStatusSlugs: string[];
  /** An exact page size that skips the PAGE_SIZE_OPTIONS check on
   * `params.pageSize`. The agent page never sets it; MCP list_tickets does. */
  pageSizeOverride?: number;
}) {
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const requestedPageSize = Number.parseInt(params.pageSize ?? "", 10);
  const pageSize =
    pageSizeOverride ??
    (PAGE_SIZE_OPTIONS.includes(requestedPageSize)
      ? requestedPageSize
      : DEFAULT_PAGE_SIZE);
  const { sortKey, sortOrder } = parseTicketListSort(params);

  const whereClause = buildTicketsWhereClause(params, agentId, openStatusSlugs);

  const [{ total }] = await db
    .select({ total: count() })
    .from(tickets)
    .innerJoin(customers, eq(tickets.customerId, customers.id))
    .where(whereClause);

  const rows = await db
    .select({
      id: tickets.id,
      ticketNumber: tickets.ticketNumber,
      subject: tickets.subject,
      status: tickets.status,
      category: tickets.category,
      priority: tickets.priority,
      customerId: tickets.customerId,
      customerName: customers.name,
      assignedAgentId: tickets.assignedAgentId,
      assignedAgentName: user.name,
      createdAt: tickets.createdAt,
      updatedAt: tickets.updatedAt,
      closedAt: tickets.closedAt,
      awaitingReply: tickets.awaitingReply,
      waitingSince: tickets.waitingSince,
      firstRespondedAt: tickets.firstRespondedAt,
      slaActiveSeconds: tickets.slaActiveSeconds,
    })
    .from(tickets)
    .innerJoin(customers, eq(tickets.customerId, customers.id))
    .leftJoin(user, eq(tickets.assignedAgentId, user.id))
    .where(whereClause)
    .orderBy(
      sortOrder === "asc"
        ? asc(SORT_COLUMNS[sortKey])
        : desc(SORT_COLUMNS[sortKey])
    )
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return { total, rows, page, pageSize, sortKey, sortOrder };
}

/** One ticket's agent-facing detail (plus tags), or null when it doesn't
 * exist. A merged ticket forwards to the ticket it was merged into
 * (lib/tickets/merge.ts). */
export async function getTicketDetail(ticketId: string) {
  const id = await resolveMergedTicketId(ticketId);
  const [ticket] = await db
    .select({
      id: tickets.id,
      ticketNumber: tickets.ticketNumber,
      subject: tickets.subject,
      description: tickets.description,
      category: tickets.category,
      status: tickets.status,
      priority: tickets.priority,
      customerId: tickets.customerId,
      customerName: customers.name,
      customerEmail: customers.email,
      assignedAgentId: tickets.assignedAgentId,
      closedAt: tickets.closedAt,
      createdAt: tickets.createdAt,
      updatedAt: tickets.updatedAt,
    })
    .from(tickets)
    .innerJoin(customers, eq(tickets.customerId, customers.id))
    .where(eq(tickets.id, id))
    .limit(1);

  if (!ticket) {
    return null;
  }
  const tags = await getTicketTags(id);
  return { ...ticket, tags };
}

/** A ticket's full thread as agents see it (internal notes included). */
export async function getTicketThread(ticketId: string) {
  // All comments — agents see internal notes too
  const comments = await db
    .select()
    .from(ticketComments)
    .where(eq(ticketComments.ticketId, ticketId))
    .orderBy(asc(ticketComments.createdAt));

  const attachments = await db
    .select()
    .from(ticketAttachments)
    .where(eq(ticketAttachments.ticketId, ticketId));

  const activity = await db
    .select()
    .from(ticketActivity)
    .where(eq(ticketActivity.ticketId, ticketId))
    .orderBy(desc(ticketActivity.createdAt));

  return { comments, attachments, activity };
}
