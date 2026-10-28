import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emailOutbox,
  ticketComments,
  ticketReplyDrafts,
  ticketStatuses,
  tickets,
} from "@/db/schema";
import { db } from "@/lib/db";

// Lets one test make the close service throw, to prove an approval never
// re-runs after a crash.
const closeFault = vi.hoisted(() => ({ throws: false }));

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
vi.mock("@/lib/tickets/services/close", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/tickets/services/close")>();
  return {
    ...original,
    closeTicket: (...args: Parameters<typeof original.closeTicket>) =>
      closeFault.throws
        ? Promise.reject(new Error("simulated service failure"))
        : original.closeTicket(...args),
  };
});

import { POST as APPROVE } from "@/app/api/mcp/actions/[id]/approve/route";
import { POST as DISMISS } from "@/app/api/mcp/actions/[id]/dismiss/route";
import { createPendingAction } from "@/lib/mcp/pending-actions";
import { sweepStuckApprovedActions } from "@/lib/mcp/pending-actions-reconcile";
import { enqueueMode } from "./characterization/write-helpers";
import { doc } from "./fixtures";
import {
  ALICE,
  actionRequest,
  activityOf,
  auditOf,
  BOB,
  type Caller,
  callLog,
  deliveriesOf,
  getAction,
  getSession,
  HOUR,
  insertAction,
  installSessionMock,
  REPLY,
  routeCtx,
  SECRET,
  seedPendingWorld,
  snapshot,
  T_MERGED,
  T_OPEN,
  TOK_ALICE,
} from "./mcp-pending-helpers";

beforeEach(async () => {
  vi.useRealTimers();
  callLog.length = 0;
  enqueueMode.email = "resolve";
  closeFault.throws = false;
  installSessionMock();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await seedPendingWorld();
  return () => {
    vi.restoreAllMocks();
  };
});

async function create(kind: "close" | "reply", ticketId = T_OPEN) {
  const res = await createPendingAction({
    userId: ALICE,
    credentialId: TOK_ALICE,
    ticketId,
    kind,
    payload: kind === "reply" ? { content: REPLY } : undefined,
  });
  if (res.status !== "created") {
    throw new Error(`could not create: ${res.status}`);
  }
  return res.action;
}

async function respond(res: Response) {
  return { status: res.status, body: (await res.json()) as unknown };
}
type Who = Caller | "anonymous";
const caller = (who: Who) => (who === "anonymous" ? undefined : who);
const approve = async (id: string, as: Who = "alice") =>
  respond(
    await APPROVE(actionRequest("approve", id, caller(as)), routeCtx(id))
  );
const dismiss = async (id: string, as: Who = "alice") =>
  respond(
    await DISMISS(actionRequest("dismiss", id, caller(as)), routeCtx(id))
  );

const NOT_FOUND = { status: 404, body: { error: "Request not found." } };
const NOT_PENDING = {
  status: 409,
  body: { error: "This request is no longer pending." },
};

const outbox = async () => await db.select().from(emailOutbox);

