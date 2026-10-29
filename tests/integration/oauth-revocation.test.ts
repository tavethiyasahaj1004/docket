import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the session plumbing is mocked; the revocation code runs for real against
// the test database, with a real OAuth flow producing the grants.
const requireAdmin = vi.hoisted(() => vi.fn());
const requireSession = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authz")>();
  return { ...actual, requireAdmin, requireSession };
});

import { toggleUserBanAction } from "@/app/actions/orbit-users";
import { signOutOtherSessionsAction } from "@/app/actions/profile";
import { DELETE as accountRevoke } from "@/app/api/account/mcp/oauth-grants/[id]/route";
import { GET as accountList } from "@/app/api/account/mcp/oauth-grants/route";
import { DELETE as adminRevoke } from "@/app/api/admin/mcp/oauth/grants/[id]/route";
import { GET as adminList } from "@/app/api/admin/mcp/oauth/route";
import { PATCH as patchUser } from "@/app/api/users/[id]/route";
import { auditRows, setupMcpWorld, USERS } from "./mcp-helpers";
import { closeMcpClients } from "./mcp-read-helpers";
import {
  authFetch,
  consentRow,
  createClient,
  mcpStatus,
  runFlow,
  seedResource,
  signInAs,
  tokenRequest,
} from "./oauth-helpers";

const world = setupMcpWorld();

const ALICE = USERS.alice.id; // agent
const BOB = USERS.bob.id; // admin

const as = (u: { id: string; name: string; email: string }, role: string) => ({
  "x-user-id": u.id,
  "x-user-name": u.name,
  "x-user-email": u.email,
  "x-user-role": role,
});
const ALICE_H = as(USERS.alice, "agent");
const BOB_H = as(USERS.bob, "admin");
const DAVE_H = as(USERS.dave, "user");

const ADMIN_SESSION_USER = {
  id: BOB,
  name: USERS.bob.name,
  email: USERS.bob.email,
  role: "admin",
};

let adminCookie: string;
let aliceCookie: string;
let clientId: string;

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  requireAdmin.mockReset();
  requireAdmin.mockResolvedValue(ADMIN_SESSION_USER);
  requireSession.mockReset();
  revalidatePath.mockReset();
  await seedResource(world);
  adminCookie = await signInAs(world, BOB, USERS.bob.email);
  aliceCookie = await signInAs(world, ALICE, USERS.alice.email);
  clientId = await createClient(adminCookie);
});
afterEach(async () => {
  vi.useRealTimers();
  await closeMcpClients();
  vi.restoreAllMocks();
});

const BASE = "http://localhost:3000";

function listMine(headers: Record<string, string> = ALICE_H) {
  return accountList(
    new NextRequest(`${BASE}/api/account/mcp/oauth-grants`, { headers })
  );
}

function revokeMine(id: string, headers: Record<string, string> = ALICE_H) {
  return accountRevoke(
    new NextRequest(`${BASE}/api/account/mcp/oauth-grants/${id}`, {
      method: "DELETE",
      headers,
    }),
    { params: Promise.resolve({ id }) }
  );
}

function revokeAsAdmin(id: string, headers: Record<string, string> = BOB_H) {
  return adminRevoke(
    new NextRequest(`${BASE}/api/admin/mcp/oauth/grants/${id}`, {
      method: "DELETE",
      headers,
    }),
    { params: Promise.resolve({ id }) }
  );
}

function refresh(rt: string) {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: rt,
    client_id: clientId,
  });
}

async function counts(userId: string) {
  const [row] = await world.sql`
    SELECT
      (SELECT count(*)::int FROM oauth_consent WHERE user_id = ${userId}) AS consents,
      (SELECT count(*)::int FROM oauth_refresh_token WHERE user_id = ${userId}) AS refresh,
      (SELECT count(*)::int FROM oauth_access_token WHERE user_id = ${userId}) AS access`;
  return row as { consents: number; refresh: number; access: number };
}

