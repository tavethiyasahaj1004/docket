import { createId } from "@paralleldrive/cuid2";
import { and, count, desc, eq, or } from "drizzle-orm";
import { ADMIN_ROLE, AGENT_ROLE } from "@/config/platform";
import { notifications, user } from "@/db/schema";
import { db } from "@/lib/db";
import { publishNotificationCreated } from "@/lib/realtime";

export type Notification = typeof notifications.$inferSelect;

export interface NewNotification {
  body?: string;
  ticketId?: string;
  ticketNumber?: number;
  title: string;
  type: string;
}

/** Insert one notification per recipient. No-op for an empty recipient list. */
export async function createNotifications(
  recipientIds: string[],
  data: NewNotification
): Promise<void> {
  const ids = [...new Set(recipientIds)].filter(Boolean);
  if (ids.length === 0) {
    return;
  }

  const now = new Date();
  await db.insert(notifications).values(
    ids.map((userId) => ({
      id: createId(),
      userId,
      type: data.type,
      ticketId: data.ticketId ?? null,
      ticketNumber: data.ticketNumber ?? null,
      title: data.title,
      body: data.body ?? null,
      isRead: false,
      createdAt: now,
    }))
  );

  await Promise.all(
    ids.map((userId) =>
      publishNotificationCreated(userId).catch((err) =>
        console.error("[realtime.notification_created]", err)
      )
    )
  );
}

/** Recipients for an agent action that touches several tickets (link, merge,
 * split), one list per entry of `assignedAgentIds`. Same routing as
 * `customer_replied`: an assigned ticket → its assignee (if not deactivated);
 * unassigned → every active agent/admin. `actorId` is always dropped — they
 * just did it — and each person appears in at most one list (earliest wins),
 * so nobody gets two notifications for one action. */
export async function ticketOwnerRecipients(
  assignedAgentIds: (string | null)[],
  actorId: string
): Promise<string[][]> {
  const activeAgents = await db
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        or(eq(user.role, AGENT_ROLE), eq(user.role, ADMIN_ROLE)),
        eq(user.banned, false)
      )
    );
  return routeOwnerRecipients(
    assignedAgentIds,
    activeAgents.map((a) => a.id),
    actorId
  );
}

/** The pure routing behind ticketOwnerRecipients, given the active
 * agent/admin ids. */
export function routeOwnerRecipients(
  assignedAgentIds: (string | null)[],
  activeIds: string[],
  actorId: string
): string[][] {
  const taken = new Set<string>([actorId]);
  return assignedAgentIds.map((assignedId) => {
    const candidates = assignedId
      ? activeIds.filter((id) => id === assignedId)
      : activeIds;
    const recipients = candidates.filter((id) => !taken.has(id));
    for (const id of recipients) {
      taken.add(id);
    }
    return recipients;
  });
}

export async function listNotifications(
  userId: string,
  limit = 20
): Promise<Notification[]> {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export async function getUnreadCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ c: count() })
    .from(notifications)
    .where(
      and(eq(notifications.userId, userId), eq(notifications.isRead, false))
    );
  return Number(row?.c ?? 0);
}

export async function markNotificationRead(
  userId: string,
  id: string
): Promise<void> {
  await db
    .update(notifications)
    .set({ isRead: true })
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ isRead: true })
    .where(
      and(eq(notifications.userId, userId), eq(notifications.isRead, false))
    );
}