describe("the owner decides", () => {
  it("approves a close: the same effects as the UI close, attributed to the owner", async () => {
    const action = await create("close");
    const before = await snapshot();

    expect(await approve(action.id)).toEqual({
      status: 200,
      body: { status: "approved", outcome: "closed" },
    });

    const after = await snapshot();
    expect(after.status).toBe("closed");
    expect(after.comments).toBe(before.comments);
    expect(after.activity).toBe(before.activity + 1);
    expect(after.emails).toBe(before.emails + 1);
    expect(await deliveriesOf("ticket.closed")).toHaveLength(1);

    const row = await getAction(action.id);
    expect(row).toMatchObject({
      status: "approved",
      sideEffectsUncertain: false,
      result: { activityId: row.plannedEntityId },
    });
    expect(row.plannedEntityId).toBeTruthy();
    expect(row.decidedAt).toBeInstanceOf(Date);

    // the activity row is the planned one, marked as coming through MCP
    const closed = await activityOf(T_OPEN, "ticket_closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      id: row.plannedEntityId,
      actorId: ALICE,
      actorName: "Alice Agent",
      actorRole: "agent",
      metadata: {
        via: "mcp",
        approvedRequestId: action.id,
        credentialId: TOK_ALICE,
        from: "open",
        to: "closed",
      },
    });

    const mail = await outbox();
    expect(mail).toHaveLength(1);
    expect((mail[0].payload as { to: string }).to).toBe("ann@example.test");

    const audits = await auditOf("mcp.action_approved");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: ALICE,
      actorEmail: "alice@example.test",
      entityType: "mcp_pending_action",
      entityId: action.id,
      metadata: {
        via: "mcp",
        credentialId: TOK_ALICE,
        kind: "close",
        ticketId: T_OPEN,
        ticketNumber: 101,
        plannedEntityId: row.plannedEntityId,
      },
    });
  });

  it("approves a reply: a public comment by the owner, one email, one webhook, draft kept", async () => {
    await db.insert(ticketReplyDrafts).values({
      ticketId: T_OPEN,
      userId: ALICE,
      content: doc("my own draft"),
      isInternal: false,
    });
    const action = await create("reply");
    const before = await snapshot();

    expect(await approve(action.id)).toEqual({
      status: 200,
      body: { status: "approved", outcome: "replied" },
    });

    const after = await snapshot();
    expect(after.status).toBe("open");
    expect(after.comments).toBe(before.comments + 1);
    expect(after.emails).toBe(before.emails + 1);
    expect(await deliveriesOf("ticket.replied")).toHaveLength(1);

    const row = await getAction(action.id);
    expect(row).toMatchObject({
      status: "approved",
      result: { commentId: row.plannedEntityId },
    });
    const [comment] = await db
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.id, row.plannedEntityId as string));
    expect(comment).toMatchObject({
      ticketId: T_OPEN,
      authorId: ALICE,
      authorName: "Alice Agent",
      authorRole: "agent",
      isInternal: false,
      content: REPLY,
    });

    const [activity] = await activityOf(T_OPEN, "comment_added");
    expect(activity.metadata).toMatchObject({
      via: "mcp",
      approvedRequestId: action.id,
      credentialId: TOK_ALICE,
    });
    expect(activity.actorId).toBe(ALICE);

    const [ticket] = await db
      .select({
        awaitingReply: tickets.awaitingReply,
        firstRespondedAt: tickets.firstRespondedAt,
      })
      .from(tickets)
      .where(eq(tickets.id, T_OPEN));
    expect(ticket.awaitingReply).toBe(false);
    expect(ticket.firstRespondedAt).not.toBeNull();

    // the owner's composer draft survived
    const [draft] = await db
      .select()
      .from(ticketReplyDrafts)
      .where(
        and(
          eq(ticketReplyDrafts.ticketId, T_OPEN),
          eq(ticketReplyDrafts.userId, ALICE)
        )
      );
    expect(draft.content).toContain("my own draft");

    // approval audit carries no reply content
    expect(JSON.stringify(await auditOf("mcp.action_approved"))).not.toContain(
      SECRET
    );
  });

  it("dismisses a request and changes nothing else", async () => {
    const action = await create("reply");
    const before = await snapshot();

    expect(await dismiss(action.id)).toEqual({
      status: 200,
      body: { status: "dismissed" },
    });

    expect(await snapshot()).toEqual(before);
    const row = await getAction(action.id);
    expect(row.status).toBe("dismissed");
    expect(row.decidedAt).toBeInstanceOf(Date);
    expect(row.plannedEntityId).toBeNull();
    expect(row.result).toBeNull();

    const audits = await auditOf("mcp.action_dismissed");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: ALICE,
      actorEmail: "alice@example.test",
      entityId: action.id,
      metadata: { via: "mcp", credentialId: TOK_ALICE, kind: "reply" },
    });
    expect(JSON.stringify(audits)).not.toContain(SECRET);

    // and it cannot be approved afterwards
    expect(await approve(action.id)).toEqual(NOT_PENDING);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses to dismiss an approved request", async () => {
    const action = await create("close");
    expect((await approve(action.id)).status).toBe(200);
    expect(await dismiss(action.id)).toEqual(NOT_PENDING);
    expect((await getAction(action.id)).status).toBe("approved");
  });
});

