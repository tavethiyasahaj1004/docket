import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emailOutbox,
  mcpAccessTokens,
  type mcpPendingActions,
  ticketActivity,
  ticketComments,
  tickets,
} from "@/db/schema";
import { db } from "@/lib/db";

const requireAdmin = vi.hoisted(() => vi.fn());
const requireSession = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/auth", async () =>
  (await import("./characterization/write-helpers")).authModule()
);
vi.mock("@/lib/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authz")>();
  return { ...actual, requireAdmin, requireSession };
});
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

import { toggleUserBanAction } from "@/app/actions/orbit-users";
import { signOutOtherSessionsAction } from "@/app/actions/profile";
import { DELETE as ACCOUNT_REVOKE } from "@/app/api/account/mcp-tokens/[id]/route";
import { DELETE as ADMIN_REVOKE } from "@/app/api/admin/mcp/tokens/[id]/route";
import { POST as APPROVE } from "@/app/api/mcp/actions/[id]/approve/route";
import { PATCH as USERS_PATCH } from "@/app/api/users/[id]/route";
import { MCP_PENDING_ACTION_RECONCILE_AFTER_MS } from "@/lib/mcp/limits";
import {
  createPendingAction,
  type PendingAction,
} from "@/lib/mcp/pending-actions";
import { expirePendingActions } from "@/lib/mcp/pending-actions-core";
import { sweepStuckApprovedActions } from "@/lib/mcp/pending-actions-reconcile";
import { mergeTicketsInto } from "@/lib/tickets/merge";
import { handleMcpPendingCallsSweep } from "@/lib/worker/handlers/mcp-pending-calls-sweep";
import { handleMcpToolCallsPrune } from "@/lib/worker/handlers/mcp-tool-calls-prune";
import { enqueueMode } from "./characterization/write-helpers";
import { tid } from "./fixtures";
import {
  ALICE,
  actionRequest,
  allActions,
  auditOf,
  BOB,
  callLog,
  FRANK,
  getAction,
  HOUR,
  insertAction,
  installSessionMock,
  REPLY,
  routeCtx,
  seedPendingWorld,
  snapshot,
  T_OPEN,
  T_OTHER_OPEN,
  TOK_ALICE,
  TOK_BOB,
  USERS,
} from "./mcp-pending-helpers";

const MINUTE = 60 * 1000;

const as = (u: { id: string; name: string; email: string }, role: string) => ({
  "x-user-id": u.id,
  "x-user-name": u.name,
  "x-user-email": u.email,
  "x-user-role": role,
});
const ALICE_H = as(USERS.alice, "agent");
const BOB_H = as(USERS.bob, "admin");
const FRANK_H = as(
  { id: FRANK, name: `Name ${FRANK}`, email: `${FRANK}@example.test` },
  "agent"
);

const ADMIN_USER = {
  id: BOB,
  name: USERS.bob.name,
  email: USERS.bob.email,
  role: "admin",
};

beforeEach(async () => {
  vi.useRealTimers();
  callLog.length = 0;
  enqueueMode.email = "resolve";
  installSessionMock();
  requireAdmin.mockReset();
  requireAdmin.mockResolvedValue(ADMIN_USER);
  requireSession.mockReset();
  revalidatePath.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await seedPendingWorld();
  return () => {
    vi.restoreAllMocks();
  };
});

async function request(
  kind: "close" | "reply",
  over: Partial<Parameters<typeof createPendingAction>[0]> = {}
): Promise<PendingAction> {
  const res = await createPendingAction({
    userId: ALICE,
    credentialId: TOK_ALICE,
    ticketId: T_OPEN,
    kind,
    payload: kind === "reply" ? { content: REPLY } : undefined,
    ...over,
  });
  if (res.status !== "created") {
    throw new Error(`could not create: ${res.status}`);
  }
  return res.action;
}

async function statusOf(id: string) {
  const row = await getAction(id);
  return { status: row.status, reason: row.statusReason };
}

const CANCELLED = { status: "cancelled", reason: "token_revoked" };

