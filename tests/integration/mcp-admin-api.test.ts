import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The https rule is stubbed per test (default: the real implementation), so the
// 409 path can be exercised without changing the process environment.
const httpsRule = vi.hoisted(() => ({ override: null as boolean | null }));
vi.mock("@/lib/mcp/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/http")>();
  return {
    ...actual,
    isHttpsRequirementMet: (
      ...args: Parameters<typeof actual.isHttpsRequirementMet>
    ) => httpsRule.override ?? actual.isHttpsRequirementMet(...args),
  };
});

import {
  GET as getSettings,
  PATCH as patchSettings,
} from "@/app/api/admin/mcp/settings/route";
import { DELETE } from "@/app/api/admin/mcp/tokens/[id]/route";
import { GET as listTokens } from "@/app/api/admin/mcp/tokens/route";
import { callMcp } from "./mcp-endpoint-helpers";
import { addToken, auditRows, PAST, setupMcpWorld, USERS } from "./mcp-helpers";

const world = setupMcpWorld({ mcpEnabled: false });

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

const SETTINGS = "http://localhost:3000/api/admin/mcp/settings";
const TOKENS = "http://localhost:3000/api/admin/mcp/tokens";

function getS(headers: Record<string, string> = BOB_H) {
  return getSettings(new NextRequest(SETTINGS, { headers }));
}

function patchS(body: unknown, headers: Record<string, string> = BOB_H) {
  return patchSettings(
    new NextRequest(SETTINGS, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

function delT(id: string, headers: Record<string, string> = BOB_H) {
  return DELETE(
    new NextRequest(`${TOKENS}/${id}`, { method: "DELETE", headers }),
    { params: Promise.resolve({ id }) }
  );
}

async function enabledInDb() {
  const [row] = await world.sql`SELECT mcp_enabled FROM platform_settings`;
  return row?.mcp_enabled as boolean | undefined;
}

beforeEach(() => {
  httpsRule.override = null;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/admin/mcp/settings", () => {
  it("is off by default", async () => {
    const res = await getS();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false,
      httpsRequirementMet: true,
      mcpUrl: "http://localhost:3000/api/mcp",
    });
  });

  it("is off when there is no settings row", async () => {
    await world.sql`DELETE FROM platform_settings`;
    expect((await (await getS()).json()).enabled).toBe(false);
  });

  it("reports the https rule", async () => {
    httpsRule.override = false;
    expect((await (await getS()).json()).httpsRequirementMet).toBe(false);
  });

  it("is admin only", async () => {
    expect((await getS({})).status).toBe(403);
    expect((await getS(ALICE_H)).status).toBe(403);
  });
});

describe("PATCH /api/admin/mcp/settings", () => {
  it("enables MCP and writes one audit row with from/to", async () => {
    const res = await patchS({ enabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
    expect(await enabledInDb()).toBe(true);

    const rows = await auditRows(world.sql, "mcp.enabled_changed");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: BOB,
      actor_email: USERS.bob.email,
      entity_type: "platform_settings",
      entity_id: "default",
      metadata: { from: false, to: true },
    });
  });

  it("writes no further audit row when the value does not change", async () => {
    await patchS({ enabled: true });
    const again = await patchS({ enabled: true });
    expect(again.status).toBe(200);
    expect(await auditRows(world.sql, "mcp.enabled_changed")).toHaveLength(1);

    await patchS({ enabled: false });
    const rows = await auditRows(world.sql, "mcp.enabled_changed");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.metadata)).toContainEqual({
      from: true,
      to: false,
    });
    expect(await enabledInDb()).toBe(false);
  });

  it("creates the settings row when none exists", async () => {
    await world.sql`DELETE FROM platform_settings`;
    const res = await patchS({ enabled: true });
    expect(res.status).toBe(200);
    expect(await enabledInDb()).toBe(true);
    const [row] = await world.sql`
      SELECT id, password_login_enabled FROM platform_settings`;
    expect(row).toMatchObject({ id: "default", password_login_enabled: true });
  });

  it("does not disturb other settings", async () => {
    await world.sql`UPDATE platform_settings SET theme = 'ocean'`;
    await patchS({ enabled: true });
    const [row] = await world.sql`SELECT theme FROM platform_settings`;
    expect(row.theme).toBe("ocean");
  });

  it("rejects a bad body with 400", async () => {
    for (const body of [
      {},
      { enabled: "true" },
      { enabled: 1 },
      "{nope",
      "null",
      "[]",
    ]) {
      const res = await patchS(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await enabledInDb()).toBe(false);
    expect(await auditRows(world.sql, "mcp.enabled_changed")).toHaveLength(0);
  });

  it("refuses to enable without https in production, but allows disabling", async () => {
    httpsRule.override = false;
    const res = await patchS({ enabled: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        "MCP can only be enabled when NEXT_PUBLIC_APP_URL uses https:// in production.",
    });
    expect(await enabledInDb()).toBe(false);

    await world.sql`UPDATE platform_settings SET mcp_enabled = true`;
    const off = await patchS({ enabled: false });
    expect(off.status).toBe(200);
    expect(await enabledInDb()).toBe(false);
  });

  it("is admin only", async () => {
    expect((await patchS({ enabled: true }, {})).status).toBe(403);
    expect((await patchS({ enabled: true }, ALICE_H)).status).toBe(403);
    expect(await enabledInDb()).toBe(false);
  });
});

