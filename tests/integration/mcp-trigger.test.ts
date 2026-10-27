import { describe, expect, it } from "vitest";
import { verifyMcpToken } from "@/lib/mcp-tokens";
import {
  addToken,
  addUser,
  PAST,
  setupMcpWorld,
  tokenStates,
  USERS,
} from "./mcp-helpers";

const world = setupMcpWorld();

const ALICE = USERS.alice.id;
const BOB = USERS.bob.id;

describe("revocation trigger definition", () => {
  it("is an enabled, non-internal AFTER UPDATE row trigger on user", async () => {
    const rows = await world.sql`
      SELECT t.tgname, t.tgenabled, t.tgisinternal,
             pg_get_triggerdef(t.oid) AS def, c.relname
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE t.tgname = 'mcp_access_tokens_revoke_on_user_update'`;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.relname).toBe("user");
    expect(row.tgenabled).toBe("O");
    expect(row.tgisinternal).toBe(false);
    expect(row.def).toContain("AFTER UPDATE ON");
    expect(row.def).toContain("FOR EACH ROW");
    expect(row.def).toContain("WHEN");
    expect(row.def).toMatch(/new\.banned IS TRUE/i);
    expect(row.def).toMatch(/new\.role IS NULL/i);
    expect(row.def).toContain("mcp_revoke_tokens_for_ineligible_user");
  });

  it("has its function installed", async () => {
    const rows = await world.sql`
      SELECT proname FROM pg_proc
      WHERE proname = 'mcp_revoke_tokens_for_ineligible_user'`;
    expect(rows).toHaveLength(1);
  });
});

describe("disqualifying updates", () => {
  it("revokes all of a banned user's live tokens with user_banned", async () => {
    const a1 = await addToken(world.db, ALICE);
    const a2 = await addToken(world.db, ALICE);
    const b1 = await addToken(world.db, BOB);

    await world.sql`UPDATE "user" SET banned = true WHERE id = ${ALICE}`;

    const states = await tokenStates(world.sql, ALICE);
    expect(states.map((s) => s.id).sort()).toEqual([a1.id, a2.id].sort());
    for (const s of states) {
      expect(s.revoked_at).not.toBeNull();
      expect(s.revoked_reason).toBe("user_banned");
    }
    const [bob] = await tokenStates(world.sql, BOB);
    expect(bob.id).toBe(b1.id);
    expect(bob.revoked_at).toBeNull();
    expect(bob.revoked_reason).toBeNull();
  });

  it.each([
    ["user"],
    [""],
    ["viewer"],
    ["agent,admin"],
    ["Agent"],
    [" agent"],
  ])("revokes all tokens with role_changed when role becomes %j", async (role) => {
    await addToken(world.db, ALICE);
    await addToken(world.db, ALICE);
    await addToken(world.db, BOB);

    await world.sql`UPDATE "user" SET role = ${role} WHERE id = ${ALICE}`;

    const states = await tokenStates(world.sql, ALICE);
    expect(states).toHaveLength(2);
    for (const s of states) {
      expect(s.revoked_at).not.toBeNull();
      expect(s.revoked_reason).toBe("role_changed");
    }
    const [bob] = await tokenStates(world.sql, BOB);
    expect(bob.revoked_at).toBeNull();
  });

  it("reports user_banned when the update both bans and changes the role", async () => {
    await addToken(world.db, ALICE);
    await world.sql`UPDATE "user" SET banned = true, role = 'user' WHERE id = ${ALICE}`;
    const [s] = await tokenStates(world.sql, ALICE);
    expect(s.revoked_reason).toBe("user_banned");
  });

  it("keeps the original revoked_at/revoked_reason of already-revoked tokens", async () => {
    const old = await addToken(world.db, ALICE, {
      revokedAt: PAST,
      revokedReason: "revoked_by_user",
    });
    const live = await addToken(world.db, ALICE);

    await world.sql`UPDATE "user" SET banned = true WHERE id = ${ALICE}`;
    await world.sql`UPDATE "user" SET banned = false, role = 'user' WHERE id = ${ALICE}`;

    const states = Object.fromEntries(
      (await tokenStates(world.sql, ALICE)).map((s) => [s.id, s])
    );
    expect(new Date(states[old.id].revoked_at as string).toISOString()).toBe(
      PAST.toISOString()
    );
    expect(states[old.id].revoked_reason).toBe("revoked_by_user");
    // The live one was revoked by the first (ban) update and kept that reason.
    expect(states[live.id].revoked_reason).toBe("user_banned");
  });
});

describe("unrelated updates", () => {
  async function expectUntouched(userId: string, run: () => Promise<unknown>) {
    await addToken(world.db, userId);
    await run();
    const states = await tokenStates(world.sql, userId);
    expect(states).toHaveLength(1);
    expect(states[0].revoked_at).toBeNull();
    expect(states[0].revoked_reason).toBeNull();
  }

  it("ignores name changes", async () => {
    await expectUntouched(
      ALICE,
      () => world.sql`UPDATE "user" SET name = 'New Name' WHERE id = ${ALICE}`
    );
  });

  it("ignores email changes", async () => {
    await expectUntouched(
      ALICE,
      () =>
        world.sql`UPDATE "user" SET email = 'new@example.test' WHERE id = ${ALICE}`
    );
  });

  it("ignores email_verified changes", async () => {
    await expectUntouched(
      ALICE,
      () =>
        world.sql`UPDATE "user" SET email_verified = false WHERE id = ${ALICE}`
    );
  });

  it("ignores a ban_reason change while not banned", async () => {
    await expectUntouched(
      ALICE,
      () => world.sql`UPDATE "user" SET ban_reason = 'note' WHERE id = ${ALICE}`
    );
  });

  it("ignores agent to admin", async () => {
    await expectUntouched(
      ALICE,
      () => world.sql`UPDATE "user" SET role = 'admin' WHERE id = ${ALICE}`
    );
  });

  it("ignores admin to agent", async () => {
    await expectUntouched(
      BOB,
      () => world.sql`UPDATE "user" SET role = 'agent' WHERE id = ${BOB}`
    );
  });

  it("ignores unbanning an eligible user", async () => {
    const id = await addUser(world.db, { banned: true, role: "agent" });
    await expectUntouched(
      id,
      () => world.sql`UPDATE "user" SET banned = false WHERE id = ${id}`
    );
  });
});