describe("only the token owner may decide", () => {
  it.each([
    ["another agent", "frank"],
    ["an admin", "bob"],
    ["a plain user", "dave"],
    ["an anonymous caller", "anonymous"],
  ] as const)("%s gets the same 404 as an unknown id, and nothing changes", async (_who, caller) => {
    const close = await create("close");
    const reply = await create("reply");
    const before = await snapshot();

    for (const action of [close, reply]) {
      const unknownApprove = await approve("no-such-request", caller);
      const unknownDismiss = await dismiss("no-such-request", caller);
      expect(unknownApprove).toEqual(NOT_FOUND);
      expect(unknownDismiss).toEqual(NOT_FOUND);
      expect(await approve(action.id, caller)).toEqual(unknownApprove);
      expect(await dismiss(action.id, caller)).toEqual(unknownDismiss);
    }

    expect(await snapshot()).toEqual(before);
    expect((await getAction(close.id)).status).toBe("pending");
    expect((await getAction(reply.id)).status).toBe("pending");
    expect(await auditOf("mcp.action_approved")).toHaveLength(0);
    expect(await auditOf("mcp.action_dismissed")).toHaveLength(0);
  });

  it("answers 404 to an admin impersonating the owner", async () => {
    const action = await create("close");
    getSession.mockImplementation(() =>
      Promise.resolve({
        user: { id: ALICE, role: "agent", name: "Alice Agent", email: "a@x" },
        session: { impersonatedBy: BOB },
      })
    );
    const before = await snapshot();
    expect(await approve(action.id)).toEqual(NOT_FOUND);
    expect(await dismiss(action.id)).toEqual(NOT_FOUND);
    expect(await snapshot()).toEqual(before);
    expect((await getAction(action.id)).status).toBe("pending");
  });

  it("answers 404 when the owner's token was revoked, even for the owner", async () => {
    const action = await create("close");
    await db.execute(
      sql`UPDATE mcp_access_tokens SET revoked_at = now(), revoked_reason = 'revoked_by_user' WHERE id = ${TOK_ALICE}`
    );
    const before = await snapshot();
    expect(await approve(action.id)).toEqual(NOT_FOUND);
    expect(await dismiss(action.id)).toEqual(NOT_FOUND);
    expect(await snapshot()).toEqual(before);
    // the trigger cancelled it
    expect(await getAction(action.id)).toMatchObject({
      status: "cancelled",
      statusReason: "token_revoked",
    });
  });

  it("answers 404 when the owner has since been banned", async () => {
    const action = await create("close");
    await db.execute(sql`UPDATE "user" SET banned = true WHERE id = ${ALICE}`);
    const before = await snapshot();
    expect(await approve(action.id)).toEqual(NOT_FOUND);
    expect(await snapshot()).toEqual(before);
    expect((await getAction(action.id)).status).toBe("cancelled");
  });
});

describe("one approval wins", () => {
  it("lets exactly one of several concurrent close approvals through", async () => {
    const action = await create("close");
    const results = await Promise.all(
      Array.from({ length: 4 }, () => approve(action.id))
    );

    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) {
      expect(r).toEqual(NOT_PENDING);
    }
    expect(await activityOf(T_OPEN, "ticket_closed")).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);
    expect(await deliveriesOf("ticket.closed")).toHaveLength(1);
    expect(
      callLog.filter((c) => c.job === "email.send" && c.call === "enqueueJob")
    ).toHaveLength(1);
  });

  it("lets exactly one of several concurrent reply approvals through", async () => {
    const action = await create("reply");
    const results = await Promise.all(
      Array.from({ length: 4 }, () => approve(action.id))
    );

    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    const comments = await db
      .select()
      .from(ticketComments)
      .where(
        and(
          eq(ticketComments.ticketId, T_OPEN),
          eq(ticketComments.isInternal, false),
          eq(ticketComments.authorId, ALICE)
        )
      );
    expect(comments).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);
    expect(await deliveriesOf("ticket.replied")).toHaveLength(1);
  });

  it("lets only one of a concurrent approve and dismiss win", async () => {
    const action = await create("close");
    const [a, d] = await Promise.all([approve(action.id), dismiss(action.id)]);
    expect([a.status, d.status].sort()).toEqual([200, 409]);

    const row = await getAction(action.id);
    if (a.status === 200) {
      expect(row.status).toBe("approved");
      expect((await snapshot()).status).toBe("closed");
    } else {
      expect(row.status).toBe("dismissed");
      expect((await snapshot()).status).toBe("open");
      expect(await outbox()).toHaveLength(0);
    }
  });

  it("answers a repeated sequential approval with 409 and sends nothing more", async () => {
    const action = await create("close");
    expect((await approve(action.id)).status).toBe(200);
    expect(await approve(action.id)).toEqual(NOT_PENDING);
    expect(await outbox()).toHaveLength(1);
    expect(await deliveriesOf("ticket.closed")).toHaveLength(1);
  });
});