describe("GET /api/admin/mcp/tokens", () => {
  it("lists every user's tokens with the owner and without hashes", async () => {
    const a = await addToken(world.db, ALICE, {
      name: "alice token",
      createdAt: new Date("2026-03-01T00:00:00Z"),
    });
    const b = await addToken(world.db, BOB, {
      name: "bob token",
      expiresAt: PAST,
      createdAt: new Date("2026-03-02T00:00:00Z"),
    });

    const res = await listTokens(new NextRequest(TOKENS, { headers: BOB_H }));
    expect(res.status).toBe(200);
    const { tokens } = await res.json();
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatchObject({
      id: b.id,
      status: "expired",
      owner: {
        id: BOB,
        name: USERS.bob.name,
        email: USERS.bob.email,
        role: "admin",
      },
    });
    expect(tokens[1]).toMatchObject({
      id: a.id,
      status: "active",
      owner: { id: ALICE, role: "agent" },
    });
    const text = JSON.stringify(tokens);
    expect(text).not.toContain("keyHash");
    expect(text).not.toContain(a.hash);
    expect(text).not.toContain(b.hash);
  });

  it("is admin only", async () => {
    for (const headers of [{}, ALICE_H]) {
      const res = await listTokens(new NextRequest(TOKENS, { headers }));
      expect(res.status).toBe(403);
    }
  });
});

describe("DELETE /api/admin/mcp/tokens/[id]", () => {
  it("revokes another user's token, audits it, and the next MCP call is refused", async () => {
    await world.sql`UPDATE platform_settings SET mcp_enabled = true`;
    const token = await addToken(world.db, ALICE, { name: "alice token" });
    expect((await callMcp({ token: token.raw })).status).toBe(200);

    const res = await delT(token.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const [row] = await world.sql`
      SELECT revoked_at, revoked_reason FROM mcp_access_tokens WHERE id = ${token.id}`;
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_reason).toBe("revoked_by_admin");

    const rows = await auditRows(world.sql, "mcp_token.revoked");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: BOB,
      actor_email: USERS.bob.email,
      entity_type: "mcp_token",
      entity_id: token.id,
      metadata: {
        keyPrefix: token.raw.slice(0, 12),
        name: "alice token",
        reason: "revoked_by_admin",
        targetUserId: ALICE,
        targetEmail: USERS.alice.email,
      },
    });
    expect(JSON.stringify(rows[0])).not.toContain(token.raw);

    const next = await callMcp({ token: token.raw });
    expect(next.status).toBe(401);
    expect(await next.json()).toEqual({ error: "token revoked" });
  });

  it("answers 404 for a missing token", async () => {
    expect((await delT("no-such-token")).status).toBe(404);
  });

  it("is a no-op returning 200 for an already revoked token", async () => {
    const token = await addToken(world.db, ALICE, {
      revokedAt: PAST,
      revokedReason: "user_banned",
    });
    const before = await world.sql`
      SELECT revoked_at FROM mcp_access_tokens WHERE id = ${token.id}`;
    const res = await delT(token.id);
    expect(res.status).toBe(200);
    const [after] = await world.sql`
      SELECT revoked_at, revoked_reason FROM mcp_access_tokens WHERE id = ${token.id}`;
    expect(after.revoked_at).toBe(before[0].revoked_at);
    expect(after.revoked_reason).toBe("user_banned");
    expect(await auditRows(world.sql, "mcp_token.revoked")).toHaveLength(0);
  });

  it("is admin only", async () => {
    const token = await addToken(world.db, ALICE);
    expect((await delT(token.id, {})).status).toBe(403);
    expect((await delT(token.id, ALICE_H)).status).toBe(403);
    const [row] = await world.sql`
      SELECT revoked_at FROM mcp_access_tokens WHERE id = ${token.id}`;
    expect(row.revoked_at).toBeNull();
  });
});