/** A connected assistant for `cookie`'s user: tokens plus the grant id. */
async function connect(cookie: string, userId: string) {
  const flow = await runFlow({ cookie, clientId });
  const row = await consentRow(world, userId, clientId);
  return { flow, consentId: row.id as string };
}

describe("GET /api/account/mcp/oauth-grants", () => {
  it("lists only the caller's own grants, with no token material", async () => {
    const mine = await connect(aliceCookie, ALICE);
    await connect(adminCookie, BOB);

    const res = await listMine();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]).toMatchObject({
      id: mine.consentId,
      clientId,
      clientName: "Test Assistant",
    });
    expect([...body.grants[0].scopes].sort()).toEqual([
      "customers:read",
      "offline_access",
      "tickets:read",
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain(mine.flow.tokens.access_token);
    expect(text).not.toContain(mine.flow.tokens.refresh_token ?? "x-none");
  });

  it("requires an eligible signed-in user", async () => {
    expect((await listMine({})).status).toBe(401);
    expect((await listMine(DAVE_H)).status).toBe(403);
  });
});

describe("DELETE /api/account/mcp/oauth-grants/:id", () => {
  it("cuts access on the very next call and kills the refresh token", async () => {
    const { flow, consentId } = await connect(aliceCookie, ALICE);
    expect((await mcpStatus(flow.tokens.access_token)).status).toBe(200);

    const res = await revokeMine(consentId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const after = await mcpStatus(flow.tokens.access_token);
    expect(after.status).toBe(401);
    expect(after.www).toContain('error_description="token revoked"');
    expect((await refresh(flow.tokens.refresh_token ?? "")).status).toBe(400);
    expect(await counts(ALICE)).toEqual({ consents: 0, refresh: 0, access: 0 });

    const audits = await auditRows(world.sql, "mcp_oauth.grant_revoked");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_id: ALICE,
      actor_email: USERS.alice.email,
      entity_type: "mcp_oauth_grant",
      entity_id: consentId,
    });
    expect(audits[0].metadata).toMatchObject({
      clientId,
      clientName: "Test Assistant",
      targetUserId: ALICE,
      reason: "revoked_by_user",
    });
    expect(JSON.stringify(audits)).not.toContain(flow.tokens.access_token);
  });

  it("lets the user connect the same assistant again afterwards", async () => {
    const first = await connect(aliceCookie, ALICE);
    await revokeMine(first.consentId);
    // Grant and token times are whole seconds, and a token is only judged
    // against its grant to the second (see GRANT_CLOCK_SKEW_SECONDS), so a
    // human-speed revoke -> reconnect is modelled a few seconds later.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10_000);
    const again = await runFlow({ cookie: aliceCookie, clientId });
    vi.useRealTimers();
    expect((await mcpStatus(again.tokens.access_token)).status).toBe(200);
    // ...but not with the old token.
    expect((await mcpStatus(first.flow.tokens.access_token)).status).toBe(401);
  });

  it("answers 404 for someone else's grant and leaves it alone", async () => {
    const bobs = await connect(adminCookie, BOB);
    const res = await revokeMine(bobs.consentId);
    expect(res.status).toBe(404);
    expect((await mcpStatus(bobs.flow.tokens.access_token)).status).toBe(200);
    expect(await auditRows(world.sql, "mcp_oauth.grant_revoked")).toHaveLength(
      0
    );
  });

  it("answers 404 for an unknown id, 401 signed out, 403 for a plain user", async () => {
    expect((await revokeMine("nope")).status).toBe(404);
    expect((await revokeMine("nope", {})).status).toBe(401);
    expect((await revokeMine("nope", DAVE_H)).status).toBe(403);
  });

  it("revoking twice is a 404 the second time", async () => {
    const { consentId } = await connect(aliceCookie, ALICE);
    expect((await revokeMine(consentId)).status).toBe(200);
    expect((await revokeMine(consentId)).status).toBe(404);
  });
});

