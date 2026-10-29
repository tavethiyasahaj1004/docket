import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));

import { DELETE } from "@/app/api/account/mcp-tokens/[id]/route";
import { GET, POST } from "@/app/api/account/mcp-tokens/route";
import { hashMcpToken } from "@/lib/mcp-tokens";
import { addToken, auditRows, PAST, setupMcpWorld, USERS } from "./mcp-helpers";

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

const BASE = "http://localhost:3000/api/account/mcp-tokens";

function get(headers: Record<string, string> = ALICE_H) {
  return GET(new NextRequest(BASE, { headers }));
}

function post(body: unknown, headers: Record<string, string> = ALICE_H) {
  return POST(
    new NextRequest(BASE, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

function del(id: string, headers: Record<string, string> = ALICE_H) {
  return DELETE(
    new NextRequest(`${BASE}/${id}`, { method: "DELETE", headers }),
    { params: Promise.resolve({ id }) }
  );
}

async function tokenRow(id: string) {
  const [row] = await world.sql`
    SELECT id, user_id, scopes, key_hash, expires_at, revoked_at, revoked_reason
    FROM mcp_access_tokens WHERE id = ${id}`;
  return row;
}

// The real session belongs to whoever the proxy-injected identity header names.
const sessionFor = (userId: string | null, impersonatedBy: string | null) => ({
  session: { impersonatedBy },
  user: { id: userId },
});

beforeEach(() => {
  getSession.mockReset();
  getSession.mockImplementation(({ headers }: { headers: Headers }) =>
    Promise.resolve(sessionFor(headers.get("x-user-id"), null))
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/account/mcp-tokens", () => {
  it("creates a token with defaults and returns the raw token exactly once", async () => {
    const before = Date.now();
    const res = await post({ name: "  my laptop  " });
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.rawToken).toMatch(/^dkm_[a-z0-9]+$/);
    expect(body.mcpUrl).toBe("http://localhost:3000/api/mcp");
    expect(body.token).toMatchObject({
      userId: ALICE,
      name: "my laptop",
      scopes: ["tickets:read", "customers:read"],
      keyPrefix: body.rawToken.slice(0, 12),
      lastUsedAt: null,
      revokedAt: null,
    });
    expect("keyHash" in body.token).toBe(false);
    expect(JSON.stringify(body)).not.toContain(hashMcpToken(body.rawToken));

    // 30 days by default.
    const expires = new Date(body.token.expiresAt).getTime();
    expect(Math.abs(expires - (before + 30 * 86_400_000))).toBeLessThan(60_000);

    const row = await tokenRow(body.token.id);
    expect(row.key_hash).toBe(hashMcpToken(body.rawToken));

    // Later reads never expose the raw token or the hash.
    const list = JSON.stringify(await (await get()).json());
    expect(list).not.toContain(body.rawToken);
    expect(list).not.toContain(row.key_hash);
    expect(list).not.toContain("keyHash");
    expect(list).not.toContain("rawToken");
  });

  it("honours explicit scopes and expiry", async () => {
    const res = await post({
      name: "reader",
      scopes: ["tickets:read"],
      expiresInDays: 7,
    });
    expect(res.status).toBe(201);
    const { token } = await res.json();
    expect(token.scopes).toEqual(["tickets:read"]);
    const days =
      (new Date(token.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it("refuses tickets:read_internal", async () => {
    for (const scope of ["tickets:read_internal"]) {
      const res = await post({ name: "x", scopes: [scope] });
      expect(res.status, scope).toBe(400);
      expect(await res.json()).toEqual({
        error: "One of these scopes can't be issued right now.",
      });
    }
    const mixed = await post({
      name: "x",
      scopes: ["tickets:read", "tickets:read_internal"],
    });
    expect(mixed.status).toBe(400);
  });

  it("issues tickets:manage and tickets:reply only when asked for explicitly, to an agent and an admin", async () => {
    const plain = await post({ name: "default" });
    expect((await plain.json()).token.scopes).toEqual([
      "tickets:read",
      "customers:read",
    ]);

    for (const headers of [undefined, BOB_H]) {
      const res = await post(
        {
          name: "operator",
          scopes: ["tickets:read", "tickets:manage", "tickets:reply"],
        },
        headers
      );
      expect(res.status).toBe(201);
      expect((await res.json()).token.scopes).toEqual([
        "tickets:read",
        "tickets:manage",
        "tickets:reply",
      ]);
    }

    // The create form offers them, without pre-selecting them.
    const config = await (await get()).json();
    expect(config.issuableScopes).toEqual(
      expect.arrayContaining(["tickets:manage", "tickets:reply"])
    );
    expect(config.defaultScopes).toEqual(["tickets:read", "customers:read"]);
  });

  it("issues tickets:write only when it is asked for explicitly", async () => {
    // Not part of the defaults ...
    const plain = await post({ name: "default" });
    expect(plain.status).toBe(201);
    expect((await plain.json()).token.scopes).toEqual([
      "tickets:read",
      "customers:read",
    ]);

    // ... but an explicit request is honoured, for an agent and for an admin.
    for (const headers of [undefined, BOB_H]) {
      const res = await post(
        { name: "writer", scopes: ["tickets:read", "tickets:write"] },
        headers
      );
      expect(res.status).toBe(201);
      expect((await res.json()).token.scopes).toEqual([
        "tickets:read",
        "tickets:write",
      ]);
    }

    // The create form offers it, without pre-selecting it.
    const config = await (await get()).json();
    expect(config.issuableScopes).toContain("tickets:write");
    expect(config.defaultScopes).not.toContain("tickets:write");
  });

  it("refuses reports:read for an agent but allows it for an admin", async () => {
    const agent = await post({ name: "x", scopes: ["reports:read"] });
    expect(agent.status).toBe(400);
    expect(await agent.json()).toEqual({
      error: "Your role can't grant one of these scopes.",
    });

    const admin = await post({ name: "x", scopes: ["reports:read"] }, BOB_H);
    expect(admin.status).toBe(201);
    expect((await admin.json()).token.userId).toBe(BOB);
  });

  it("maps the other validation failures", async () => {
    const cases: [unknown, number, string][] = [
      [{ name: "" }, 400, "Name must be 1–100 characters."],
      [{ name: "x".repeat(101) }, 400, "Name must be 1–100 characters."],
      [{}, 400, "Name must be 1–100 characters."],
      [{ name: "x", scopes: ["bogus"] }, 400, "Invalid scopes."],
      [{ name: "x", scopes: [] }, 400, "Invalid scopes."],
      [
        { name: "x", expiresInDays: 0 },
        400,
        "Expiry must be a whole number of days from 1 to 90.",
      ],
      [
        { name: "x", expiresInDays: 91 },
        400,
        "Expiry must be a whole number of days from 1 to 90.",
      ],
      [
        { name: "x", expiresInDays: 1.5 },
        400,
        "Expiry must be a whole number of days from 1 to 90.",
      ],
      ["{nope", 400, "Invalid request body."],
      ["[]", 400, "Invalid request body."],
      ["null", 400, "Invalid request body."],
    ];
    for (const [body, status, message] of cases) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(await res.json()).toEqual({ error: message });
    }
    const [{ n }] =
      await world.sql`SELECT count(*)::int AS n FROM mcp_access_tokens`;
    expect(n).toBe(0);
  });

  it("refuses an impersonated session", async () => {
    getSession.mockResolvedValue(sessionFor(ALICE, BOB));
    const res = await post({ name: "x" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "MCP tokens can't be created while impersonating a user.",
    });
  });

  it("fails closed when there is no real session", async () => {
    getSession.mockResolvedValue(null);
    const res = await post({ name: "x" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    const [{ n }] =
      await world.sql`SELECT count(*)::int AS n FROM mcp_access_tokens`;
    expect(n).toBe(0);
  });

  it("refuses a session that belongs to a different user than the headers", async () => {
    getSession.mockResolvedValue(sessionFor(BOB, null));
    const res = await post({ name: "x" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    const [{ n }] =
      await world.sql`SELECT count(*)::int AS n FROM mcp_access_tokens`;
    expect(n).toBe(0);
  });

  it("refuses while MCP is disabled", async () => {
    await world.sql`UPDATE platform_settings SET mcp_enabled = false`;
    const res = await post({ name: "x" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "MCP is disabled on this server.",
    });
  });

  it("requires an agent or admin session", async () => {
    expect((await post({ name: "x" }, {})).status).toBe(401);
    expect((await post({ name: "x" }, DAVE_H)).status).toBe(403);
    // Header says agent but the database says otherwise.
    const sneaky = await post(
      { name: "x" },
      { ...DAVE_H, "x-user-role": "agent" }
    );
    expect(sneaky.status).toBe(403);
    expect(await sneaky.json()).toEqual({
      error: "Your account can't create MCP tokens.",
    });
  });

  it("audits the creation without the token", async () => {
    const res = await post({ name: "audited" });
    const { token, rawToken } = await res.json();
    const rows = await auditRows(world.sql, "mcp_token.created");
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_id).toBe(token.id);
    expect(JSON.stringify(rows[0])).not.toContain(rawToken);
  });
});

describe("GET /api/account/mcp-tokens", () => {
  it("lists only my tokens, newest first, with a derived status", async () => {
    const active = await addToken(world.db, ALICE, {
      name: "active",
      createdAt: new Date("2026-03-03T00:00:00Z"),
    });
    const expired = await addToken(world.db, ALICE, {
      name: "expired",
      expiresAt: PAST,
      createdAt: new Date("2026-03-02T00:00:00Z"),
    });
    const revoked = await addToken(world.db, ALICE, {
      name: "revoked",
      revokedAt: PAST,
      revokedReason: "revoked_by_user",
      createdAt: new Date("2026-03-01T00:00:00Z"),
    });
    await addToken(world.db, BOB, { name: "bobs" });

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(
      body.tokens.map((t: { id: string; status: string }) => [t.id, t.status])
    ).toEqual([
      [active.id, "active"],
      [expired.id, "expired"],
      [revoked.id, "revoked"],
    ]);
    expect(JSON.stringify(body)).not.toContain("keyHash");
    expect(JSON.stringify(body)).not.toContain(active.hash);
  });

  it("describes what the create form needs, per role", async () => {
    const agent = await (await get()).json();
    expect(agent).toMatchObject({
      mcpEnabled: true,
      mcpUrl: "http://localhost:3000/api/mcp",
      issuableScopes: [
        "tickets:read",
        "customers:read",
        "tickets:write",
        "tickets:manage",
        "tickets:reply",
      ],
      defaultScopes: ["tickets:read", "customers:read"],
      maxTtlDays: 90,
      defaultTtlDays: 30,
    });
    const admin = await (await get(BOB_H)).json();
    expect(admin.issuableScopes).toEqual([
      "tickets:read",
      "customers:read",
      "tickets:write",
      "tickets:manage",
      "tickets:reply",
      "reports:read",
    ]);
  });

  it("reports MCP as disabled when the admin switch is off", async () => {
    await world.sql`UPDATE platform_settings SET mcp_enabled = false`;
    expect((await (await get()).json()).mcpEnabled).toBe(false);
  });

  it("requires an agent or admin session", async () => {
    expect((await get({})).status).toBe(401);
    expect((await get(DAVE_H)).status).toBe(403);
  });
});

describe("DELETE /api/account/mcp-tokens/[id]", () => {
  it("revokes my own token and audits it", async () => {
    const token = await addToken(world.db, ALICE, { name: "mine" });
    const res = await del(token.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const row = await tokenRow(token.id);
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_reason).toBe("revoked_by_user");

    const rows = await auditRows(world.sql, "mcp_token.revoked");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: ALICE,
      actor_email: USERS.alice.email,
      entity_type: "mcp_token",
      entity_id: token.id,
      metadata: {
        keyPrefix: token.raw.slice(0, 12),
        name: "mine",
        reason: "revoked_by_user",
      },
    });
    expect(JSON.stringify(rows[0])).not.toContain(token.raw);
  });

  it("answers 404 for someone else's token and leaves it unchanged", async () => {
    const bobs = await addToken(world.db, BOB);
    const res = await del(bobs.id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Token not found." });
    expect((await tokenRow(bobs.id)).revoked_at).toBeNull();
    expect(await auditRows(world.sql, "mcp_token.revoked")).toHaveLength(0);
  });

  it("answers 404 for a token that does not exist", async () => {
    const res = await del("no-such-token");
    expect(res.status).toBe(404);
  });

  it("is a no-op returning 200 for an already revoked token", async () => {
    const token = await addToken(world.db, ALICE, {
      revokedAt: PAST,
      revokedReason: "user_banned",
    });
    const before = await tokenRow(token.id);
    const res = await del(token.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const after = await tokenRow(token.id);
    expect(after.revoked_at).toBe(before.revoked_at);
    expect(after.revoked_reason).toBe("user_banned");
    expect(await auditRows(world.sql, "mcp_token.revoked")).toHaveLength(0);
  });

  it("requires an agent or admin session", async () => {
    const token = await addToken(world.db, ALICE);
    expect((await del(token.id, {})).status).toBe(401);
    expect((await del(token.id, DAVE_H)).status).toBe(403);
    expect((await tokenRow(token.id)).revoked_at).toBeNull();
  });
});
