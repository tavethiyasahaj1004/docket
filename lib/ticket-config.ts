import { asc, eq } from "drizzle-orm";
import {
  ticketCategories,
  ticketPriorities,
  ticketStatuses,
} from "@/db/schema";
import { getCustomFields } from "@/lib/custom-fields";
import { db } from "@/lib/db";
import { searchTags } from "@/lib/tags";

export type TicketStatus = typeof ticketStatuses.$inferSelect;
export type TicketCategory = typeof ticketCategories.$inferSelect;
export type TicketPriority = typeof ticketPriorities.$inferSelect;

export async function getTicketStatuses(): Promise<TicketStatus[]> {
  return db
    .select()
    .from(ticketStatuses)
    .orderBy(asc(ticketStatuses.sortOrder));
}

export async function getTicketCategories(): Promise<TicketCategory[]> {
  return db
    .select()
    .from(ticketCategories)
    .orderBy(asc(ticketCategories.sortOrder));
}

export async function getTicketPriorities(): Promise<TicketPriority[]> {
  return db
    .select()
    .from(ticketPriorities)
    .orderBy(asc(ticketPriorities.sortOrder));
}

export async function getDefaultPriority(): Promise<
  TicketPriority | undefined
> {
  const [row] = await db
    .select()
    .from(ticketPriorities)
    .where(eq(ticketPriorities.isDefault, true))
    .limit(1);
  return row;
}

export async function getDefaultStatus(): Promise<TicketStatus | undefined> {
  const [row] = await db
    .select()
    .from(ticketStatuses)
    .where(eq(ticketStatuses.isDefault, true))
    .limit(1);
  return row;
}

/** The status a ticket moves to when closed — first one flagged as a closed state. */
export async function getClosedStatus(): Promise<TicketStatus | undefined> {
  const [row] = await db
    .select()
    .from(ticketStatuses)
    .where(eq(ticketStatuses.isClosedState, true))
    .orderBy(asc(ticketStatuses.sortOrder))
    .limit(1);
  return row;
}

/** Slugs of every status flagged as a closed state. Used to make a close
 * UPDATE conditional on the ticket's CURRENT status (`notInArray(status, …)`),
 * so two concurrent closes can't both win. Read per call, not cached: the
 * admin can flag statuses at any time and a stale list would let a ticket in a
 * newly closed status be closed again. Call it AFTER `getClosedStatus()`
 * returned a status, so the list is never empty. */
export async function getClosedStatusSlugs(): Promise<string[]> {
  const rows = await db
    .select({ slug: ticketStatuses.slug })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.isClosedState, true));
  return rows.map((r) => r.slug);
}

/** Whether a given status slug represents a closed state. */
export async function isClosedStatusSlug(slug: string): Promise<boolean> {
  const [row] = await db
    .select({ isClosedState: ticketStatuses.isClosedState })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.slug, slug))
    .limit(1);
  return row?.isClosedState ?? false;
}

/** The valid category/priority/status slugs plus custom fields and the shared
 * tag pool — what GET /api/v1/config serializes. */
export async function getPublicTicketConfig() {
  const [categories, priorities, statuses, customFields, tags] =
    await Promise.all([
      getTicketCategories(),
      getTicketPriorities(),
      getTicketStatuses(),
      getCustomFields(),
      searchTags("", Number.MAX_SAFE_INTEGER),
    ]);

  return {
    categories: categories.map((c) => ({
      slug: c.slug,
      label: c.label,
      color: c.color,
    })),
    priorities: priorities.map((p) => ({
      slug: p.slug,
      label: p.label,
      color: p.color,
      isDefault: p.isDefault,
    })),
    statuses: statuses.map((s) => ({
      slug: s.slug,
      label: s.label,
      color: s.color,
      isDefault: s.isDefault,
      isClosedState: s.isClosedState,
    })),
    customFields: customFields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      options: f.options ?? undefined,
      required: f.required,
    })),
    tags: tags.map((t) => ({ id: t.id, name: t.name })),
  };
}