describe("admin: /api/admin/mcp/oauth", () => {
  it("lists every client and every grant with its owner", async () => {
    await connect(aliceCookie, ALICE);
    await connect(adminCookie, BOB);
    const res = await adminList(
      new NextRequest(`${BASE}/api/admin/mcp/oauth`, { headers: BOB_H })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clients).toEqual([
      expect.objectContaining({
        clientId,
        name: "Test Assistant",
        disabled: false,
        grantCount: 2,
      }),
    ]);
    expect(
      body.grants.map((g: { owner: { id: string } }) => g.owner.id).sort()
    ).toEqual([ALICE, BOB].sort());
  });

  it("is admin only", async () => {
    for (const headers of [ALICE_H, {}]) {
      const res = await adminList(
        new NextRequest(`${BASE}/api/admin/mcp/oauth`, { headers })
      );
      expect([401, 403]).toContain(res.status);
    }
  });

  it("revokes any user's grant with the admin as the audited actor", async () => {
    const { flow, consentId } = await connect(aliceCookie, ALICE);
    const res = await revokeAsAdmin(consentId);
    expect(res.status).toBe(200);
    expect((await mcpStatus(flow.tokens.access_token)).status).toBe(401);
    expect((await refresh(flow.tokens.refresh_token ?? "")).status).toBe(400);
    const [audit] = await auditRows(world.sql, "mcp_oauth.grant_revoked");
    expect(audit).toMatchObject({ actor_id: BOB, entity_id: consentId });
    expect(audit.metadata).toMatchObject({
      reason: "revoked_by_admin",
      targetUserId: ALICE,
    });
  });

  it("refuses a non-admin and answers 404 for an unknown grant", async () => {
    const { consentId } = await connect(aliceCookie, ALICE);
    const forbidden = await revokeAsAdmin(consentId, ALICE_H);
    expect([401, 403]).toContain(forbidden.status);
    expect(await consentRow(world, ALICE, clientId)).toBeDefined();
    expect((await revokeAsAdmin("nope")).status).toBe(404);
  });
});