describe("schema", () => {
  it("has the partial unique index and the revoke trigger", async () => {
    const idx = await db.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'mcp_pending_actions'
        AND indexname = 'mcp_pending_actions_pending_idx'`);
    expect(String(idx[0]?.indexdef)).toMatch(/UNIQUE/);
    expect(String(idx[0]?.indexdef)).toMatch(
      /\(ticket_id, kind, requested_by_id\)/
    );
    expect(String(idx[0]?.indexdef)).toMatch(/status = 'pending'/);

    const trg = await db.execute(sql`
      SELECT tgname FROM pg_trigger
      WHERE tgname = 'mcp_pending_actions_cancel_on_token_revoke'
        AND NOT tgisinternal`);
    expect(trg).toHaveLength(1);
  });

  it("deletes with the ticket and survives the credential being deleted", async () => {
    const action = await request("close");
    await db.delete(mcpAccessTokens).where(eq(mcpAccessTokens.id, TOK_ALICE));
    expect((await getAction(action.id)).credentialId).toBeNull();
    await db.delete(tickets).where(eq(tickets.id, T_OPEN));
    expect(await allActions()).toHaveLength(0);
  });
});

describe("cancelled when the token is revoked by the app", () => {
  it("self revoke: cancels that token's requests only, audited with the owner as actor", async () => {
    const mine = await request("close");
    const alsoMine = await request("reply");
    const bobs = await request("close", {
      userId: BOB,
      credentialId: TOK_BOB,
    });

    const res = await ACCOUNT_REVOKE(
      new NextRequest(
        `http://localhost:3000/api/account/mcp-tokens/${TOK_ALICE}`,
        { method: "DELETE", headers: ALICE_H }
      ),
      routeCtx(TOK_ALICE)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await statusOf(mine.id)).toEqual(CANCELLED);
    expect(await statusOf(alsoMine.id)).toEqual(CANCELLED);
    expect((await getAction(bobs.id)).status).toBe("pending");

    const audits = await auditOf("mcp.action_cancelled");
    expect(audits.map((a) => a.entityId).sort()).toEqual(
      [mine.id, alsoMine.id].sort()
    );
    for (const a of audits) {
      expect(a).toMatchObject({
        actorId: ALICE,
        actorEmail: "alice@example.test",
        entityType: "mcp_pending_action",
        metadata: {
          via: "mcp",
          ticketId: T_OPEN,
          credentialId: TOK_ALICE,
          requestedById: ALICE,
          reason: "token_revoked",
        },
      });
    }
    expect(
      audits.map((a) => (a.metadata as { kind: string }).kind).sort()
    ).toEqual(["close", "reply"]);
  });

  it("another user's self revoke cannot cancel someone else's requests", async () => {
    const mine = await request("close");

    const res = await ACCOUNT_REVOKE(
      new NextRequest(
        `http://localhost:3000/api/account/mcp-tokens/${TOK_ALICE}`,
        { method: "DELETE", headers: FRANK_H }
      ),
      routeCtx(TOK_ALICE)
    );
    expect(res.status).toBe(404);

    expect((await getAction(mine.id)).status).toBe("pending");
    expect(await auditOf("mcp.action_cancelled")).toHaveLength(0);
    const [token] = await db
      .select()
      .from(mcpAccessTokens)
      .where(eq(mcpAccessTokens.id, TOK_ALICE));
    expect(token.revokedAt).toBeNull();
  });

  it("admin revoke: cancels the owner's requests, audited with the admin as actor", async () => {
    const mine = await request("close");

    const res = await ADMIN_REVOKE(
      new NextRequest(
        `http://localhost:3000/api/admin/mcp/tokens/${TOK_ALICE}`,
        { method: "DELETE", headers: BOB_H }
      ),
      routeCtx(TOK_ALICE)
    );
    expect(res.status).toBe(200);

    expect(await statusOf(mine.id)).toEqual(CANCELLED);
    const audits = await auditOf("mcp.action_cancelled");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: BOB,
      actorEmail: "bob@example.test",
      entityId: mine.id,
      metadata: { requestedById: ALICE, reason: "token_revoked" },
    });
  });

  it("Orbit ban: cancels every request of the banned user, audited with the admin", async () => {
    const mine = await request("close");
    const alsoMine = await request("reply");
    const bobs = await request("close", { userId: BOB, credentialId: TOK_BOB });

    const form = new FormData();
    form.set("userId", ALICE);
    form.set("banned", "true");
    await toggleUserBanAction(form);

    expect(await statusOf(mine.id)).toEqual(CANCELLED);
    expect(await statusOf(alsoMine.id)).toEqual(CANCELLED);
    expect((await getAction(bobs.id)).status).toBe("pending");
    const audits = await auditOf("mcp.action_cancelled");
    expect(audits).toHaveLength(2);
    for (const a of audits) {
      expect(a).toMatchObject({ actorId: BOB, actorEmail: "bob@example.test" });
    }
  });

  it("PATCH /api/users/[id] ban: cancels every request, audited with the admin", async () => {
    const mine = await request("close");

    const res = await USERS_PATCH(
      new NextRequest(`http://localhost:3000/api/users/${ALICE}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...BOB_H },
        body: JSON.stringify({ banned: true, banReason: "left" }),
      }),
      routeCtx(ALICE)
    );
    expect(res.status).toBe(200);

    expect(await statusOf(mine.id)).toEqual(CANCELLED);
    const audits = await auditOf("mcp.action_cancelled");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: BOB,
      entityId: mine.id,
      metadata: { reason: "token_revoked", requestedById: ALICE },
    });
  });

  it("unbanning cancels nothing", async () => {
    const mine = await request("close");
    const form = new FormData();
    form.set("userId", ALICE);
    form.set("banned", "false");
    await toggleUserBanAction(form);
    expect((await getAction(mine.id)).status).toBe("pending");
    expect(await auditOf("mcp.action_cancelled")).toHaveLength(0);
  });

  it("signing out other sessions: cancels the user's requests, audited with the user", async () => {
    const mine = await request("close");
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    await db.execute(sql`
      INSERT INTO session (id, user_id, token, expires_at)
      VALUES ('s-cur', ${ALICE}, 'tok-cur', ${expires}),
             ('s-oth', ${ALICE}, 'tok-oth', ${expires})`);
    requireSession.mockResolvedValue({
      user: {
        id: ALICE,
        name: USERS.alice.name,
        email: USERS.alice.email,
        role: "agent",
      },
      session: { token: "tok-cur" },
    });

    await signOutOtherSessionsAction();

    expect(await statusOf(mine.id)).toEqual(CANCELLED);
    const audits = await auditOf("mcp.action_cancelled");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: ALICE,
      actorEmail: "alice@example.test",
      entityId: mine.id,
    });
  });

  it("a cancelled request can no longer be approved", async () => {
    const mine = await request("reply");
    await ACCOUNT_REVOKE(
      new NextRequest(
        `http://localhost:3000/api/account/mcp-tokens/${TOK_ALICE}`,
        { method: "DELETE", headers: ALICE_H }
      ),
      routeCtx(TOK_ALICE)
    );
    const before = await snapshot();
    const res = await APPROVE(
      actionRequest("approve", mine.id, "alice"),
      routeCtx(mine.id)
    );
    expect(res.status).toBe(404);
    expect(await snapshot()).toEqual(before);
  });
});

