// Shared plumbing for the MCP pending-action (WP4) integration tests: the
// seeded world (the write-characterization world plus MCP tokens), the session
// mock, request builders for the approve/dismiss routes, and row readers.
import { createId } from "@paralleldrive/cuid2";
import { and, asc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  auditLogs,
  emailOutbox,
  mcpPendingActions,
  notifications,
  ticketActivity,
  ticketComments,
  tickets,
  webhookDeliveries,
} from "@/db/schema";
import { db } from "@/lib/db";
import {
  callLog,
  getSession,
  seedWriteWorld,
} from "./characterization/write-helpers";
import { doc, tid, USERS } from "./fixtures";
import { addToken, addUser } from "./mcp-helpers";

export { callLog, getSession, USERS };

export const ALICE = USERS.alice.id; // agent
export const BOB = USERS.bob.id; // admin
export const DAVE = USERS.dave.id; // plain "user" role
export const CAROL = USERS.carol.id; // banned agent
export const FRANK = "user-frank"; // a second, active agent

export const TOK_ALICE = "tok-alice";
export const TOK_BOB = "tok-bob";
export const TOK_FRANK = "tok-frank";
export const TOK_CAROL = "tok-carol"; // a banned agent's token (inserted directly)
export const TOK_DAVE = "tok-dave"; // a plain user's token (inserted directly)

export const T_OPEN = tid(101); // open, Ann, assigned to Alice
export const T_OTHER_OPEN = tid(109); // open, Ann (same customer as 101)
export const T_CLOSED = tid(107);
export const T_MERGED = tid(120); // merged into 101

/** A distinctive string that must never leak outside the owner's banner. */
export const SECRET = "ZXQ-secret-reply-7391";
export const REPLY = doc(SECRET);

export const HOUR = 60 * 60 * 1000;

const SESSIONS = {
  alice: {
    user: {
      id: ALICE,
      role: "agent",
      name: USERS.alice.name,
      email: USERS.alice.email,
    },
  },
  bob: {
    user: {
      id: BOB,
      role: "admin",
      name: USERS.bob.name,
      email: USERS.bob.email,
    },
  },
  frank: {
    user: {
      id: FRANK,
      role: "agent",
      name: `Name ${FRANK}`,
      email: `${FRANK}@example.test`,
    },
  },
  dave: {
    user: {
      id: DAVE,
      role: "user",
      name: USERS.dave.name,
      email: USERS.dave.email,
    },
  },
} as const;

export type Caller = keyof typeof SESSIONS;

/** The session is chosen per request by the `x-test-user` header; no header is
 * an anonymous caller. */
export function installSessionMock() {
  getSession.mockReset();
  getSession.mockImplementation((opts: { headers: Headers }) => {
    const who = opts.headers.get("x-test-user") as Caller | null;
    return Promise.resolve(who ? SESSIONS[who] : null);
  });
}

/** The write world (users, tickets, one webhook endpoint subscribed to the
 * ticket events) plus MCP tokens for Alice, Bob and a second agent, Frank. */
export async function seedPendingWorld() {
  await seedWriteWorld({
    extra: async (seedDb) => {
      await addUser(seedDb, { id: FRANK, role: "agent" });
      await addToken(seedDb, ALICE, { id: TOK_ALICE, name: "Alice laptop" });
      await addToken(seedDb, BOB, { id: TOK_BOB, name: "Bob laptop" });
      await addToken(seedDb, FRANK, { id: TOK_FRANK, name: "Frank laptop" });
      // Inserting a token fires no trigger, so these exist for ineligible owners.
      await addToken(seedDb, CAROL, { id: TOK_CAROL });
      await addToken(seedDb, DAVE, { id: TOK_DAVE });
    },
  });
}

export function actionRequest(
  verb: "approve" | "dismiss",
  actionId: string,
  as?: Caller
) {
  return new NextRequest(
    `http://localhost:3000/api/mcp/actions/${actionId}/${verb}`,
    { method: "POST", headers: as ? { "x-test-user": as } : {} }
  );
}

export const routeCtx = (id: string) => ({ params: Promise.resolve({ id }) });

export async function body(res: Response) {
  return { status: res.status, body: (await res.json()) as unknown };
}

/** Inserts an action row directly, bypassing createPendingAction. */
export async function insertAction(
  over: Partial<typeof mcpPendingActions.$inferInsert> = {}
) {
  const [row] = await db
    .insert(mcpPendingActions)
    .values({
      id: createId(),
      kind: "close",
      ticketId: T_OPEN,
      requestedById: ALICE,
      credentialId: TOK_ALICE,
      payload: {},
      status: "pending",
      expiresAt: new Date(Date.now() + HOUR),
      ...over,
    })
    .returning();
  return row;
}

export async function getAction(id: string) {
  const [row] = await db
    .select()
    .from(mcpPendingActions)
    .where(eq(mcpPendingActions.id, id));
  return row;
}

export async function allActions() {
  return await db
    .select()
    .from(mcpPendingActions)
    .orderBy(asc(mcpPendingActions.createdAt), asc(mcpPendingActions.id));
}

/** Everything an approval could change, for "nothing happened" assertions. */
export async function snapshot(ticketId: string = T_OPEN) {
  const [ticket] = await db
    .select({ status: tickets.status, closedAt: tickets.closedAt })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  const comments = await db
    .select({ id: ticketComments.id })
    .from(ticketComments)
    .where(eq(ticketComments.ticketId, ticketId));
  const activity = await db
    .select({ id: ticketActivity.id })
    .from(ticketActivity)
    .where(eq(ticketActivity.ticketId, ticketId));
  return {
    status: ticket.status,
    closedAt: ticket.closedAt,
    comments: comments.length,
    activity: activity.length,
    emails: (await db.select({ id: emailOutbox.id }).from(emailOutbox)).length,
    deliveries: (
      await db.select({ id: webhookDeliveries.id }).from(webhookDeliveries)
    ).length,
  };
}

export async function deliveriesOf(event: string) {
  return await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.event, event));
}

export async function activityOf(ticketId: string, action: string) {
  return await db
    .select()
    .from(ticketActivity)
    .where(
      and(
        eq(ticketActivity.ticketId, ticketId),
        eq(ticketActivity.action, action)
      )
    );
}

export async function auditOf(action: string) {
  return await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.action, action))
    .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id));
}

export async function notificationsOf(type: string) {
  return await db
    .select()
    .from(notifications)
    .where(eq(notifications.type, type));
}

export const pushCalls = () =>
  callLog.filter((c) => c.call === "push.publishPushToUsers");
