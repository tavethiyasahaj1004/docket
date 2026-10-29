// Shared plumbing for the Phase 6 MCP tool tests (manage tools, approval
// tools, the customer-replies gate): the seeded world, token + client setup,
// the session mock for the approve/dismiss routes, and row readers.
//
// The importing test file must register the usual module mocks itself
// (`vi.mock` is hoisted per file): @/lib/auth, @/lib/worker/enqueue,
// @/lib/realtime and @/lib/push, each backed by ./characterization/write-helpers.
import { asc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { expect } from "vitest";
import { POST as APPROVE } from "@/app/api/mcp/actions/[id]/approve/route";
import { POST as DISMISS } from "@/app/api/mcp/actions/[id]/dismiss/route";
import * as schema from "@/db/schema";
import { db } from "@/lib/db";
import { FORBIDDEN_OUTPUT_PATTERNS } from "@/lib/mcp/dto";
import { MCP_ERROR_DETAIL_KEYS } from "@/lib/mcp/errors";
import {
  ALL_TICKET_EVENTS,
  callLog,
  enqueueMode,
  getSession,
} from "./characterization/write-helpers";
import { CUSTOMERS, doc, tid, USERS } from "./fixtures";
import { addToken, addUser, type McpWorld } from "./mcp-helpers";
import {
  ALICE,
  BOB,
  callTool,
  connectMcp,
  seedReadWorld,
  type ToolOutcome,
} from "./mcp-read-helpers";

export { ALICE, BOB, CUSTOMERS, callLog, doc, tid, USERS };

export const FRANK = "user-frank";
export const SEC_BODY = "ZZ-PHASE6-REPLY-BODY-ZZ";

/** 16+ char idempotency keys. */
export const key = (n: string) => `req-${n}-0123456789abcdef`;

export const T_OPEN = tid(101); // open, Ann, assigned to Alice
export const T_UNASSIGNED = tid(102); // open, unassigned
export const T_PROGRESS = tid(103); // in_progress, assigned to Bob
export const T_CLOSED = tid(107);
export const T_MERGED = tid(120); // merged into 101

/** The ticket's updatedAt in the world, as the ISO string a client would pass. */
export const UPDATED_101 = "2026-03-15T09:00:00.000Z";

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
} as const;

export type Caller = keyof typeof SESSIONS;

/** The session is chosen per request by the `x-test-user` header. */
export function installSessions() {
  getSession.mockReset();
  getSession.mockImplementation((opts: { headers: Headers }) => {
    const who = opts.headers.get("x-test-user") as Caller | null;
    return Promise.resolve(who ? SESSIONS[who] : null);
  });
}

/** Read world + a webhook endpoint for every ticket event + a second agent. */
export async function seedPhase6World(world: McpWorld) {
  callLog.length = 0;
  enqueueMode.email = "resolve";
  installSessions();
  await seedReadWorld(world.db);
  await world.db.insert(schema.webhookEndpoints).values({
    id: "wh-1",
    name: "Phase 6 hook",
    url: "https://hooks.example.test/docket",
    secretEncrypted: "not-a-real-secret",
    events: ALL_TICKET_EVENTS,
    isActive: true,
    createdById: USERS.bob.id,
    createdByName: USERS.bob.name,
  });
  await addUser(world.db, { id: FRANK, role: "agent" });
}

export async function setReplyGate(world: McpWorld, on: boolean) {
  await world.sql`UPDATE platform_settings SET mcp_customer_replies_enabled = ${on}`;
}

export async function connectWith(
  world: McpWorld,
  userId: string,
  scopes: string[]
) {
  const token = await addToken(world.db, userId, { scopes });
  return { client: await connectMcp(token.raw), tokenId: token.id };
}

export const OPERATOR_SCOPES = [
  "tickets:read",
  "customers:read",
  "tickets:manage",
  "tickets:reply",
];

/* ------------------------------------------------------ result assertions */

const SECRETS = [SEC_BODY, CUSTOMERS.ann.email, "token-101", "token-107"];

/** Everything a Phase 6 tool returns passes through here: no forbidden field,
 * no customer token, portal URL, storage key or echo of a reply body. */
export function scan(text: string) {
  for (const pattern of FORBIDDEN_OUTPUT_PATTERNS) {
    const hit =
      typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
    if (hit) {
      throw new Error(`Forbidden output pattern ${String(pattern)}: ${text}`);
    }
  }
  for (const secret of [...SECRETS, "/ticket/", "tickets/t-101/"]) {
    if (text.includes(secret)) {
      throw new Error(`Output leaks ${secret}: ${text}`);
    }
  }
}