describe("cancelled by the database trigger (no audit row)", () => {
  it("direct SQL ban", async () => {
    const mine = await request("close");
    await db.execute(sql`UPDATE "user" SET banned = true WHERE id = ${ALICE}`);
    expect(await statusOf(mine.id)).toEqual(CANCELLED);
    expect(await auditOf("mcp.action_cancelled")).toHaveLength(0);
  });

  it("direct SQL role change to a role that may not hold a token", async () => {
    const mine = await request("reply");
    await db.execute(sql`UPDATE "user" SET role = 'user' WHERE id = ${ALICE}`);
    expect(await statusOf(mine.id)).toEqual(CANCELLED);
    expect(await auditOf("mcp.action_cancelled")).toHaveLength(0);
  });

  it("direct SQL token revoke, and it leaves other users' requests alone", async () => {
    const mine = await request("close");
    const bobs = await request("close", { userId: BOB, credentialId: TOK_BOB });
    await db.execute(
      sql`UPDATE mcp_access_tokens SET revoked_at = now() WHERE id = ${TOK_ALICE}`
    );
    expect(await statusOf(mine.id)).toEqual(CANCELLED);
    expect((await getAction(bobs.id)).status).toBe("pending");
  });

  it("settled requests keep their status when the token is revoked later", async () => {
    const dismissed = await insertAction({ status: "dismissed" });
    const approved = await insertAction({
      kind: "reply",
      status: "approved",
      payload: { content: REPLY },
    });
    await db.execute(
      sql`UPDATE mcp_access_tokens SET revoked_at = now() WHERE id = ${TOK_ALICE}`
    );
    expect((await getAction(dismissed.id)).status).toBe("dismissed");
    expect((await getAction(approved.id)).status).toBe("approved");
  });
});