describe("rollback", () => {
  it("leaves tokens untouched when a ban is rolled back", async () => {
    await addToken(world.db, ALICE);
    const other = world.open();
    try {
      await other.begin(async (tx) => {
        await tx`UPDATE "user" SET banned = true WHERE id = ${ALICE}`;
        const inside = await tx`
          SELECT revoked_at FROM mcp_access_tokens WHERE user_id = ${ALICE}`;
        expect(inside[0].revoked_at).not.toBeNull();
        throw new Error("rollback");
      });
    } catch (error) {
      expect((error as Error).message).toBe("rollback");
    } finally {
      await other.end({ timeout: 5 });
    }
    const [s] = await tokenStates(world.sql, ALICE);
    expect(s.revoked_at).toBeNull();
  });

  it("leaves tokens untouched when a role change is rolled back", async () => {
    await addToken(world.db, ALICE);
    const other = world.open();
    try {
      await other.begin(async (tx) => {
        await tx`UPDATE "user" SET role = 'user' WHERE id = ${ALICE}`;
        throw new Error("rollback");
      });
    } catch (error) {
      expect((error as Error).message).toBe("rollback");
    } finally {
      await other.end({ timeout: 5 });
    }
    const [s] = await tokenStates(world.sql, ALICE);
    expect(s.revoked_at).toBeNull();
  });
});

describe("permanence", () => {
  async function expectPermanentlyRevoked(userId: string, raw: string) {
    const [s] = await tokenStates(world.sql, userId);
    expect(s.revoked_at).not.toBeNull();
    const result = await verifyMcpToken(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("revoked");
    }
    return s;
  }

  it("stays revoked after ban then unban", async () => {
    const t = await addToken(world.db, ALICE);
    await world.sql`UPDATE "user" SET banned = true WHERE id = ${ALICE}`;
    const before = await expectPermanentlyRevoked(ALICE, t.raw);
    await world.sql`UPDATE "user" SET banned = false WHERE id = ${ALICE}`;
    const after = await expectPermanentlyRevoked(ALICE, t.raw);
    expect(after.revoked_at).toBe(before.revoked_at);
    expect(after.revoked_reason).toBe("user_banned");
  });

  it("stays revoked after demotion then restoring the role", async () => {
    const t = await addToken(world.db, ALICE);
    await world.sql`UPDATE "user" SET role = 'user' WHERE id = ${ALICE}`;
    await expectPermanentlyRevoked(ALICE, t.raw);
    await world.sql`UPDATE "user" SET role = 'agent' WHERE id = ${ALICE}`;
    const after = await expectPermanentlyRevoked(ALICE, t.raw);
    expect(after.revoked_reason).toBe("role_changed");
  });

  it("revokes at ban time for a timed ban and stays revoked after it lapses", async () => {
    const t = await addToken(world.db, ALICE);
    await world.sql`
      UPDATE "user"
      SET banned = true, ban_expires = now() + interval '1 day'
      WHERE id = ${ALICE}`;
    const before = await expectPermanentlyRevoked(ALICE, t.raw);
    expect(before.revoked_reason).toBe("user_banned");

    await world.sql`
      UPDATE "user" SET banned = false, ban_expires = NULL WHERE id = ${ALICE}`;
    const after = await expectPermanentlyRevoked(ALICE, t.raw);
    expect(after.revoked_at).toBe(before.revoked_at);
  });

  it("stays revoked when ban_expires is in the past but banned is still true", async () => {
    const t = await addToken(world.db, ALICE);
    await world.sql`
      UPDATE "user"
      SET banned = true, ban_expires = now() - interval '1 day'
      WHERE id = ${ALICE}`;
    const s = await expectPermanentlyRevoked(ALICE, t.raw);
    expect(s.revoked_reason).toBe("user_banned");
  });
});

describe("deletion", () => {
  it("deletes a user's tokens and nulls their tool-call user_id", async () => {
    const id = await addUser(world.db);
    const other = await addUser(world.db);
    await addToken(world.db, id);
    await addToken(world.db, other);
    await world.sql`
      INSERT INTO mcp_tool_calls (id, request_id, user_id, auth_method, tool, status)
      VALUES ('call-1', 'req-1', ${id}, 'token', 'search_tickets', 'succeeded'),
             ('call-2', 'req-2', ${other}, 'token', 'search_tickets', 'succeeded')`;

    await world.sql`DELETE FROM "user" WHERE id = ${id}`;

    expect(await tokenStates(world.sql, id)).toHaveLength(0);
    expect(await tokenStates(world.sql, other)).toHaveLength(1);
    const calls = await world.sql`
      SELECT id, user_id FROM mcp_tool_calls ORDER BY id`;
    expect(calls.map((c) => [c.id, c.user_id])).toEqual([
      ["call-1", null],
      ["call-2", other],
    ]);
  });
});