describe("a request that is no longer actionable is refused, with nothing sent", () => {
  async function expectUntouched(before: Awaited<ReturnType<typeof snapshot>>) {
    expect(await snapshot()).toEqual(before);
    expect(await outbox()).toHaveLength(0);
    expect(await deliveriesOf("ticket.closed")).toHaveLength(0);
    expect(await deliveriesOf("ticket.replied")).toHaveLength(0);
  }

  it.each(["close", "reply"] as const)("after expiry (%s)", async (kind) => {
    const action = await create(kind);
    await db.execute(
      sql`UPDATE mcp_pending_actions SET expires_at = now() - interval '1 minute' WHERE id = ${action.id}`
    );
    const before = await snapshot();
    expect(await approve(action.id)).toEqual(NOT_PENDING);
    expect(await dismiss(action.id)).toEqual(NOT_PENDING);
    await expectUntouched(before);
  });

  it.each(["close", "reply"] as const)("after dismissal (%s)", async (kind) => {
    const action = await create(kind);
    expect((await dismiss(action.id)).status).toBe(200);
    const before = await snapshot();
    expect(await approve(action.id)).toEqual(NOT_PENDING);
    await expectUntouched(before);
  });

  it.each([
    "close",
    "reply",
  ] as const)("after cancellation by a merge (%s)", async (kind) => {
    const action = await create(kind);
    await db.execute(
      sql`UPDATE mcp_pending_actions SET status = 'cancelled', status_reason = 'ticket_merged' WHERE id = ${action.id}`
    );
    const before = await snapshot();
    expect(await approve(action.id)).toEqual(NOT_PENDING);
    await expectUntouched(before);
  });

  it.each([
    "close",
    "reply",
  ] as const)("after the token was revoked (%s)", async (kind) => {
    const action = await create(kind);
    await db.execute(
      sql`UPDATE mcp_access_tokens SET revoked_at = now() WHERE id = ${TOK_ALICE}`
    );
    const before = await snapshot();
    expect(await approve(action.id)).toEqual(NOT_FOUND);
    await expectUntouched(before);
  });

  it("even when the revoke trigger did not run (the CAS checks the token itself)", async () => {
    const action = await create("close");
    await db.execute(
      sql`ALTER TABLE mcp_access_tokens DISABLE TRIGGER mcp_pending_actions_cancel_on_token_revoke`
    );
    try {
      await db.execute(
        sql`UPDATE mcp_access_tokens SET revoked_at = now() WHERE id = ${TOK_ALICE}`
      );
    } finally {
      await db.execute(
        sql`ALTER TABLE mcp_access_tokens ENABLE TRIGGER mcp_pending_actions_cancel_on_token_revoke`
      );
    }
    expect((await getAction(action.id)).status).toBe("pending");
    const before = await snapshot();
    expect(await approve(action.id)).toEqual(NOT_FOUND);
    expect(await dismiss(action.id)).toEqual(NOT_FOUND);
    await expectUntouched(before);
  });

  it("still lets the owner decide after the token itself has expired", async () => {
    const action = await create("close");
    await db.execute(
      sql`UPDATE mcp_access_tokens SET expires_at = now() - interval '1 day' WHERE id = ${TOK_ALICE}`
    );
    expect((await approve(action.id)).status).toBe(200);
  });
});

