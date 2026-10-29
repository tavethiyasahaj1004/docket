import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", async () =>
  (await import("./characterization/write-helpers")).authModule()
);
vi.mock("@/lib/worker/enqueue", async () =>
  (await import("./characterization/write-helpers")).enqueueModule()
);
vi.mock("@/lib/realtime", async (importOriginal) =>
  (await import("./characterization/write-helpers")).realtimeModule(
    await importOriginal<Record<string, unknown>>()
  )
);
vi.mock("@/lib/push", async (importOriginal) =>
  (await import("./characterization/write-helpers")).pushModule(
    await importOriginal<Record<string, unknown>>()
  )
);

import { PATCH as REOPEN_ROUTE } from "@/app/api/tickets/[id]/reopen/route";
import { mcpToolCalls, tickets } from "@/db/schema";
import { db } from "@/lib/db";
import { addToken, setupMcpWorld, USERS } from "./mcp-helpers";
import {
  ALICE,
  activityOn,
  auditOf,
  BOB,
  call,
  callLog,
  commentsOn,
  connectWith,
  deliveryEvents,
  expectError,
  expectOk,
  FRANK,
  key,
  ledger,
  mcpActivity,
  notificationRows,
  outboxCount,
  pushCalls,
  seedPhase6World,
  T_CLOSED,
  T_MERGED,
  T_OPEN,
  T_PROGRESS,
  T_UNASSIGNED,
  ticketState,
  UPDATED_101,
} from "./mcp-phase6-helpers";
import { callTool, closeMcpClients, connectMcp } from "./mcp-read-helpers";

const world = setupMcpWorld();

const READ_TOOLS = [
  "whoami",
  "get_ticket_config",
  "list_tickets",
  "get_ticket",
  "get_ticket_thread",
  "get_customer",
  "list_agents",
  "search_canned_responses",
  "get_ticket_stats",
];
const MANAGE_TOOLS = [
  "assign_ticket",
  "set_ticket_status",
  "close_ticket",
  "reopen_ticket",
];
const MANAGE_SCOPES = ["tickets:read", "customers:read", "tickets:manage"];

const quiet: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(async () => {
  for (const method of ["log", "warn", "error", "info"] as const) {
    quiet.push(vi.spyOn(console, method).mockImplementation(() => undefined));
  }
  await seedPhase6World(world);
});

afterEach(async () => {
  await closeMcpClients();
  vi.restoreAllMocks();
  quiet.length = 0;
});

async function manager(userId: string = ALICE) {
  return (await connectWith(world, userId, MANAGE_SCOPES)).client;
}

/** Nothing a call can change was changed. */
async function untouched(ticketId: string) {
  return {
    state: await ticketState(ticketId),
    activity: (await activityOn(ticketId)).length,
    deliveries: await deliveryEvents(),
    outbox: await outboxCount(),
    comments: (await commentsOn(ticketId)).length,
  };
}

/* ------------------------------------------------------- registration */

