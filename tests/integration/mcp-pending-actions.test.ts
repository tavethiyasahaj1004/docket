import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emailOutbox,
  mcpPendingActions,
  ticketComments,
  ticketReplyDrafts,
  user,
} from "@/db/schema";
import { db } from "@/lib/db";

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
const pushFault = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/push", async (importOriginal) => {
  const base = (await import("./characterization/write-helpers")).pushModule(
    await importOriginal<Record<string, unknown>>()
  );
  return {
    ...base,
    publishPushToUsers: (userIds: string[], data: unknown) =>
      pushFault.fail
        ? Promise.reject(new Error("push provider down"))
        : base.publishPushToUsers(userIds, data),
  };
});
vi.mock("@/lib/api-auth", () => ({
  requireApiKey: () => Promise.resolve({ id: "key-pending", name: "Key" }),
}));

import { GET as V1_COMMENTS } from "@/app/api/v1/tickets/[id]/comments/route";
import { GET as V1_TICKET } from "@/app/api/v1/tickets/[id]/route";
import { MCP_PENDING_ACTION_TTL_MS } from "@/lib/mcp/limits";
import {
  createPendingAction,
  listActionablePendingActionsForViewer,
  listPendingActionsForAdmin,
} from "@/lib/mcp/pending-actions";
import { enqueueMode } from "./characterization/write-helpers";
import { doc, tid } from "./fixtures";
import {
  ALICE,
  auditOf,
  BOB,
  CAROL,
  callLog,
  DAVE,
  FRANK,
  getAction,
  HOUR,
  insertAction,
  installSessionMock,
  notificationsOf,
  pushCalls,
  REPLY,
  SECRET,
  seedPendingWorld,
  snapshot,
  T_CLOSED,
  T_MERGED,
  T_OPEN,
  TOK_ALICE,
  TOK_BOB,
  TOK_CAROL,
  TOK_DAVE,
  TOK_FRANK,
} from "./mcp-pending-helpers";

beforeEach(async () => {
  // Real clock: expiry is exercised by writing timestamps, not by freezing time.
  vi.useRealTimers();
  callLog.length = 0;
  enqueueMode.email = "resolve";
  pushFault.fail = false;
  installSessionMock();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await seedPendingWorld();
  return () => {
    vi.restoreAllMocks();
  };
});

const closeReq = (
  over: Partial<Parameters<typeof createPendingAction>[0]> = {}
) =>
  createPendingAction({
    userId: ALICE,
    credentialId: TOK_ALICE,
    ticketId: T_OPEN,
    kind: "close",
    ...over,
  });
const replyReq = (
  over: Partial<Parameters<typeof createPendingAction>[0]> = {}
) =>
  createPendingAction({
    userId: ALICE,
    credentialId: TOK_ALICE,
    ticketId: T_OPEN,
    kind: "reply",
    payload: { content: REPLY },
    ...over,
  });