describe("cancelled when a ticket is merged away", () => {
  const MERGER = {
    id: BOB,
    name: USERS.bob.name,
    email: USERS.bob.email,
    role: "admin",
  };

  it("cancels the source's requests and leaves the target's alone", async () => {
    const onSource = await request("close", { ticketId: T_OTHER_OPEN });
    const onSourceReply = await request("reply", { ticketId: T_OTHER_OPEN });
    const onTarget = await request("reply", { ticketId: T_OPEN });

    const merged = await mergeTicketsInto([T_OTHER_OPEN], 101, MERGER);
    expect(merged.ok).toBe(true);

    expect(await getAction(onSource.id)).toMatchObject({
      status: "cancelled",
      statusReason: "ticket_merged",
    });
    expect(await getAction(onSourceReply.id)).toMatchObject({
      status: "cancelled",
      statusReason: "ticket_merged",
    });
    expect((await getAction(onTarget.id)).status).toBe("pending");

    const audits = await auditOf("mcp.action_cancelled");
    expect(audits.map((a) => a.entityId).sort()).toEqual(
      [onSource.id, onSourceReply.id].sort()
    );
    for (const a of audits) {
      expect(a).toMatchObject({
        actorId: BOB,
        actorEmail: "bob@example.test",
        metadata: {
          via: "mcp",
          ticketId: T_OTHER_OPEN,
          requestedById: ALICE,
          reason: "ticket_merged",
        },
      });
    }

    // the owner can no longer approve the source's request (status is not
    // pending, but the owner and token are fine, so it is a 409)
    const before = await snapshot(T_OTHER_OPEN);
    const res = await APPROVE(
      actionRequest("approve", onSource.id, "alice"),
      routeCtx(onSource.id)
    );
    expect(res.status).toBe(409);
    expect(await snapshot(T_OTHER_OPEN)).toEqual(before);
  });

  it("a merge with no pending requests is unchanged", async () => {
    const merged = await mergeTicketsInto([T_OTHER_OPEN], 101, MERGER);
    expect(merged.ok).toBe(true);
    expect(await auditOf("mcp.action_cancelled")).toHaveLength(0);
  });
});

describe("expiry", () => {
  it("expirePendingActions marks only pending requests past their expiry", async () => {
    const stale = await insertAction({
      expiresAt: new Date(Date.now() - HOUR),
    });
    const fresh = await insertAction({
      kind: "reply",
      payload: { content: REPLY },
    });
    const approved = await insertAction({
      kind: "reply",
      ticketId: tid(105),
      status: "approved",
      expiresAt: new Date(Date.now() - HOUR),
    });

    await expirePendingActions();

    expect((await getAction(stale.id)).status).toBe("expired");
    expect((await getAction(fresh.id)).status).toBe("pending");
    expect((await getAction(approved.id)).status).toBe("approved");
  });

  it("the daily prune job runs it", async () => {
    const stale = await insertAction({
      expiresAt: new Date(Date.now() - HOUR),
    });
    await handleMcpToolCallsPrune([]);
    expect((await getAction(stale.id)).status).toBe("expired");
  });
});