describe("registration and scopes", () => {
  it("a default read-only token sees none of the Phase 6 tools", async () => {
    const token = await addToken(world.db, ALICE);
    const client = await connectMcp(token.raw);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(READ_TOOLS);
    for (const name of [
      ...MANAGE_TOOLS,
      "reply_to_customer",
      "get_action_status",
    ]) {
      const r = await callTool(client, name, { ticket: 101 });
      expect(r.protocolError, name).toMatch(/unknown tool|not found/i);
    }
    expect(await ledger()).toHaveLength(0);
  });

  it("tickets:manage lists the four manage tools and get_action_status, in registry order", async () => {
    const client = await manager();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      ...READ_TOOLS,
      ...MANAGE_TOOLS,
      "get_action_status",
    ]);
  });

  it("tickets:reply alone lists only get_action_status (the reply tool needs the admin setting too)", async () => {
    const { client } = await connectWith(world, ALICE, [
      "tickets:read",
      "customers:read",
      "tickets:reply",
    ]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      ...READ_TOOLS,
      "get_action_status",
    ]);
  });

  it("works the same for an admin", async () => {
    const { tools } = await (await manager(BOB)).listTools();
    expect(tools.map((t) => t.name)).toEqual([
      ...READ_TOOLS,
      ...MANAGE_TOOLS,
      "get_action_status",
    ]);
  });

  it("marks only close_ticket and assign_ticket with the user-interaction hint, and sets the annotations", async () => {
    const { tools } = await (await manager()).listTools();
    const withHint = tools
      .filter((t) => t._meta?.["anthropic/requiresUserInteraction"] === true)
      .map((t) => t.name);
    expect(withHint.sort()).toEqual(["assign_ticket", "close_ticket"]);

    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of MANAGE_TOOLS) {
      expect(byName.get(name)?.annotations, name).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
    expect(byName.get("get_action_status")?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("keeps every Phase 6 tool description within 1000 characters", async () => {
    const { tools } = await (await manager()).listTools();
    for (const name of [...MANAGE_TOOLS, "get_action_status"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.description?.length ?? 0, name).toBeGreaterThan(0);
      expect(tool?.description?.length ?? 0, name).toBeLessThanOrEqual(1000);
    }
  });

  it("denies a tool the scope does not cover, even when called directly", async () => {
    const { client } = await connectWith(world, ALICE, [
      "tickets:read",
      "tickets:write",
    ]);
    const r = await callTool(client, "assign_ticket", {
      ticket: 101,
      assignee: "me",
    });
    expect(r.protocolError).toMatch(/unknown tool|not found/i);
    expect(await ledger()).toHaveLength(0);
  });
});

/* -------------------------------------------------------- assign_ticket */

describe("assign_ticket", () => {
  it("assigns to another agent with activity, audit and webhook, and notifies nobody", async () => {
    const client = await manager();
    const r = expectOk(
      await call(client, "assign_ticket", {
        ticket: 101,
        assignee: FRANK,
        clientRequestId: key("assign-frank"),
      })
    );
    expect(r).toMatchObject({
      changed: true,
      assignee: { id: FRANK, name: `Name ${FRANK}` },
      previousAssignee: { id: ALICE, name: USERS.alice.name },
      ticket: { number: 101 },
    });
    expect((r.ticket as { agentUrl: string }).agentUrl).toBe(
      "http://localhost:3000/tickets/101"
    );
    expect((await ticketState(T_OPEN)).assignedAgentId).toBe(FRANK);

    const [activity] = await mcpActivity(T_OPEN, "assigned");
    expect(activity).toMatchObject({
      actorId: ALICE,
      actorRole: "agent",
      metadata: expect.objectContaining({ via: "mcp", agentId: FRANK }),
    });
    expect((activity.metadata as Record<string, unknown>).credentialId).toEqual(
      expect.any(String)
    );
    expect(await deliveryEvents()).toEqual(["ticket.assigned"]);
    const audits = await auditOf("mcp.assign_ticket");
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(ALICE);

    // D5: the new assignee hears nothing from this path.
    expect(await notificationRows()).toHaveLength(0);
    expect(pushCalls()).toEqual([]);
    expect(
      callLog.filter((c) => c.call === "realtime.publishNotificationCreated")
    ).toEqual([]);
    expect(await outboxCount()).toBe(0);
  });

  it('assigns to "me" and unassigns', async () => {
    const client = await manager();
    const me = expectOk(
      await call(client, "assign_ticket", { ticket: 102, assignee: "me" })
    );
    expect(me).toMatchObject({
      changed: true,
      assignee: { id: ALICE },
      previousAssignee: null,
    });
    expect((await ticketState(T_UNASSIGNED)).assignedAgentId).toBe(ALICE);

    const off = expectOk(
      await call(client, "assign_ticket", {
        ticket: 102,
        assignee: "unassigned",
      })
    );
    expect(off).toMatchObject({
      changed: true,
      assignee: null,
      previousAssignee: { id: ALICE },
    });
    expect((await ticketState(T_UNASSIGNED)).assignedAgentId).toBeNull();
    expect((await mcpActivity(T_UNASSIGNED)).map((a) => a.action)).toEqual([
      "assigned",
      "unassigned",
    ]);
    expect(await deliveryEvents()).toEqual([
      "ticket.assigned",
      "ticket.unassigned",
    ]);
  });

  it("assigns the same way the UI route does (same activity and webhook)", async () => {
    // The UI PATCH route is covered by the characterization suite; here the
    // MCP row is checked against what that suite pins.
    const client = await manager(BOB);
    expectOk(
      await call(client, "assign_ticket", { ticket: 103, assignee: ALICE })
    );
    const [row] = await mcpActivity(T_PROGRESS, "assigned");
    expect(row.actorId).toBe(BOB);
    expect(row.actorRole).toBe("admin");
    expect(row.metadata).toMatchObject({ agentId: ALICE, via: "mcp" });
  });

  it.each([
    ["a banned agent", USERS.carol.id],
    ["a plain user", USERS.dave.id],
    ["an unknown id", "user-does-not-exist"],
  ])("refuses %s as the assignee and writes nothing", async (_label, assignee) => {
    const client = await manager();
    const before = await untouched(T_OPEN);
    const error = expectError(
      await call(client, "assign_ticket", { ticket: 101, assignee }),
      "invalid_input"
    );
    expect(error.details).toMatchObject({ field: "assignee" });
    expect(await untouched(T_OPEN)).toEqual(before);
    expect(await auditOf("mcp.assign_ticket")).toHaveLength(0);
  });

  it("assigning to the current assignee is a no-op: no activity, webhook or audit", async () => {
    const client = await manager();
    const before = await untouched(T_OPEN);
    const r = expectOk(
      await call(client, "assign_ticket", { ticket: 101, assignee: "me" })
    );
    expect(r).toMatchObject({
      changed: false,
      assignee: { id: ALICE },
      previousAssignee: { id: ALICE },
    });
    expect(await untouched(T_OPEN)).toEqual(before);
    expect(await auditOf("mcp.assign_ticket")).toHaveLength(0);
  });

  it("answers merged for a merged ticket, naming the ticket to use", async () => {
    const client = await manager();
    const error = expectError(
      await call(client, "assign_ticket", { ticket: 120, assignee: "me" }),
      "merged"
    );
    expect(error.details).toMatchObject({
      mergedIntoTicketNumber: 101,
      ticketNumber: 120,
    });
    expect((await ticketState(T_MERGED)).assignedAgentId).toBe(ALICE);
  });

  it("answers not_found for an unknown ticket", async () => {
    const client = await manager();
    expectError(
      await call(client, "assign_ticket", { ticket: 99_999, assignee: "me" }),
      "not_found"
    );
  });

  it("conflicts on a stale expectedUpdatedAt and writes nothing; the right one applies", async () => {
    const client = await manager();
    const before = await untouched(T_OPEN);
    const error = expectError(
      await call(client, "assign_ticket", {
        ticket: 101,
        assignee: FRANK,
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      }),
      "conflict"
    );
    expect(error.details).toMatchObject({
      currentUpdatedAt: UPDATED_101,
      ticketNumber: 101,
    });
    expect(await untouched(T_OPEN)).toEqual(before);

    expectOk(
      await call(client, "assign_ticket", {
        ticket: 101,
        assignee: FRANK,
        expectedUpdatedAt: UPDATED_101,
      })
    );
    expect((await ticketState(T_OPEN)).assignedAgentId).toBe(FRANK);
  });

  it("replays a repeated key without a second activity, webhook or audit", async () => {
    const client = await manager();
    const args = { ticket: 101, assignee: FRANK, clientRequestId: key("a-1") };
    const first = expectOk(await call(client, "assign_ticket", args));
    const again = expectOk(await call(client, "assign_ticket", args));
    expect(first.replayed).toBeUndefined();
    expect(again.replayed).toBe(true);
    expect(again.changed).toBe(true);
    expect(await mcpActivity(T_OPEN, "assigned")).toHaveLength(1);
    expect(await deliveryEvents()).toEqual(["ticket.assigned"]);
    expect(await auditOf("mcp.assign_ticket")).toHaveLength(1);
  });

  it("rejects the same key with different arguments", async () => {
    const client = await manager();
    const k = key("a-2");
    expectOk(
      await call(client, "assign_ticket", {
        ticket: 101,
        assignee: FRANK,
        clientRequestId: k,
      })
    );
    expectError(
      await call(client, "assign_ticket", {
        ticket: 101,
        assignee: "unassigned",
        clientRequestId: k,
      }),
      "idempotency_key_reused"
    );
  });

  it("takes no ticket lock", async () => {
    const client = await manager();
    expectOk(
      await call(client, "assign_ticket", {
        ticket: 101,
        assignee: FRANK,
        clientRequestId: key("a-3"),
      })
    );
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: "assign_ticket",
      status: "succeeded",
      lockGroup: null,
      targetTicketId: T_OPEN,
    });
  });
});