describe("the account stops being eligible", () => {
  function form(userId: string, banned: boolean) {
    const data = new FormData();
    data.set("userId", userId);
    data.set("banned", String(banned));
    return data;
  }

  it("toggleUserBanAction revokes grants with the admin as actor", async () => {
    const { flow } = await connect(aliceCookie, ALICE);
    await toggleUserBanAction(form(ALICE, true));

    expect(await counts(ALICE)).toEqual({ consents: 0, refresh: 0, access: 0 });
    const status = await mcpStatus(flow.tokens.access_token);
    expect(status.status).toBe(401);
    expect((await refresh(flow.tokens.refresh_token ?? "")).status).toBe(400);
    const [audit] = await auditRows(world.sql, "mcp_oauth.grant_revoked");
    expect(audit).toMatchObject({ actor_id: BOB });
    expect(audit.metadata).toMatchObject({
      reason: "user_banned",
      targetUserId: ALICE,
    });
  });

  it("PATCH /api/users/:id ban revokes grants with the admin as actor", async () => {
    const { flow } = await connect(aliceCookie, ALICE);
    const res = await patchUser(
      new NextRequest(`${BASE}/api/users/${ALICE}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...BOB_H },
        body: JSON.stringify({ banned: true, banReason: "left" }),
      }),
      { params: Promise.resolve({ id: ALICE }) }
    );
    expect(res.status).toBe(200);
    expect(await counts(ALICE)).toEqual({ consents: 0, refresh: 0, access: 0 });
    expect((await mcpStatus(flow.tokens.access_token)).status).toBe(401);
    const [audit] = await auditRows(world.sql, "mcp_oauth.grant_revoked");
    expect(audit).toMatchObject({ actor_id: BOB });
  });

  it("unbanning does not bring the grant back", async () => {
    const { flow } = await connect(aliceCookie, ALICE);
    await toggleUserBanAction(form(ALICE, true));
    await toggleUserBanAction(form(ALICE, false));
    const status = await mcpStatus(flow.tokens.access_token);
    expect(status.status).toBe(401);
    expect(status.www).toContain('error_description="token revoked"');
  });

  it("a ban by any other path (direct SQL) is caught by the database trigger", async () => {
    const { flow } = await connect(aliceCookie, ALICE);
    await world.sql`UPDATE "user" SET banned = true WHERE id = ${ALICE}`;
    expect(await counts(ALICE)).toEqual({ consents: 0, refresh: 0, access: 0 });
    expect((await refresh(flow.tokens.refresh_token ?? "")).status).toBe(400);
    expect((await mcpStatus(flow.tokens.access_token)).status).toBe(401);
  });

  it.each([
    ["user"],
    [""],
    ["agent,admin"],
    ["Agent"],
  ])("a role change to %j deletes the grants (trigger)", async (role) => {
    const { flow } = await connect(aliceCookie, ALICE);
    await world.sql`UPDATE "user" SET role = ${role} WHERE id = ${ALICE}`;
    expect(await counts(ALICE)).toEqual({ consents: 0, refresh: 0, access: 0 });
    const status = await mcpStatus(flow.tokens.access_token);
    expect(status.status).toBe(401);
    expect(status.www).toContain('error_description="account not permitted"');
    // Promoting back does not resurrect anything.
    await world.sql`UPDATE "user" SET role = 'agent' WHERE id = ${ALICE}`;
    expect((await mcpStatus(flow.tokens.access_token)).status).toBe(401);
    expect((await refresh(flow.tokens.refresh_token ?? "")).status).toBe(400);
  });

  it("a role change between agent and admin keeps the grant", async () => {
    const { flow } = await connect(aliceCookie, ALICE);
    await world.sql`UPDATE "user" SET role = 'admin' WHERE id = ${ALICE}`;
    expect((await mcpStatus(flow.tokens.access_token)).status).toBe(200);
  });

  it("leaves other users' grants untouched", async () => {
    await connect(aliceCookie, ALICE);
    const bobs = await connect(adminCookie, BOB);
    await toggleUserBanAction(form(ALICE, true));
    expect((await mcpStatus(bobs.flow.tokens.access_token)).status).toBe(200);
    expect((await counts(BOB)).consents).toBe(1);
  });

  it("deleting the user removes the grants with them", async () => {
    await connect(aliceCookie, ALICE);
    await world.sql`DELETE FROM "user" WHERE id = ${ALICE}`;
    expect(await counts(ALICE)).toEqual({ consents: 0, refresh: 0, access: 0 });
  });
});

describe("signOutOtherSessionsAction", () => {
  it("revokes the user's OAuth grants along with their PATs", async () => {
    const { flow } = await connect(aliceCookie, ALICE);
    const expires = new Date(Date.now() + 86_400_000);
    await world.sql`
      INSERT INTO session (id, user_id, token, expires_at)
      VALUES ('s-other', ${ALICE}, 'tok-other', ${expires.toISOString()})`;
    requireSession.mockResolvedValue({
      user: { id: ALICE, email: USERS.alice.email, name: USERS.alice.name },
      session: { token: "tok-current" },
    });

    await signOutOtherSessionsAction();

    expect(await counts(ALICE)).toEqual({ consents: 0, refresh: 0, access: 0 });
    const status = await mcpStatus(flow.tokens.access_token);
    expect(status.status).toBe(401);
    expect((await refresh(flow.tokens.refresh_token ?? "")).status).toBe(400);
    const [audit] = await auditRows(world.sql, "mcp_oauth.grant_revoked");
    expect(audit).toMatchObject({ actor_id: ALICE });
    expect(audit.metadata).toMatchObject({ reason: "sessions_signed_out" });
    const [summary] = await auditRows(
      world.sql,
      "profile.other_sessions_revoked"
    );
    expect(summary.metadata).toMatchObject({ oauthGrantsRevoked: 1 });
  });
});

describe("signing the browser out does not end an assistant's grant", () => {
  it("keeps the grant when only the browser session ends", async () => {
    const { flow } = await connect(aliceCookie, ALICE);
    const out = await authFetch("/sign-out", { cookie: aliceCookie, json: {} });
    expect(out.ok).toBe(true);
    expect((await mcpStatus(flow.tokens.access_token)).status).toBe(200);
  });
});
