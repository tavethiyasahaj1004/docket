import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the session plumbing is mocked. The ban/sign-out code under test runs for
// real against the test database.
const auditOrThrowMock = vi.hoisted(() => vi.fn());
const requireAdmin = vi.hoisted(() => vi.fn());
const requireSession = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({ auth: { api: {} } }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, auditOrThrow: auditOrThrowMock };
});
vi.mock("@/lib/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authz")>();
  return { ...actual, requireAdmin, requireSession };
});

import { toggleUserBanAction } from "@/app/actions/orbit-users";
import { signOutOtherSessionsAction } from "@/app/actions/profile";
import { PATCH } from "@/app/api/users/[id]/route";
import { hashMcpToken } from "@/lib/mcp-tokens";
import {
  addToken,
  addUser,
  auditRows,
  liveTokenCount,
  PAST,
  settlesWithin,
  setupMcpWorld,
  tokenStates,
  USERS,
} from "./mcp-helpers";

const world = setupMcpWorld();

const ALICE = USERS.alice.id; // agent
const BOB = USERS.bob.id; // admin
const CAROL = USERS.carol.id; // agent, banned

const ADMIN_SESSION_USER = {
  id: BOB,
  name: USERS.bob.name,
  email: USERS.bob.email,
  role: "admin",
};

beforeEach(async () => {
  auditOrThrowMock.mockReset();
  const actualAudit =
    await vi.importActual<typeof import("@/lib/audit")>("@/lib/audit");
  auditOrThrowMock.mockImplementation(actualAudit.auditOrThrow);
  requireAdmin.mockReset();
  requireAdmin.mockResolvedValue(ADMIN_SESSION_USER);
  requireSession.mockReset();
  revalidatePath.mockReset();
});

