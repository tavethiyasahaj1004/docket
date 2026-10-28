import { eq, sql } from "drizzle-orm";
import { ticketAttachments } from "@/db/schema/tickets";
import type { db } from "@/lib/db";

type Executor = Pick<typeof db, "select">;

/** Combined size in bytes of every attachment on a ticket (all messages and
 * replies, including rows moved in by a merge), summed from the stored
 * `file_size` — the column is NOT NULL and written on every upload path.
 * Pass a transaction to read it inside the reply transaction. */
export async function getTicketAttachmentBytes(
  executor: Executor,
  ticketId: string
): Promise<number> {
  const [row] = await executor
    .select({
      bytes: sql<string>`coalesce(sum(${ticketAttachments.fileSize}), 0)::bigint`,
    })
    .from(ticketAttachments)
    .where(eq(ticketAttachments.ticketId, ticketId));
  return Number(row?.bytes ?? 0);
}