describe("createPendingAction", () => {
  it("records a close request and changes nothing the customer can see", async () => {
    const before = await snapshot();
    const before2 = Date.now();
    const res = await closeReq({ toolCallId: "call-1" });
    expect(res.status).toBe("created");
    if (res.status !== "created") {
      return;
    }

    expect(res.action).toMatchObject({
      kind: "close",
      ticketId: T_OPEN,
      requestedById: ALICE,
      credentialId: TOK_ALICE,
      toolCallId: "call-1",
      payload: {},
      status: "pending",
      statusReason: null,
      plannedEntityId: null,
      result: null,
      sideEffectsUncertain: false,
      decidedAt: null,
    });
    const ttl = res.action.expiresAt.getTime() - before2;
    expect(ttl).toBeGreaterThan(MCP_PENDING_ACTION_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(MCP_PENDING_ACTION_TTL_MS + 60_000);

    // Not closed, no comment, no activity, no email, no webhook.
    expect(await snapshot()).toEqual(before);
    expect(callLog.filter((c) => c.job === "email.send")).toHaveLength(0);
  });

  it("notifies the owner once, pushes to the owner only, and audits the request", async () => {
    const res = await closeReq({ toolCallId: "call-1" });
    if (res.status !== "created") {
      throw new Error("expected created");
    }

    const notifs = await notificationsOf("mcp_action_pending");
    expect(notifs).toHaveLength(1);
    expect(notifs[0]).toMatchObject({
      userId: ALICE,
      ticketId: T_OPEN,
      ticketNumber: 101,
      title: "Your AI assistant asks to close #101",
      body: "Cannot log in",
      isRead: false,
    });

    const pushes = pushCalls();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      userIds: [ALICE],
      data: {
        title: "Your AI assistant asks to close #101",
        body: "Cannot log in",
        deepLink: "http://localhost:3000/tickets/101",
        tag: `mcp-action-${res.action.id}`,
      },
    });

    const audits = await auditOf("mcp.action_requested");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: ALICE,
      actorEmail: "alice@example.test",
      entityType: "mcp_pending_action",
      entityId: res.action.id,
      metadata: {
        via: "mcp",
        credentialId: TOK_ALICE,
        kind: "close",
        ticketId: T_OPEN,
        ticketNumber: 101,
        toolCallId: "call-1",
      },
    });
  });

  it("stores a reply's content, leaks it nowhere else, and leaves the owner's draft alone", async () => {
    await db.insert(ticketReplyDrafts).values({
      ticketId: T_OPEN,
      userId: ALICE,
      content: doc("my own draft"),
      isInternal: false,
    });
    const before = await snapshot();

    const res = await replyReq();
    if (res.status !== "created") {
      throw new Error("expected created");
    }
    expect(res.action.payload).toEqual({ content: REPLY });

    const notifs = await notificationsOf("mcp_action_pending");
    expect(notifs).toHaveLength(1);
    expect(notifs[0].title).toBe(
      "Your AI assistant asks to send a reply on #101"
    );
    const leakSurfaces = JSON.stringify([
      notifs,
      await auditOf("mcp.action_requested"),
      pushCalls(),
    ]);
    expect(leakSurfaces).not.toContain(SECRET);

    expect(await snapshot()).toEqual(before);
    const drafts = await db
      .select()
      .from(ticketReplyDrafts)
      .where(
        and(
          eq(ticketReplyDrafts.ticketId, T_OPEN),
          eq(ticketReplyDrafts.userId, ALICE)
        )
      );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].content).toContain("my own draft");
  });

  it("returns the existing request on a repeat: one row, one notification, one audit", async () => {
    const first = await closeReq();
    const second = await closeReq();
    expect(first.status).toBe("created");
    expect(second.status).toBe("existing");
    if (first.status !== "created" || second.status !== "existing") {
      return;
    }
    expect(second.action.id).toBe(first.action.id);

    expect(await db.select().from(mcpPendingActions)).toHaveLength(1);
    expect(await notificationsOf("mcp_action_pending")).toHaveLength(1);
    expect(pushCalls()).toHaveLength(1);
    expect(await auditOf("mcp.action_requested")).toHaveLength(1);
  });

  it("yields exactly one row, notification and audit under concurrent requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => closeReq())
    );
    expect(results.filter((r) => r.status === "created")).toHaveLength(1);
    expect(results.filter((r) => r.status === "existing")).toHaveLength(5);
    const ids = new Set(
      results.map((r) => ("action" in r ? r.action.id : "none"))
    );
    expect(ids.size).toBe(1);

    expect(await db.select().from(mcpPendingActions)).toHaveLength(1);
    expect(await notificationsOf("mcp_action_pending")).toHaveLength(1);
    expect(await auditOf("mcp.action_requested")).toHaveLength(1);
  });

  it("keeps a close and a reply on one ticket apart, and each user's request their own", async () => {
    const close = await closeReq();
    const reply = await replyReq();
    const bobs = await closeReq({ userId: BOB, credentialId: TOK_BOB });
    const franks = await closeReq({ userId: FRANK, credentialId: TOK_FRANK });
    expect([close, reply, bobs, franks].map((r) => r.status)).toEqual([
      "created",
      "created",
      "created",
      "created",
    ]);
    expect(await db.select().from(mcpPendingActions)).toHaveLength(4);
  });

  it("is not blocked by an expired request that was never marked expired", async () => {
    const stale = await insertAction({
      expiresAt: new Date(Date.now() - HOUR),
    });
    const res = await closeReq();
    expect(res.status).toBe("created");
    if (res.status !== "created") {
      return;
    }
    expect(res.action.id).not.toBe(stale.id);
    expect((await getAction(stale.id)).status).toBe("expired");
    expect(await listActionablePendingActionsForViewer(T_OPEN, ALICE)).toEqual([
      expect.objectContaining({ id: res.action.id }),
    ]);
  });

  it("is refused when the credential is not the user's, revoked, or expired", async () => {
    // someone else's token
    expect(await closeReq({ credentialId: TOK_BOB })).toEqual({
      status: "not_permitted",
    });
    // unknown token
    expect(await closeReq({ credentialId: "nope" })).toEqual({
      status: "not_permitted",
    });
    // expired token
    await db.execute(
      sql`UPDATE mcp_access_tokens SET expires_at = now() - interval '1 hour' WHERE id = ${TOK_ALICE}`
    );
    expect(await closeReq()).toEqual({ status: "not_permitted" });
    // revoked token
    await db.execute(
      sql`UPDATE mcp_access_tokens SET expires_at = now() + interval '1 day', revoked_at = now(), revoked_reason = 'revoked_by_user' WHERE id = ${TOK_ALICE}`
    );
    expect(await closeReq()).toEqual({ status: "not_permitted" });
    expect(await db.select().from(mcpPendingActions)).toHaveLength(0);
    expect(await notificationsOf("mcp_action_pending")).toHaveLength(0);
  });

  it("is refused for a banned owner and for a non-agent role, even with a live token", async () => {
    expect(await closeReq({ userId: CAROL, credentialId: TOK_CAROL })).toEqual({
      status: "not_permitted",
    });
    expect(await closeReq({ userId: DAVE, credentialId: TOK_DAVE })).toEqual({
      status: "not_permitted",
    });
  });

  it("answers for the ticket's state", async () => {
    expect(await closeReq({ ticketId: "t-missing" })).toEqual({
      status: "ticket_not_found",
    });
    expect(await closeReq({ ticketId: T_MERGED })).toEqual({
      status: "ticket_merged",
    });
    expect(await closeReq({ ticketId: T_CLOSED })).toEqual({
      status: "ticket_closed",
    });
    expect(await replyReq({ ticketId: T_CLOSED })).toEqual({
      status: "ticket_closed",
    });
    expect(await db.select().from(mcpPendingActions)).toHaveLength(0);
  });

  it("rejects missing or empty reply content and a close with a payload", async () => {
    expect(await replyReq({ payload: undefined })).toEqual({
      status: "invalid_content",
    });
    expect(await replyReq({ payload: {} })).toEqual({
      status: "invalid_content",
    });
    expect(await replyReq({ payload: { content: "" } })).toEqual({
      status: "invalid_content",
    });
    expect(await replyReq({ payload: { content: doc("   ") } })).toEqual({
      status: "invalid_content",
    });
    expect(await replyReq({ payload: { content: 42 } })).toEqual({
      status: "invalid_content",
    });
    expect(await closeReq({ payload: { content: REPLY } })).toEqual({
      status: "invalid_content",
    });
    expect(await closeReq({ payload: "x" })).toEqual({
      status: "invalid_content",
    });
    expect(await db.select().from(mcpPendingActions)).toHaveLength(0);
  });

  it("still records the request, and its audit, when the push fails", async () => {
    pushFault.fail = true;
    const res = await closeReq();
    expect(res.status).toBe("created");
    expect(await db.select().from(mcpPendingActions)).toHaveLength(1);
    expect(await notificationsOf("mcp_action_pending")).toHaveLength(1);
    expect(await auditOf("mcp.action_requested")).toHaveLength(1);
  });
});

