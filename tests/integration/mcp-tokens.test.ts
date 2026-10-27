import { describe, expect, it, vi } from "vitest";

// Passthrough of the real HTTP helpers, except that a test can make the https
// requirement report "not met" (env is parsed once, so it can't be stubbed).
const httpsRule = vi.hoisted(() => ({ met: true }));
vi.mock("@/lib/mcp/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/http")>();
  return {
    ...actual,
    isMcpServing: (settings: { mcpEnabled: boolean }) =>
      httpsRule.met && actual.isMcpServing(settings),
  };
});

import {
  createMcpToken,
  hashMcpToken,
  MCP_ISSUABLE_SCOPES,
  MCP_SCOPES,
  verifyMcpToken,
} from "@/lib/mcp-tokens";
import { freezeDate, unfreezeDate } from "./characterization/helpers";
import { FIXED_NOW } from "./fixtures";
import {
  addToken,
  addUser,
  auditRows,
  liveTokenCount,
  settlesWithin,
  setupMcpWorld,
  sleep,
  tokenStates,
  USERS,
} from "./mcp-helpers";

const world = setupMcpWorld();

const ALICE = USERS.alice.id; // agent
const BOB = USERS.bob.id; // admin
const CAROL = USERS.carol.id; // agent, banned (expired ban_expires)
const DAVE = USERS.dave.id; // role "user"
const ERIN = USERS.erin.id; // admin, banned

async function tokenRows(userId: string) {
  return await world.sql`
    SELECT * FROM mcp_access_tokens WHERE user_id = ${userId}`;
}