/* ----------------------------------------------------- set_ticket_status */

describe("set_ticket_status", () => {
  it("moves an open ticket to another open status with activity, audit and webhook, and no email", async () => {
    const client = await manager();
    const r = expectOk(
      await call(client, "set_ticket_status", {
        ticket: 101,
        status: "in_progress",
      })
    );
    expect(r).toMatchObject({
      changed: true,
      status: "in_progress",
      previousStatus: "open",
      ticket: { number: 101 },
    });
    expect((await ticketState(T_OPEN)).status).toBe("in_progress");
    const [activity] = await mcpActivity(T_OPEN, "status_changed");
    expect(activity.metadata).toMatchObject({
      via: "mcp",
      from: "open",
      to: "in_progress",
    });
    expect(activity.actorId).toBe(ALICE);
    expect(await deliveryEvents()).toEqual(["ticket.status_changed"]);
    expect(await auditOf("mcp.set_ticket_status")).toHaveLength(1);
    expect(await outboxCount()).toBe(0);
    expect(await notificationRows()).toHaveLength(0);
  });

  it("takes the per-ticket state lock", async () => {
    const client = await manager();
    expectOk(
      await call(client, "set_ticket_status", {
        ticket: 101,
        status: "in_progress",
        clientRequestId: key("s-lock"),
      })
    );
    expect((await ledger())[0]).toMatchObject({
      tool: "set_ticket_status",
      lockGroup: "ticket_state",
      targetTicketId: T_OPEN,
      status: "succeeded",
    });
  });

  it("refuses a closed target: closing goes through close_ticket", async () => {
    const client = await manager();
    const before = await untouched(T_OPEN);
    const error = expectError(
      await call(client, "set_ticket_status", {
        ticket: 101,
        status: "closed",
      }),
      "conflict"
    );
    expect(error.message).toContain("close_ticket");
    expect(await untouched(T_OPEN)).toEqual(before);
  });

  it("refuses to move a closed ticket: reopening goes through reopen_ticket", async () => {
    const client = await manager();
    const before = await untouched(T_CLOSED);
    const error = expectError(
      await call(client, "set_ticket_status", { ticket: 107, status: "open" }),
      "conflict"
    );
    expect(error.message).toContain("reopen_ticket");
    expect(await untouched(T_CLOSED)).toEqual(before);
  });

  it("refuses an unknown slug and lists the allowed ones", async () => {
    const client = await manager();
    const before = await untouched(T_OPEN);
    const error = expectError(
      await call(client, "set_ticket_status", { ticket: 101, status: "nope" }),
      "invalid_input"
    );
    expect(error.details).toMatchObject({
      field: "status",
      allowed: ["open", "in_progress", "closed"],
    });
    expect(await untouched(T_OPEN)).toEqual(before);
  });

  it("is a no-op for the status the ticket already has", async () => {
    const client = await manager();
    const before = await untouched(T_OPEN);
    const r = expectOk(
      await call(client, "set_ticket_status", { ticket: 101, status: "open" })
    );
    expect(r).toMatchObject({
      changed: false,
      status: "open",
      previousStatus: "open",
    });
    expect(await untouched(T_OPEN)).toEqual(before);
    expect(await auditOf("mcp.set_ticket_status")).toHaveLength(0);
  });

  it("conflicts on a stale expectedUpdatedAt", async () => {
    const client = await manager();
    const before = await untouched(T_OPEN);
    const error = expectError(
      await call(client, "set_ticket_status", {
        ticket: 101,
        status: "in_progress",
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      }),
      "conflict"
    );
    expect(error.details).toMatchObject({ currentUpdatedAt: UPDATED_101 });
    expect(await untouched(T_OPEN)).toEqual(before);
  });

  it("answers merged for a merged ticket", async () => {
    const client = await manager();
    const error = expectError(
      await call(client, "set_ticket_status", {
        ticket: 120,
        status: "in_progress",
      }),
      "merged"
    );
    expect(error.details).toMatchObject({ mergedIntoTicketNumber: 101 });
  });

  it("answers in_progress while another state call on the same ticket is pending", async () => {
    await db.insert(mcpToolCalls).values({
      id: "holder-1",
      requestId: "req-holder",
      userId: FRANK,
      authMethod: "pat",
      credentialId: "cred-frank",
      tool: "reopen_ticket",
      status: "pending",
      plannedEntityId: "planned-holder",
      lockGroup: "ticket_state",
      targetTicketId: T_OPEN,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const client = await manager();
    const before = await untouched(T_OPEN);
    const error = expectError(
      await call(client, "set_ticket_status", {
        ticket: 101,
        status: "in_progress",
        clientRequestId: key("s-busy"),
      }),
      "in_progress"
    );
    expect(error.details).toMatchObject({
      retryAfterSeconds: expect.any(Number),
    });
    expect(await untouched(T_OPEN)).toEqual(before);
  });

  it("replays a repeated key", async () => {
    const client = await manager();
    const args = {
      ticket: 101,
      status: "in_progress",
      clientRequestId: key("s-1"),
    };
    expectOk(await call(client, "set_ticket_status", args));
    const again = expectOk(await call(client, "set_ticket_status", args));
    expect(again.replayed).toBe(true);
    expect(await mcpActivity(T_OPEN, "status_changed")).toHaveLength(1);
    expect(await deliveryEvents()).toEqual(["ticket.status_changed"]);
  });
});

/* -------------------------------------------------------- reopen_ticket */

describe("reopen_ticket", () => {
  it("reopens a closed ticket exactly as the UI route does, and sends no email", async () => {
    const client = await manager();
    const r = expectOk(
      await call(client, "reopen_ticket", {
        ticket: 107,
        clientRequestId: key("r-1"),
      })
    );
    expect(r).toMatchObject({
      alreadyOpen: false,
      status: "open",
      ticket: { number: 107 },
    });
    const viaMcp = await db
      .select({
        status: tickets.status,
        closedAt: tickets.closedAt,
        awaitingReply: tickets.awaitingReply,
        pendingReplies: tickets.pendingReplies,
      })
      .from(tickets)
      .where(eq(tickets.id, T_CLOSED));
    const [activity] = await mcpActivity(T_CLOSED, "ticket_reopened");
    expect(activity.metadata).toMatchObject({
      via: "mcp",
      from: "closed",
      to: "open",
    });
    expect(activity.actorId).toBe(ALICE);
    expect(await deliveryEvents()).toEqual(["ticket.reopened"]);
    expect(await outboxCount()).toBe(0);
    expect(await auditOf("mcp.reopen_ticket")).toHaveLength(1);

    // The UI reopen route on the other closed ticket leaves the same state.
    const ui = await REOPEN_ROUTE(
      new NextRequest("http://localhost:3000/api/tickets/t-108/reopen", {
        method: "PATCH",
        headers: { "x-test-user": "alice", "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ id: "t-108" }) }
    );
    expect(ui.status).toBe(200);
    const viaUi = await db
      .select({
        status: tickets.status,
        closedAt: tickets.closedAt,
        awaitingReply: tickets.awaitingReply,
        pendingReplies: tickets.pendingReplies,
      })
      .from(tickets)
      .where(eq(tickets.id, "t-108"));
    expect(viaMcp).toEqual(viaUi);
    const uiActivity = (await activityOn("t-108")).filter(
      (a) => a.action === "ticket_reopened"
    );
    expect(uiActivity).toHaveLength(1);
    expect(uiActivity[0].metadata).toEqual({ from: "closed", to: "open" });
  });

  it("takes the per-ticket state lock", async () => {
    const client = await manager();
    expectOk(
      await call(client, "reopen_ticket", {
        ticket: 107,
        clientRequestId: key("r-lock"),
      })
    );
    expect((await ledger())[0]).toMatchObject({
      tool: "reopen_ticket",
      lockGroup: "ticket_state",
    });
  });

  it("is a no-op on a ticket that is not closed", async () => {
    const client = await manager();
    const before = await untouched(T_OPEN);
    const r = expectOk(await call(client, "reopen_ticket", { ticket: 101 }));
    expect(r).toMatchObject({ alreadyOpen: true, status: "open" });
    expect(await untouched(T_OPEN)).toEqual(before);
    expect(await auditOf("mcp.reopen_ticket")).toHaveLength(0);
  });

  it("answers merged for a merged ticket", async () => {
    const client = await manager();
    const error = expectError(
      await call(client, "reopen_ticket", { ticket: 120 }),
      "merged"
    );
    expect(error.details).toMatchObject({ mergedIntoTicketNumber: 101 });
    expect((await ticketState(T_MERGED)).status).toBe("closed");
  });

  it("conflicts on a stale expectedUpdatedAt and reopens nothing", async () => {
    const client = await manager();
    const before = await untouched(T_CLOSED);
    expectError(
      await call(client, "reopen_ticket", {
        ticket: 107,
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      }),
      "conflict"
    );
    expect(await untouched(T_CLOSED)).toEqual(before);
  });

  it("replays a repeated key without a second reopen", async () => {
    const client = await manager();
    const args = { ticket: 107, clientRequestId: key("r-2") };
    expectOk(await call(client, "reopen_ticket", args));
    const again = expectOk(await call(client, "reopen_ticket", args));
    expect(again.replayed).toBe(true);
    expect(await mcpActivity(T_CLOSED, "ticket_reopened")).toHaveLength(1);
    expect(await deliveryEvents()).toEqual(["ticket.reopened"]);
  });
});