describe("what the viewer and an admin can see", () => {
  it("shows a request to its owner only, with the reply content and token name", async () => {
    const reply = await replyReq();
    const close = await closeReq();
    if (reply.status !== "created" || close.status !== "created") {
      throw new Error("expected created");
    }

    const mine = await listActionablePendingActionsForViewer(T_OPEN, ALICE);
    expect(mine.map((a) => a.id).sort()).toEqual(
      [close.action.id, reply.action.id].sort()
    );
    const replyRow = mine.find((a) => a.kind === "reply");
    expect(replyRow).toMatchObject({
      content: REPLY,
      credentialName: "Alice laptop",
    });
    expect(mine.find((a) => a.kind === "close")?.content).toBeNull();
    expect(replyRow?.expiresAt).toBeInstanceOf(Date);

    // another agent, an admin, and a different ticket see nothing
    expect(await listActionablePendingActionsForViewer(T_OPEN, FRANK)).toEqual(
      []
    );
    expect(await listActionablePendingActionsForViewer(T_OPEN, BOB)).toEqual(
      []
    );
    expect(
      await listActionablePendingActionsForViewer(tid(105), ALICE)
    ).toEqual([]);
  });

  it("hides revoked, expired and dismissed requests", async () => {
    const live = await insertAction({ kind: "close" });
    const expired = await insertAction({
      kind: "reply",
      payload: { content: REPLY },
      expiresAt: new Date(Date.now() - 1000),
    });
    await insertAction({
      kind: "close",
      ticketId: tid(105),
      status: "dismissed",
    });
    await insertAction({
      kind: "close",
      ticketId: tid(105),
      status: "approved",
    });
    expect(
      (await listActionablePendingActionsForViewer(T_OPEN, ALICE)).map(
        (a) => a.id
      )
    ).toEqual([live.id]);
    expect(
      await listActionablePendingActionsForViewer(tid(105), ALICE)
    ).toEqual([]);
    expect(expired.status).toBe("pending"); // expired by the clock, not yet marked

    await db.execute(
      sql`UPDATE mcp_access_tokens SET revoked_at = now() WHERE id = ${TOK_ALICE}`
    );
    expect(await listActionablePendingActionsForViewer(T_OPEN, ALICE)).toEqual(
      []
    );
  });

  it("still hides the request if the cancel trigger did not run (defence in depth)", async () => {
    await insertAction();
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
    // The row is still 'pending' in the table, but no longer actionable.
    const [row] = await db.select().from(mcpPendingActions);
    expect(row.status).toBe("pending");
    expect(await listActionablePendingActionsForViewer(T_OPEN, ALICE)).toEqual(
      []
    );
    expect(await listPendingActionsForAdmin()).toEqual([]);
  });

  it("hides a request whose owner was banned or demoted without the token being revoked", async () => {
    await insertAction();
    await db.execute(
      sql`ALTER TABLE "user" DISABLE TRIGGER mcp_access_tokens_revoke_on_user_update`
    );
    try {
      await db.update(user).set({ banned: true }).where(eq(user.id, ALICE));
      expect(
        await listActionablePendingActionsForViewer(T_OPEN, ALICE)
      ).toEqual([]);
      await db.update(user).set({ banned: false }).where(eq(user.id, ALICE));
      expect(
        await listActionablePendingActionsForViewer(T_OPEN, ALICE)
      ).toHaveLength(1);
      await db.update(user).set({ role: "user" }).where(eq(user.id, ALICE));
      expect(
        await listActionablePendingActionsForViewer(T_OPEN, ALICE)
      ).toEqual([]);
    } finally {
      await db.execute(
        sql`ALTER TABLE "user" ENABLE TRIGGER mcp_access_tokens_revoke_on_user_update`
      );
    }
  });

  it("lists every actionable request for an admin, newest first, without any content", async () => {
    const older = await insertAction({
      createdAt: new Date(Date.now() - 2 * HOUR),
    });
    const newer = await insertAction({
      kind: "reply",
      ticketId: tid(105),
      requestedById: FRANK,
      credentialId: TOK_FRANK,
      payload: { content: REPLY },
      createdAt: new Date(Date.now() - HOUR),
    });
    await insertAction({ status: "dismissed", ticketId: tid(105) });

    const rows = await listPendingActionsForAdmin();
    expect(rows.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(rows[0]).toMatchObject({
      kind: "reply",
      ticketNumber: 105,
      ownerEmail: "user-frank@example.test",
    });
    expect(rows[1]).toMatchObject({
      kind: "close",
      ticketNumber: 101,
      ticketSubject: "Cannot log in",
      ownerName: "Alice Agent",
      ownerEmail: "alice@example.test",
    });
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        "createdAt",
        "expiresAt",
        "id",
        "kind",
        "ownerEmail",
        "ownerName",
        "ticketNumber",
        "ticketSubject",
      ]);
    }
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it("gives the admin list no way to decide", () => {
    const source = readFileSync(
      "app/(admin)/admin/mcp/_components/mcp-pending-actions-list.tsx",
      "utf8"
    );
    expect(source).not.toMatch(
      /fetch\(|"use client"|\/api\/mcp\/actions|Approve|Dismiss|onClick/
    );
  });
});

describe("customers never see a pending request", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        return sourceFiles(path);
      }
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  it("is read by no customer-facing source", () => {
    const files = [
      ...sourceFiles("app/(customer)"),
      ...sourceFiles("app/api/v1"),
      ...sourceFiles("lib/email"),
      "lib/tickets/queries.ts",
    ];
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(
        /mcp_pending|mcpPendingActions|pending-actions/
      );
    }
  });

  it("is absent from the v1 ticket and comment responses", async () => {
    const reply = await replyReq();
    const close = await closeReq();
    if (reply.status !== "created" || close.status !== "created") {
      throw new Error("expected created");
    }
    const ctx = { params: Promise.resolve({ id: T_OPEN }) };
    const headers = { authorization: "Bearer test" };
    const ticket = await V1_TICKET(
      new NextRequest(`http://localhost:3000/api/v1/tickets/${T_OPEN}`, {
        headers,
      }),
      ctx
    );
    const comments = await V1_COMMENTS(
      new NextRequest(
        `http://localhost:3000/api/v1/tickets/${T_OPEN}/comments`,
        { headers }
      ),
      ctx
    );
    expect(ticket.status).toBe(200);
    expect(comments.status).toBe(200);
    for (const res of [ticket, comments]) {
      const text = await res.text();
      expect(text).not.toContain(reply.action.id);
      expect(text).not.toContain(close.action.id);
      expect(text).not.toContain(SECRET);
    }
    // and nothing was created in the thread
    expect(
      await db
        .select()
        .from(ticketComments)
        .where(eq(ticketComments.ticketId, T_OPEN))
    ).toHaveLength(0);
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
  });
});
