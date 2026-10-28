import { eq } from "drizzle-orm";
import { userTicketTablePrefs } from "@/db/schema/user-preferences";
import { db } from "@/lib/db";
import { resolveSendReplyOnEnterPref } from "@/lib/reply-composer-keys";
import { resolveShowSlaAndOverduePref } from "@/lib/sla-display-pref";
import {
  type ColumnPref,
  resolveColumnPrefs,
} from "@/lib/tickets-table-columns";

export async function getTicketTableColumnPrefs(
  userId: string
): Promise<ColumnPref[]> {
  const [row] = await db
    .select({ columns: userTicketTablePrefs.columns })
    .from(userTicketTablePrefs)
    .where(eq(userTicketTablePrefs.userId, userId))
    .limit(1);
  return resolveColumnPrefs(row?.columns);
}

export async function getSendReplyOnEnterPref(
  userId: string
): Promise<boolean> {
  const [row] = await db
    .select({ sendReplyOnEnter: userTicketTablePrefs.sendReplyOnEnter })
    .from(userTicketTablePrefs)
    .where(eq(userTicketTablePrefs.userId, userId))
    .limit(1);
  return resolveSendReplyOnEnterPref(row);
}

export async function getShowSlaAndOverduePref(
  userId: string
): Promise<boolean> {
  const [row] = await db
    .select({ showSlaAndOverdue: userTicketTablePrefs.showSlaAndOverdue })
    .from(userTicketTablePrefs)
    .where(eq(userTicketTablePrefs.userId, userId))
    .limit(1);
  return resolveShowSlaAndOverduePref(row);
}