describe("crash reconcile: approved requests that never recorded a result", () => {
  const decidedLongAgo = () => new Date(Date.now() - 10 * MINUTE);

  function stuck(over: Partial<typeof mcpPendingActions.$inferInsert> = {}) {
    return insertAction({
      status: "approved",
      plannedEntityId: `planned-${Math.random().toString(36).slice(2)}`,
      decidedAt: decidedLongAgo(),
      ...over,
    });
  }

  const insertComment = (id: string) =>
    db.insert(ticketComments).values({
      id,
      ticketId: T_OPEN,
      authorId: ALICE,
      authorName: "Alice Agent",
      authorRole: "agent",
      content: REPLY,
      isInternal: false,
    });

  const insertCloseActivity = (id: string, createdAt: Date = new Date()) =>
    db.insert(ticketActivity).values({
      id,
      ticketId: T_OPEN,
      actorId: ALICE,
      actorName: "Alice Agent",
      actorRole: "agent",
      action: "ticket_closed",
      metadata: { from: "open", to: "closed" },
      createdAt,
    });

  const closeTicketRow = (closedAt: Date) =>
    db
      .update(tickets)
      .set({ status: "closed", closedAt })
      .where(eq(tickets.id, T_OPEN));

  it("a reply whose comment exists: recorded, flagged uncertain, status unchanged", async () => {
    const row = await stuck({ kind: "reply", payload: { content: REPLY } });
    await insertComment(row.plannedEntityId as string);

    await sweepStuckApprovedActions();

    expect(await getAction(row.id)).toMatchObject({
      status: "approved",
      result: { commentId: row.plannedEntityId },
      sideEffectsUncertain: true,
    });
  });

  it("a reply that never landed: failed (interrupted), nothing created or sent", async () => {
    const row = await stuck({ kind: "reply", payload: { content: REPLY } });
    const before = await snapshot();

    await sweepStuckApprovedActions();

    expect(await getAction(row.id)).toMatchObject({
      status: "failed",
      statusReason: "interrupted",
      result: null,
    });
    expect(await snapshot()).toEqual(before);
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
  });

  it("a close whose activity row exists: recorded, flagged uncertain", async () => {
    const row = await stuck();
    await closeTicketRow(new Date());
    await insertCloseActivity(row.plannedEntityId as string);

    await sweepStuckApprovedActions();

    expect(await getAction(row.id)).toMatchObject({
      status: "approved",
      result: { activityId: row.plannedEntityId },
      sideEffectsUncertain: true,
    });
  });

  it("a close that landed and was reopened afterwards still counts as landed", async () => {
    const row = await stuck();
    await insertCloseActivity(row.plannedEntityId as string);
    // the ticket is open again (reopened after the close)
    const before = await snapshot();
    expect(before.status).toBe("open");

    await sweepStuckApprovedActions();

    expect(await getAction(row.id)).toMatchObject({
      status: "approved",
      result: { activityId: row.plannedEntityId },
      sideEffectsUncertain: true,
    });
    expect((await snapshot()).status).toBe("open");
  });

  it("a close that never landed (ticket still open): failed, ticket untouched, no email", async () => {
    const row = await stuck();
    const before = await snapshot();

    await sweepStuckApprovedActions();

    expect(await getAction(row.id)).toMatchObject({
      status: "failed",
      statusReason: "interrupted",
    });
    expect(await snapshot()).toEqual(before);
    expect(before.status).toBe("open");
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
  });

  it("a close the ticket got clearly before the approval: alreadyClosed, not uncertain", async () => {
    const decidedAt = decidedLongAgo();
    const row = await stuck({ decidedAt });
    await closeTicketRow(new Date(decidedAt.getTime() - HOUR));

    await sweepStuckApprovedActions();

    expect(await getAction(row.id)).toMatchObject({
      status: "approved",
      result: { alreadyClosed: true },
      sideEffectsUncertain: false,
    });
  });

  it("another closer's activity since the approval: alreadyClosed, not uncertain", async () => {
    const decidedAt = decidedLongAgo();
    const row = await stuck({ decidedAt });
    await closeTicketRow(new Date(decidedAt.getTime() + MINUTE));
    await insertCloseActivity(
      "someone-elses-close",
      new Date(decidedAt.getTime() + MINUTE)
    );

    await sweepStuckApprovedActions();

    expect(await getAction(row.id)).toMatchObject({
      result: { alreadyClosed: true },
      sideEffectsUncertain: false,
    });
  });

  it("closed since the approval with no activity at all: alreadyClosed, uncertain", async () => {
    const decidedAt = decidedLongAgo();
    const row = await stuck({ decidedAt });
    await closeTicketRow(new Date(decidedAt.getTime() + MINUTE));

    await sweepStuckApprovedActions();

    expect(await getAction(row.id)).toMatchObject({
      status: "approved",
      result: { alreadyClosed: true },
      sideEffectsUncertain: true,
    });
  });

  it("a gap smaller than the lease window is treated conservatively (uncertain)", async () => {
    const decidedAt = decidedLongAgo();
    const row = await stuck({ decidedAt });
    await closeTicketRow(new Date(decidedAt.getTime() - 10_000));

    await sweepStuckApprovedActions();

    expect(await getAction(row.id)).toMatchObject({
      result: { alreadyClosed: true },
      sideEffectsUncertain: true,
    });
  });

  it("a row with no planned id fails as interrupted", async () => {
    const row = await stuck({ plannedEntityId: null });
    await sweepStuckApprovedActions();
    expect(await getAction(row.id)).toMatchObject({
      status: "failed",
      statusReason: "interrupted",
    });
  });

  it("leaves a recent approval, a settled one, and non-approved rows alone", async () => {
    const recent = await stuck({
      decidedAt: new Date(
        Date.now() - MCP_PENDING_ACTION_RECONCILE_AFTER_MS + MINUTE
      ),
    });
    const settled = await stuck({ result: { alreadyClosed: true } });
    const pending = await insertAction({
      kind: "reply",
      payload: { content: REPLY },
    });
    const dismissed = await insertAction({
      kind: "reply",
      ticketId: tid(105),
      status: "dismissed",
      decidedAt: decidedLongAgo(),
    });

    await sweepStuckApprovedActions();

    expect(await getAction(recent.id)).toMatchObject({
      status: "approved",
      result: null,
    });
    expect(await getAction(settled.id)).toMatchObject({
      status: "approved",
      result: { alreadyClosed: true },
      sideEffectsUncertain: false,
    });
    expect((await getAction(pending.id)).status).toBe("pending");
    expect((await getAction(dismissed.id)).status).toBe("dismissed");
  });

  it("is not run twice over the same row, and a repeat sweep changes nothing", async () => {
    const row = await stuck({ kind: "reply", payload: { content: REPLY } });
    await insertComment(row.plannedEntityId as string);
    await sweepStuckApprovedActions();
    const first = await getAction(row.id);
    await sweepStuckApprovedActions();
    expect(await getAction(row.id)).toEqual(first);
  });

  it("the 5-minute sweep job runs it", async () => {
    const row = await stuck();
    await handleMcpPendingCallsSweep([]);
    expect((await getAction(row.id)).status).toBe("failed");
  });

  it("keeps going when one row cannot be settled", async () => {
    // Oldest first, so the failing row is reached before the good one.
    const bad = await stuck({
      kind: "reply",
      payload: { content: REPLY },
      decidedAt: new Date(Date.now() - 30 * MINUTE),
    });
    const good = await stuck({ decidedAt: new Date(Date.now() - 20 * MINUTE) });

    // The reply lookup now fails; the close lookup does not touch this table.
    await db.execute(
      sql`ALTER TABLE ticket_comments RENAME TO ticket_comments_x`
    );
    try {
      await sweepStuckApprovedActions();
    } finally {
      await db.execute(
        sql`ALTER TABLE ticket_comments_x RENAME TO ticket_comments`
      );
    }

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`pending_action_reconcile_failed id=${bad.id}`),
      expect.any(String)
    );
    expect((await getAction(bad.id)).status).toBe("approved");
    expect((await getAction(good.id)).status).toBe("failed");

    // Once the table is back, the next sweep settles the first row too.
    await sweepStuckApprovedActions();
    expect((await getAction(bad.id)).status).toBe("failed");
  });
});
