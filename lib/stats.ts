import { and, count, gte, inArray, isNull, sql } from "drizzle-orm";
import { tickets } from "@/db/schema";
import { db } from "@/lib/db";
import { getTicketStatuses } from "@/lib/ticket-config";

export async function getOverviewStats() {
  const statuses = await getTicketStatuses();
  const closedSlugs = new Set(
    statuses.filter((s) => s.isClosedState).map((s) => s.slug)
  );
  const defaultSlug = statuses.find((s) => s.isDefault)?.slug;
  const nonClosedSlugs = statuses
    .filter((s) => !s.isClosedState)
    .map((s) => s.slug);

  const statusCounts = await db
    .select({ status: tickets.status, c: count() })
    .from(tickets)
    // Merged tickets are hidden from the ticket list these counts link to.
    .where(isNull(tickets.mergedIntoTicketId))
    .groupBy(tickets.status);

  let open = 0;
  let inProgress = 0;
  let closed = 0;
  let total = 0;
  for (const row of statusCounts) {
    const c = Number(row.c);
    total += c;
    if (closedSlugs.has(row.status)) {
      closed += c;
    } else if (row.status === defaultSlug) {
      open += c;
    } else {
      inProgress += c;
    }
  }

  const [waitRow] = nonClosedSlugs.length
    ? await db
        .select({
          avgWaitSeconds: sql<
            number | null
          >`EXTRACT(EPOCH FROM AVG(NOW() - ${tickets.createdAt}))`,
        })
        .from(tickets)
        .where(
          and(
            inArray(tickets.status, nonClosedSlugs),
            isNull(tickets.mergedIntoTicketId)
          )
        )
    : [{ avgWaitSeconds: null }];

  return {
    total,
    open,
    inProgress,
    closed,
    avgWaitMs:
      waitRow.avgWaitSeconds == null
        ? null
        : Number(waitRow.avgWaitSeconds) * 1000,
  };
}

export async function getVolumeStats(days: number) {
  const since = new Date();
  since.setDate(since.getDate() - days + 1);
  since.setHours(0, 0, 0, 0);

  const rows = await db
    .select({
      date: sql<string>`DATE(${tickets.createdAt})::text`,
      count: count(),
    })
    .from(tickets)
    .where(
      and(gte(tickets.createdAt, since), isNull(tickets.mergedIntoTicketId))
    )
    .groupBy(sql`DATE(${tickets.createdAt})`)
    .orderBy(sql`DATE(${tickets.createdAt})`);

  // Build full date range with zeros filled in
  const countMap = new Map(rows.map((r) => [r.date, Number(r.count)]));
  const result: { date: string; count: number }[] = [];

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    result.push({ date: key, count: countMap.get(key) ?? 0 });
  }

  return { days: result };
}