function patch(targetId: string, body: unknown, asAdmin = ADMIN_SESSION_USER) {
  const request = new NextRequest(
    `http://localhost:3000/api/users/${targetId}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-user-id": asAdmin.id,
        "x-user-name": asAdmin.name,
        "x-user-email": asAdmin.email,
        "x-user-role": asAdmin.role,
      },
      body: JSON.stringify(body),
    }
  );
  return PATCH(request, { params: Promise.resolve({ id: targetId }) });
}

async function userRow(id: string) {
  const [row] = await world.sql`
    SELECT banned, role, ban_reason FROM "user" WHERE id = ${id}`;
  return row;
}

function expectNoSecrets(
  rows: Array<Record<string, unknown>>,
  tokens: Array<{ raw: string; hash: string }>
) {
  const json = JSON.stringify(rows);
  for (const t of tokens) {
    expect(json).not.toContain(t.raw);
    expect(json).not.toContain(t.hash);
  }
  expect(json).not.toContain("key_hash");
  expect(json).not.toContain("keyHash");
}

describe("PATCH /api/users/[id] ban", () => {
  it("revokes every live token and audits each one with the admin as actor", async () => {
    const t1 = await addToken(world.db, ALICE, { name: "one" });
    const t2 = await addToken(world.db, ALICE, { name: "two" });
    const other = await addToken(world.db, BOB);

    const res = await patch(ALICE, { banned: true, banReason: "left company" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await userRow(ALICE)).toMatchObject({
      banned: true,
      ban_reason: "left company",
    });
    const states = await tokenStates(world.sql, ALICE);
    expect(states).toHaveLength(2);
    for (const s of states) {
      expect(s.revoked_at).not.toBeNull();
      expect(s.revoked_reason).toBe("user_banned");
    }
    expect(await liveTokenCount(world.sql, BOB)).toBe(1);

    const audits = await auditRows(world.sql, "mcp_token.revoked");
    expect(audits.map((a) => a.entity_id).sort()).toEqual(
      [t1.id, t2.id].sort()
    );
    for (const a of audits) {
      expect(a.actor_id).toBe(BOB);
      expect(a.actor_email).toBe(USERS.bob.email);
      expect(a.entity_type).toBe("mcp_token");
      expect(a.metadata).toMatchObject({
        reason: "user_banned",
        targetUserId: ALICE,
        targetEmail: USERS.alice.email,
      });
    }
    expectNoSecrets(audits, [t1, t2, other]);

    const banAudits = await auditRows(world.sql, "user.banned");
    expect(banAudits).toHaveLength(1);
    expect(banAudits[0].actor_id).toBe(BOB);
    expect(banAudits[0].entity_id).toBe(ALICE);
  });

  it("keeps tokens revoked after the user is unbanned", async () => {
    const t = await addToken(world.db, ALICE);
    expect((await patch(ALICE, { banned: true })).status).toBe(200);
    const [before] = await tokenStates(world.sql, ALICE);

    const res = await patch(ALICE, { banned: false });
    expect(res.status).toBe(200);
    expect((await userRow(ALICE)).banned).toBe(false);

    const [after] = await tokenStates(world.sql, ALICE);
    expect(after.revoked_at).toBe(before.revoked_at);
    expect(after.revoked_reason).toBe("user_banned");
    expect(await auditRows(world.sql, "mcp_token.revoked")).toHaveLength(1);
    expect(await auditRows(world.sql, "user.unbanned")).toHaveLength(1);
    expect(hashMcpToken(t.raw)).toBe(t.hash);
  });

  it("does not rewrite tokens that were already revoked", async () => {
    const old = await addToken(world.db, ALICE, {
      revokedAt: PAST,
      revokedReason: "revoked_by_user",
    });
    const live = await addToken(world.db, ALICE);

    expect((await patch(ALICE, { banned: true })).status).toBe(200);

    const states = Object.fromEntries(
      (await tokenStates(world.sql, ALICE)).map((s) => [s.id, s])
    );
    expect(states[old.id].revoked_reason).toBe("revoked_by_user");
    expect(new Date(states[old.id].revoked_at as string).toISOString()).toBe(
      PAST.toISOString()
    );
    expect(states[live.id].revoked_reason).toBe("user_banned");
    const audits = await auditRows(world.sql, "mcp_token.revoked");
    expect(audits.map((a) => a.entity_id)).toEqual([live.id]);
  });

  it("rolls the whole ban back when an audit write fails", async () => {
    const t = await addToken(world.db, ALICE);
    auditOrThrowMock.mockRejectedValue(new Error("audit exploded"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await patch(ALICE, { banned: true });
    errorSpy.mockRestore();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to update user." });
    expect((await userRow(ALICE)).banned).toBe(false);
    const [state] = await tokenStates(world.sql, ALICE);
    expect(state.id).toBe(t.id);
    expect(state.revoked_at).toBeNull();
    expect(await auditRows(world.sql, "user.banned")).toHaveLength(0);
  });

  it("refuses an admin banning themselves and leaves tokens alone", async () => {
    await addToken(world.db, BOB);
    const res = await patch(BOB, { banned: true });
    expect(res.status).toBe(422);
    expect((await userRow(BOB)).banned).toBe(false);
    expect(await liveTokenCount(world.sql, BOB)).toBe(1);
  });

  it("unbanning an eligible user revokes nothing", async () => {
    // Inserted directly: a banned user's token insert does not fire the trigger.
    const t = await addToken(world.db, CAROL);
    const res = await patch(CAROL, { banned: false });
    expect(res.status).toBe(200);
    expect((await userRow(CAROL)).banned).toBe(false);
    const [state] = await tokenStates(world.sql, CAROL);
    expect(state.id).toBe(t.id);
    expect(state.revoked_at).toBeNull();
    expect(await auditRows(world.sql, "mcp_token.revoked")).toHaveLength(0);
  });

  it("changing between agent and admin revokes nothing", async () => {
    const agent = await addToken(world.db, ALICE);
    const admin = await addUser(world.db, { role: "admin" });
    const adminToken = await addToken(world.db, admin);

    expect((await patch(ALICE, { role: "admin" })).status).toBe(200);
    expect((await patch(admin, { role: "agent" })).status).toBe(200);

    expect((await userRow(ALICE)).role).toBe("admin");
    expect((await userRow(admin)).role).toBe("agent");
    expect(await liveTokenCount(world.sql, ALICE)).toBe(1);
    expect(await liveTokenCount(world.sql, admin)).toBe(1);
    expect(agent.id).toBeTruthy();
    expect(adminToken.id).toBeTruthy();
    expect(await auditRows(world.sql, "mcp_token.revoked")).toHaveLength(0);
  });
});

describe("PATCH ban versus a concurrent token insert", () => {
  it("(c) waits for the in-flight insert, then revokes and audits the new token", async () => {
    const holder = world.open();
    try {
      await holder.unsafe("BEGIN");
      await holder`SELECT id FROM "user" WHERE id = ${ALICE} FOR SHARE`;
      await holder`
        INSERT INTO mcp_access_tokens
          (id, user_id, name, key_prefix, key_hash, scopes, expires_at)
        VALUES ('racing-token', ${ALICE}, 'racing', 'dkm_racing00', 'racing-hash',
                ARRAY['tickets:read'], now() + interval '1 day')`;

      const pending = patch(ALICE, { banned: true });
      expect(await settlesWithin(pending, 300)).toBe(false);

      await holder.unsafe("COMMIT");
      const res = await pending;
      expect(res.status).toBe(200);

      const [state] = await tokenStates(world.sql, ALICE);
      expect(state.id).toBe("racing-token");
      expect(state.revoked_reason).toBe("user_banned");
      const audits = await auditRows(world.sql, "mcp_token.revoked");
      expect(audits).toHaveLength(1);
      expect(audits[0].entity_id).toBe("racing-token");
      expect(audits[0].actor_id).toBe(BOB);
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => undefined);
      await holder.end({ timeout: 5 });
    }
  }, 30_000);
});

describe("toggleUserBanAction", () => {
  function form(userId: string, banned: boolean) {
    const data = new FormData();
    data.set("userId", userId);
    data.set("banned", String(banned));
    return data;
  }

  it("revokes tokens with a per-token audit row naming the admin", async () => {
    const t1 = await addToken(world.db, ALICE);
    const t2 = await addToken(world.db, ALICE);
    const other = await addToken(world.db, BOB);

    await toggleUserBanAction(form(ALICE, true));

    expect((await userRow(ALICE)).banned).toBe(true);
    for (const s of await tokenStates(world.sql, ALICE)) {
      expect(s.revoked_at).not.toBeNull();
      expect(s.revoked_reason).toBe("user_banned");
    }
    expect(await liveTokenCount(world.sql, BOB)).toBe(1);

    const audits = await auditRows(world.sql, "mcp_token.revoked");
    expect(audits.map((a) => a.entity_id).sort()).toEqual(
      [t1.id, t2.id].sort()
    );
    for (const a of audits) {
      expect(a.actor_id).toBe(BOB);
      expect(a.actor_email).toBe(USERS.bob.email);
      expect(a.entity_type).toBe("mcp_token");
      expect(a.metadata).toMatchObject({
        reason: "user_banned",
        targetUserId: ALICE,
      });
    }
    expectNoSecrets(audits, [t1, t2, other]);
    expect(await auditRows(world.sql, "orbit.user_banned")).toHaveLength(1);
    expect(revalidatePath).toHaveBeenCalledWith("/orbit/users");
  });

  it("keeps tokens revoked after unbanning", async () => {
    await addToken(world.db, ALICE);
    await toggleUserBanAction(form(ALICE, true));
    const [before] = await tokenStates(world.sql, ALICE);

    await toggleUserBanAction(form(ALICE, false));

    expect((await userRow(ALICE)).banned).toBe(false);
    const [after] = await tokenStates(world.sql, ALICE);
    expect(after.revoked_at).toBe(before.revoked_at);
    expect(after.revoked_reason).toBe("user_banned");
    expect(await auditRows(world.sql, "orbit.user_unbanned")).toHaveLength(1);
    expect(await auditRows(world.sql, "mcp_token.revoked")).toHaveLength(1);
  });

  it("still refuses self-ban", async () => {
    await addToken(world.db, BOB);
    await toggleUserBanAction(form(BOB, true));
    expect((await userRow(BOB)).banned).toBe(false);
    expect(await liveTokenCount(world.sql, BOB)).toBe(1);
    expect(await auditRows(world.sql, "orbit.user_banned")).toHaveLength(0);
  });

  it("rolls the ban back when an audit write fails", async () => {
    await addToken(world.db, ALICE);
    auditOrThrowMock.mockRejectedValue(new Error("audit exploded"));

    await expect(toggleUserBanAction(form(ALICE, true))).rejects.toThrow(
      "audit exploded"
    );

    expect((await userRow(ALICE)).banned).toBe(false);
    expect(await liveTokenCount(world.sql, ALICE)).toBe(1);
  });
});

describe("signOutOtherSessionsAction", () => {
  async function seedSessions(userId: string) {
    const expires = new Date(Date.now() + 86_400_000);
    for (const [id, token] of [
      [`s-current-${userId}`, `tok-current-${userId}`],
      [`s-other-${userId}`, `tok-other-${userId}`],
    ]) {
      await world.sql`
        INSERT INTO session (id, user_id, token, expires_at)
        VALUES (${id}, ${userId}, ${token}, ${expires.toISOString()})`;
    }
  }

  beforeEach(() => {
    requireSession.mockResolvedValue({
      user: {
        id: ALICE,
        name: USERS.alice.name,
        email: USERS.alice.email,
        role: "agent",
      },
      session: { token: `tok-current-${ALICE}` },
    });
  });

  it("revokes every live token with sessions_signed_out and audits each", async () => {
    await seedSessions(ALICE);
    const t1 = await addToken(world.db, ALICE);
    const t2 = await addToken(world.db, ALICE);
    const old = await addToken(world.db, ALICE, {
      revokedAt: PAST,
      revokedReason: "revoked_by_user",
    });
    const others = await addToken(world.db, BOB);

    await signOutOtherSessionsAction();

    const sessions = await world.sql`
      SELECT id FROM session WHERE user_id = ${ALICE}`;
    expect(sessions.map((s) => s.id)).toEqual([`s-current-${ALICE}`]);

    const states = Object.fromEntries(
      (await tokenStates(world.sql, ALICE)).map((s) => [s.id, s])
    );
    expect(states[t1.id].revoked_reason).toBe("sessions_signed_out");
    expect(states[t2.id].revoked_reason).toBe("sessions_signed_out");
    expect(states[t1.id].revoked_at).not.toBeNull();
    expect(states[old.id].revoked_reason).toBe("revoked_by_user");
    expect(new Date(states[old.id].revoked_at as string).toISOString()).toBe(
      PAST.toISOString()
    );
    expect(await liveTokenCount(world.sql, BOB)).toBe(1);

    const audits = await auditRows(world.sql, "mcp_token.revoked");
    expect(audits.map((a) => a.entity_id).sort()).toEqual(
      [t1.id, t2.id].sort()
    );
    for (const a of audits) {
      expect(a.actor_id).toBe(ALICE);
      expect(a.actor_email).toBe(USERS.alice.email);
      expect(a.entity_type).toBe("mcp_token");
      expect(a.metadata).toMatchObject({ reason: "sessions_signed_out" });
    }
    expectNoSecrets(audits, [t1, t2, old, others]);

    const sessionAudits = await auditRows(
      world.sql,
      "profile.other_sessions_revoked"
    );
    expect(sessionAudits).toHaveLength(1);
    expect(sessionAudits[0].actor_id).toBe(ALICE);
    expect(sessionAudits[0].metadata).toMatchObject({
      revokedCount: 1,
      mcpTokensRevoked: 2,
    });
  });

  it("works when there are no tokens", async () => {
    await seedSessions(ALICE);
    await signOutOtherSessionsAction();
    expect(await auditRows(world.sql, "mcp_token.revoked")).toHaveLength(0);
    expect(
      await auditRows(world.sql, "profile.other_sessions_revoked")
    ).toHaveLength(1);
  });
});