describe("approving when the ticket changed since the request", () => {
  it("a close on an already-closed ticket is a no-op: alreadyClosed, no email, no webhook", async () => {
    const action = await create("close");
    await db
      .update(tickets)
      .set({ status: "closed", closedAt: new Date() })
      .where(eq(tickets.id, T_OPEN));
    const before = await snapshot();

    expect(await approve(action.id)).toEqual({
      status: 200,
      body: { status: "approved", outcome: "already_closed" },
    });

    expect(await snapshot()).toEqual(before);
    expect(await outbox()).toHaveLength(0);
    expect(await deliveriesOf("ticket.closed")).toHaveLength(0);
    expect(await activityOf(T_OPEN, "ticket_closed")).toHaveLength(0);
    expect(await getAction(action.id)).toMatchObject({
      status: "approved",
      result: { alreadyClosed: true },
    });
  });

  it("a reply on a ticket closed since is refused, like the UI does", async () => {
    const action = await create("reply");
    await db
      .update(tickets)
      .set({ status: "closed", closedAt: new Date() })
      .where(eq(tickets.id, T_OPEN));
    const before = await snapshot();

    expect(await approve(action.id)).toEqual({
      status: 409,
      body: { error: "The ticket is closed, so the reply wasn't sent." },
    });

    expect(await snapshot()).toEqual(before);
    expect(await outbox()).toHaveLength(0);
    expect(await getAction(action.id)).toMatchObject({
      status: "failed",
      statusReason: "ticket_closed",
    });
  });

  it("a close on a merged ticket fails without closing anything", async () => {
    const action = await insertAction({ ticketId: T_MERGED });
    const before = await snapshot(T_MERGED);

    const res = await approve(action.id);
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/merged/);
    expect(await snapshot(T_MERGED)).toEqual(before);
    expect(await getAction(action.id)).toMatchObject({
      status: "failed",
      statusReason: "ticket_merged",
    });
  });

  it("a close with no closed status configured fails cleanly", async () => {
    const action = await create("close");
    await db
      .delete(ticketStatuses)
      .where(eq(ticketStatuses.isClosedState, true));
    const before = await snapshot();

    const res = await approve(action.id);
    expect(res.status).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect(await getAction(action.id)).toMatchObject({
      status: "failed",
      statusReason: "no_closed_status",
    });
  });
});

describe("notification outcomes and crashes", () => {
  it("records a failed email enqueue in the result, not as an error", async () => {
    enqueueMode.email = "reject";
    const action = await create("close");

    expect((await approve(action.id)).status).toBe(200);
    const row = await getAction(action.id);
    const errors = (row.result as { notificationErrors?: string[] })
      .notificationErrors;
    expect(errors).toHaveLength(1);
    expect(["email_not_queued", "email_queued_without_job"]).toContain(
      errors?.[0]
    );
    expect(row.status).toBe("approved");
  });

  it("answers 500 when the service throws, leaves the row for the sweeper, and never re-runs", async () => {
    const action = await create("close");
    closeFault.throws = true;

    expect(await approve(action.id)).toEqual({
      status: 500,
      body: { error: "Something went wrong." },
    });
    const stuck = await getAction(action.id);
    expect(stuck).toMatchObject({ status: "approved", result: null });
    expect(stuck.plannedEntityId).toBeTruthy();

    // a retry cannot run it again
    closeFault.throws = false;
    expect(await approve(action.id)).toEqual(NOT_PENDING);
    expect((await snapshot()).status).toBe("open");

    // the sweeper finds nothing landed and fails it, without closing the ticket
    await sweepStuckApprovedActions(new Date(Date.now() + HOUR));
    expect(await getAction(action.id)).toMatchObject({
      status: "failed",
      statusReason: "interrupted",
    });
    expect((await snapshot()).status).toBe("open");
    expect(await outbox()).toHaveLength(0);
  });

  it("never exposes internal errors", async () => {
    const action = await create("close");
    closeFault.throws = true;
    const res = await approve(action.id);
    expect(JSON.stringify(res)).not.toMatch(/simulated|stack|Error/);
  });
});