describe("createMcpToken", () => {
  it("creates a token with defaults and returns the raw token once", async () => {
    const before = Date.now();
    const result = await createMcpToken({
      userId: ALICE,
      name: "  Claude Desktop  ",
      impersonatedBy: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { token, rawToken } = result;

    expect(rawToken).toMatch(/^dkm_[a-z0-9]{48}$/);
    expect(token.name).toBe("Claude Desktop");
    expect(token.userId).toBe(ALICE);
    expect(token.scopes).toEqual(["tickets:read", "customers:read"]);
    expect(token.keyPrefix).toBe(rawToken.slice(0, 12));
    expect(token).not.toHaveProperty("keyHash");
    expect(token.revokedAt).toBeNull();

    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const expiry = token.expiresAt.getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + thirtyDays - 1000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + thirtyDays + 1000);

    const [row] = await tokenRows(ALICE);
    expect(row.key_hash).toBe(hashMcpToken(rawToken));
    expect(row.key_hash).not.toBe(rawToken);
    // The raw token appears nowhere in the stored row.
    expect(JSON.stringify(row)).not.toContain(rawToken);

    const verified = await verifyMcpToken(rawToken);
    expect(verified.ok).toBe(true);
  });

  it("writes an mcp_token.created audit row without the raw token or hash", async () => {
    const result = await createMcpToken({
      userId: ALICE,
      name: "Audit me",
      scopes: ["tickets:read"],
      expiresInDays: 7,
      impersonatedBy: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const rows = await auditRows(world.sql, "mcp_token.created");
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(ALICE);
    expect(rows[0].actor_email).toBe(USERS.alice.email);
    expect(rows[0].entity_type).toBe("mcp_token");
    expect(rows[0].entity_id).toBe(result.token.id);
    expect(rows[0].metadata).toMatchObject({
      keyPrefix: result.token.keyPrefix,
      name: "Audit me",
      scopes: ["tickets:read"],
    });
    const json = JSON.stringify(rows[0]);
    expect(json).not.toContain(result.rawToken);
    expect(json).not.toContain(hashMcpToken(result.rawToken));
  });

  it("refuses impersonated sessions and inserts nothing", async () => {
    const refused = await createMcpToken({
      userId: ALICE,
      name: "x",
      impersonatedBy: BOB,
    });
    expect(refused).toEqual({ ok: false, reason: "impersonated" });
    expect(await tokenRows(ALICE)).toHaveLength(0);

    const ordinary = await createMcpToken({
      userId: ALICE,
      name: "x",
      impersonatedBy: null,
    });
    expect(ordinary.ok).toBe(true);
    expect(await tokenRows(ALICE)).toHaveLength(1);
  });

  it("refuses when MCP is disabled", async () => {
    await world.sql`UPDATE platform_settings SET mcp_enabled = false`;
    const result = await createMcpToken({
      userId: ALICE,
      name: "x",
      impersonatedBy: null,
    });
    expect(result).toEqual({ ok: false, reason: "mcp_disabled" });
    expect(await tokenRows(ALICE)).toHaveLength(0);
  });

  it("refuses when the https requirement is not met, even if MCP is switched on", async () => {
    httpsRule.met = false;
    try {
      const result = await createMcpToken({
        userId: ALICE,
        name: "x",
        impersonatedBy: null,
      });
      expect(result).toEqual({ ok: false, reason: "mcp_disabled" });
      expect(await tokenRows(ALICE)).toHaveLength(0);
    } finally {
      httpsRule.met = true;
    }
  });

  it("validates the name", async () => {
    for (const name of ["", "   ", "x".repeat(101)]) {
      const result = await createMcpToken({
        userId: ALICE,
        name,
        impersonatedBy: null,
      });
      expect(result).toEqual({ ok: false, reason: "invalid_name" });
    }
    const max = await createMcpToken({
      userId: ALICE,
      name: "x".repeat(100),
      impersonatedBy: null,
    });
    expect(max.ok).toBe(true);
  });

  it("validates the scopes", async () => {
    for (const scopes of [
      [],
      ["tickets:delete"],
      ["tickets:read", "tickets:read"],
      "tickets:read",
      null,
      [1],
      { 0: "tickets:read" },
    ]) {
      const result = await createMcpToken({
        userId: ALICE,
        name: "x",
        scopes,
        impersonatedBy: null,
      });
      expect(result, JSON.stringify(scopes)).toEqual({
        ok: false,
        reason: "invalid_scopes",
      });
    }
    expect(await tokenRows(ALICE)).toHaveLength(0);
  });

  it("validates the expiry (1..90 whole days)", async () => {
    for (const expiresInDays of [0, -1, 91, 1.5, "30", null, Number.NaN]) {
      const result = await createMcpToken({
        userId: ALICE,
        name: "x",
        expiresInDays,
        impersonatedBy: null,
      });
      expect(result, String(expiresInDays)).toEqual({
        ok: false,
        reason: "invalid_expiry",
      });
    }
    for (const expiresInDays of [1, 90]) {
      const ok = await createMcpToken({
        userId: ALICE,
        name: "x",
        expiresInDays,
        impersonatedBy: null,
      });
      expect(ok.ok).toBe(true);
    }
  });

  it("caps scopes at the owner's role", async () => {
    const agent = await createMcpToken({
      userId: ALICE,
      name: "x",
      scopes: ["reports:read"],
      impersonatedBy: null,
    });
    expect(agent).toEqual({ ok: false, reason: "scope_not_allowed" });

    const admin = await createMcpToken({
      userId: BOB,
      name: "x",
      scopes: [...MCP_ISSUABLE_SCOPES],
      impersonatedBy: null,
    });
    expect(admin.ok).toBe(true);
  });

  it("refuses scopes that are not issuable yet, for agents and admins", async () => {
    for (const userId of [ALICE, BOB]) {
      for (const scopes of [
        ["tickets:write"],
        ["tickets:manage"],
        ["tickets:reply"],
        ["tickets:read", "tickets:write"],
        ["tickets:read_internal"],
        [...MCP_SCOPES],
      ]) {
        const result = await createMcpToken({
          userId,
          name: "x",
          scopes,
          impersonatedBy: null,
        });
        expect(result, `${userId} ${JSON.stringify(scopes)}`).toEqual({
          ok: false,
          reason: "scope_not_issuable",
        });
      }
      expect(await tokenRows(userId)).toHaveLength(0);
    }
  });

  it("issues exactly the requested read scopes", async () => {
    const cases: Array<[string, string[] | undefined, string[]]> = [
      [ALICE, ["tickets:read"], ["tickets:read"]],
      [ALICE, ["customers:read"], ["customers:read"]],
      [
        ALICE,
        ["tickets:read", "customers:read"],
        ["tickets:read", "customers:read"],
      ],
      [ALICE, undefined, ["tickets:read", "customers:read"]],
      [
        BOB,
        ["tickets:read", "customers:read", "reports:read"],
        ["tickets:read", "customers:read", "reports:read"],
      ],
    ];
    for (const [userId, scopes, expected] of cases) {
      const result = await createMcpToken({
        userId,
        name: "x",
        scopes,
        impersonatedBy: null,
      });
      expect(result.ok, JSON.stringify(scopes)).toBe(true);
      if (result.ok) {
        expect(result.token.scopes).toEqual(expected);
        const [row] = await world.sql`
          SELECT scopes FROM mcp_access_tokens WHERE id = ${result.token.id}`;
        expect(row.scopes).toEqual(expected);
      }
    }
  });

  it("refuses banned users, non-agent roles and unknown users", async () => {
    for (const userId of [CAROL, ERIN, DAVE, "no-such-user"]) {
      const result = await createMcpToken({
        userId,
        name: "x",
        impersonatedBy: null,
      });
      expect(result, userId).toEqual({ ok: false, reason: "not_permitted" });
      expect(await tokenRows(userId)).toHaveLength(0);
    }
  });
});

describe("createMcpToken versus concurrent bans", () => {
  it("(a) waits for an uncommitted ban, then refuses", async () => {
    const holder = world.open();
    try {
      await holder.unsafe("BEGIN");
      await holder`UPDATE "user" SET banned = true WHERE id = ${ALICE}`;

      const pending = createMcpToken({
        userId: ALICE,
        name: "racing",
        impersonatedBy: null,
      });
      expect(await settlesWithin(pending, 300)).toBe(false);

      await holder.unsafe("COMMIT");
      const result = await pending;
      expect(result).toEqual({ ok: false, reason: "not_permitted" });
      expect(await liveTokenCount(world.sql, ALICE)).toBe(0);
      expect(await tokenRows(ALICE)).toHaveLength(0);
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => undefined);
      await holder.end({ timeout: 5 });
    }
  }, 30_000);

  it("(b) a ban queued behind an in-flight token insert still revokes that token", async () => {
    const { db } = await import("@/lib/db");
    const { user } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const holder = world.open();
    try {
      await holder.unsafe("BEGIN");
      // What createMcpToken does: share-lock the owner, then insert.
      await holder`SELECT id FROM "user" WHERE id = ${ALICE} FOR SHARE`;
      await holder`
        INSERT INTO mcp_access_tokens
          (id, user_id, name, key_prefix, key_hash, scopes, expires_at)
        VALUES ('racing-token', ${ALICE}, 'racing', 'dkm_racing00', 'racing-hash',
                ARRAY['tickets:read'], now() + interval '1 day')`;

      const banPromise = (async () => {
        await db
          .update(user)
          .set({ banned: true, updatedAt: new Date() })
          .where(eq(user.id, ALICE));
      })();
      expect(await settlesWithin(banPromise, 300)).toBe(false);

      await holder.unsafe("COMMIT");
      await banPromise;

      const [token] = await tokenStates(world.sql, ALICE);
      expect(token.id).toBe("racing-token");
      expect(token.revoked_at).not.toBeNull();
      expect(token.revoked_reason).toBe("user_banned");
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => undefined);
      await holder.end({ timeout: 5 });
    }
  }, 30_000);
});

describe("verifyMcpToken", () => {
  it("returns not_permitted for a token inserted for a disqualified user, then revoked", async () => {
    // Inserts do not fire the user trigger, so only the on-use backstop sees these.
    for (const userId of [DAVE, ERIN]) {
      const t = await addToken(world.db, userId);
      const first = await verifyMcpToken(t.raw);
      expect(first.ok).toBe(false);
      if (!first.ok) {
        expect(first.reason).toBe("not_permitted");
        expect(first.prefix).toBe(t.raw.slice(0, 12));
      }
      const [state] = await tokenStates(world.sql, userId);
      expect(state.revoked_at).not.toBeNull();
      expect(state.revoked_reason).toBe("account_not_permitted");

      const second = await verifyMcpToken(t.raw);
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.reason).toBe("revoked");
      }
    }
  });

  it("rejects a token whose owner's ban has lapsed but whose banned flag is still set", async () => {
    // Set the user state first: inserting the token does not fire the user
    // trigger, so only the on-use backstop can catch it.
    await world.sql`
      UPDATE "user"
      SET banned = true, ban_expires = now() - interval '1 day'
      WHERE id = ${ALICE}`;
    const t = await addToken(world.db, ALICE);

    const first = await verifyMcpToken(t.raw);
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.reason).toBe("not_permitted");
      expect(first.prefix).toBe(t.raw.slice(0, 12));
    }
    const [state] = await tokenStates(world.sql, ALICE);
    expect(state.revoked_at).not.toBeNull();
    expect(state.revoked_reason).toBe("account_not_permitted");

    const second = await verifyMcpToken(t.raw);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("revoked");
    }
  });

  it("never revives a token when the ban is cleared, but a new token works", async () => {
    const old = await addToken(world.db, ALICE);
    await world.sql`UPDATE "user" SET banned = true WHERE id = ${ALICE}`;
    const [banned] = await tokenStates(world.sql, ALICE);
    expect(banned.revoked_at).not.toBeNull();
    expect(banned.revoked_reason).toBe("user_banned");

    await world.sql`
      UPDATE "user" SET banned = false, ban_expires = null WHERE id = ${ALICE}`;
    const [cleared] = await tokenStates(world.sql, ALICE);
    expect(cleared).toEqual(banned);

    const oldResult = await verifyMcpToken(old.raw);
    expect(oldResult.ok).toBe(false);
    if (!oldResult.ok) {
      expect(oldResult.reason).toBe("revoked");
    }
    const [afterVerify] = await tokenStates(world.sql, ALICE);
    expect(afterVerify).toEqual(banned);

    const fresh = await createMcpToken({
      userId: ALICE,
      name: "after unban",
      impersonatedBy: null,
    });
    expect(fresh.ok).toBe(true);
    if (fresh.ok) {
      const verified = await verifyMcpToken(fresh.rawToken);
      expect(verified.ok).toBe(true);
    }
  });

  it("does not revoke a token whose owner is merely eligible", async () => {
    const t = await addToken(world.db, ALICE);
    const result = await verifyMcpToken(t.raw);
    expect(result.ok).toBe(true);
    expect(await liveTokenCount(world.sql, ALICE)).toBe(1);
  });

  it("reports expired tokens without touching last_used_at", async () => {
    const past = await addToken(world.db, ALICE, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    const result = await verifyMcpToken(past.raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("expired");
    }

    freezeDate(FIXED_NOW);
    try {
      const exact = await addToken(world.db, ALICE, { expiresAt: FIXED_NOW });
      const atBoundary = await verifyMcpToken(exact.raw);
      expect(atBoundary.ok).toBe(false);
      if (!atBoundary.ok) {
        expect(atBoundary.reason).toBe("expired");
      }
    } finally {
      unfreezeDate();
    }

    await sleep(300);
    const rows = await tokenRows(ALICE);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.last_used_at).toBeNull();
      expect(row.revoked_at).toBeNull();
    }
  });

  it("rejects unknown tokens and wrong prefixes as invalid", async () => {
    await addToken(world.db, ALICE);
    for (const raw of [
      "dkm_doesnotexistdoesnotexistdoesnotexist",
      "dk_live_doesnotexist",
      "",
      "Bearer dkm_x",
    ]) {
      const result = await verifyMcpToken(raw);
      expect(result).toEqual({ ok: false, reason: "invalid", prefix: null });
    }
  });

  it("succeeds, records last_used_at and narrows scopes to the current role", async () => {
    const t = await addToken(world.db, BOB, {
      scopes: ["tickets:read", "reports:read"],
    });
    const asAdmin = await verifyMcpToken(t.raw);
    expect(asAdmin.ok).toBe(true);
    if (asAdmin.ok) {
      expect(asAdmin.scopes).toEqual(["tickets:read", "reports:read"]);
      expect(asAdmin.user).toEqual({
        id: BOB,
        name: USERS.bob.name,
        email: USERS.bob.email,
        role: "admin",
      });
      expect(asAdmin.token).not.toHaveProperty("keyHash");
    }

    await vi.waitFor(async () => {
      const [row] = await tokenRows(BOB);
      expect(row.last_used_at).not.toBeNull();
    });

    // Demotion to agent keeps the token (agent is eligible) but drops reports.
    await world.sql`UPDATE "user" SET role = 'agent' WHERE id = ${BOB}`;
    const asAgent = await verifyMcpToken(t.raw);
    expect(asAgent.ok).toBe(true);
    if (asAgent.ok) {
      expect(asAgent.scopes).toEqual(["tickets:read"]);
    }
  });

  it("works for a user created after the fact", async () => {
    const id = await addUser(world.db, { role: "admin" });
    const created = await createMcpToken({
      userId: id,
      name: "fresh",
      scopes: ["reports:read"],
      impersonatedBy: null,
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      const verified = await verifyMcpToken(created.rawToken);
      expect(verified.ok).toBe(true);
    }
  });
});