export async function call(
  client: Awaited<ReturnType<typeof connectMcp>>,
  name: string,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const outcome = await callTool(client, name, args);
  scan(outcome.text);
  return outcome;
}

export function expectError(r: ToolOutcome, code: string) {
  expect(r.protocolError, r.text).toBeNull();
  expect(r.isError, r.text).toBe(true);
  expect(r.errorCode).toBe(code);
  expect(r.text).toBe(JSON.stringify(r.data));
  const error = r.data.error as {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  expect(typeof error.message).toBe("string");
  for (const k of Object.keys(error.details ?? {})) {
    expect(MCP_ERROR_DETAIL_KEYS as readonly string[]).toContain(k);
  }
  return error;
}

export function expectOk(r: ToolOutcome) {
  expect(r.protocolError, r.text).toBeNull();
  expect(r.isError, r.text).toBe(false);
  expect(r.text).toBe(JSON.stringify(r.data));
  return r.data as Record<string, unknown>;
}

/* ------------------------------------------------------------ route calls */

export function actionRequest(
  verb: "approve" | "dismiss",
  actionId: string,
  as: Caller
) {
  return new NextRequest(
    `http://localhost:3000/api/mcp/actions/${actionId}/${verb}`,
    { method: "POST", headers: { "x-test-user": as } }
  );
}

const routeCtx = (id: string) => ({ params: Promise.resolve({ id }) });

export async function approve(id: string, as: Caller = "alice") {
  const res = await APPROVE(actionRequest("approve", id, as), routeCtx(id));
  return { status: res.status, body: (await res.json()) as unknown };
}

export async function dismiss(id: string, as: Caller = "alice") {
  const res = await DISMISS(actionRequest("dismiss", id, as), routeCtx(id));
  return { status: res.status, body: (await res.json()) as unknown };
}

/* ------------------------------------------------------------ row readers */

export async function ledger() {
  return await db
    .select()
    .from(schema.mcpToolCalls)
    .orderBy(asc(schema.mcpToolCalls.createdAt), asc(schema.mcpToolCalls.id));
}

export async function pendingRows() {
  return await db
    .select()
    .from(schema.mcpPendingActions)
    .orderBy(
      asc(schema.mcpPendingActions.createdAt),
      asc(schema.mcpPendingActions.id)
    );
}

export async function pendingRow(id: string) {
  const [row] = await db
    .select()
    .from(schema.mcpPendingActions)
    .where(eq(schema.mcpPendingActions.id, id));
  return row;
}

export async function activityOn(ticketId: string) {
  return await db
    .select()
    .from(schema.ticketActivity)
    .where(eq(schema.ticketActivity.ticketId, ticketId))
    .orderBy(
      asc(schema.ticketActivity.createdAt),
      asc(schema.ticketActivity.id)
    );
}

/** Activity rows an MCP call added (the seeded history has no `via`). */
export async function mcpActivity(ticketId: string, action?: string) {
  return (await activityOn(ticketId)).filter(
    (r) =>
      (r.metadata as Record<string, unknown> | null)?.via === "mcp" &&
      (action === undefined || r.action === action)
  );
}

export async function commentsOn(ticketId: string) {
  return await db
    .select()
    .from(schema.ticketComments)
    .where(eq(schema.ticketComments.ticketId, ticketId))
    .orderBy(
      asc(schema.ticketComments.createdAt),
      asc(schema.ticketComments.id)
    );
}

export async function deliveryEvents(): Promise<string[]> {
  const rows = await db
    .select({ event: schema.webhookDeliveries.event })
    .from(schema.webhookDeliveries)
    .orderBy(asc(schema.webhookDeliveries.event));
  return rows.map((r) => r.event);
}

export async function outboxCount() {
  return (
    await db.select({ id: schema.emailOutbox.id }).from(schema.emailOutbox)
  ).length;
}

export async function ticketState(ticketId: string) {
  const [row] = await db
    .select({
      status: schema.tickets.status,
      closedAt: schema.tickets.closedAt,
      assignedAgentId: schema.tickets.assignedAgentId,
      updatedAt: schema.tickets.updatedAt,
    })
    .from(schema.tickets)
    .where(eq(schema.tickets.id, ticketId));
  return row;
}

export async function auditOf(action: string) {
  return await db
    .select()
    .from(schema.auditLogs)
    .where(eq(schema.auditLogs.action, action))
    .orderBy(asc(schema.auditLogs.createdAt), asc(schema.auditLogs.id));
}

export async function notificationRows() {
  return await db.select().from(schema.notifications);
}

export const pushCalls = () =>
  callLog.filter((c) => c.call === "push.publishPushToUsers");
