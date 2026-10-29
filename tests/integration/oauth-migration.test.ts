import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  insertTickets,
  makeDb,
  seedCustomers,
  seedDefaultConfig,
  seedUsers,
  tid,
  WORLD_TICKETS,
} from "./fixtures";

// Proves the Release 4 migration applies on top of a database that is already at
// the previous migration and has live MCP data, and keeps that data and its
// triggers working. Uses its own throwaway database on the disposable server
// (never the shared test database).
const ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54330/postgres";
const SCRATCH_DB = "docket_phase8_migration_test";
const SCRATCH_URL = `postgresql://postgres:postgres@127.0.0.1:54330/${SCRATCH_DB}`;
const MIGRATIONS = path.resolve(process.cwd(), "db/migrations");
const OAUTH_MIGRATION_TAG = "0020_curvy_human_torch";

let sql: ReturnType<typeof postgres>;
let partialDir: string;

function partialFolder(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "docket-mig-"));
  mkdirSync(path.join(dir, "meta"));
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8")
  ) as { entries: { tag: string }[] };
  const kept = journal.entries.filter((e) => e.tag !== OAUTH_MIGRATION_TAG);
  // Only entries up to (not including) the OAuth migration.
  const cut = journal.entries.findIndex((e) => e.tag === OAUTH_MIGRATION_TAG);
  journal.entries = journal.entries.slice(0, cut);
  expect(kept.length).toBe(journal.entries.length);
  writeFileSync(
    path.join(dir, "meta/_journal.json"),
    JSON.stringify(journal, null, 2)
  );
  for (const entry of journal.entries) {
    cpSync(
      path.join(MIGRATIONS, `${entry.tag}.sql`),
      path.join(dir, `${entry.tag}.sql`)
    );
  }
  return dir;
}

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  await admin.end({ timeout: 5 });

  sql = postgres(SCRATCH_URL, { max: 1, onnotice: () => undefined });
  partialDir = partialFolder();
  await migrate(drizzle(sql), { migrationsFolder: partialDir });
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  if (partialDir) {
    rmSync(partialDir, { recursive: true, force: true });
  }
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.end({ timeout: 5 });
}, 60_000);

describe("0020 on a database already at 0019", () => {
  it("starts without the OAuth tables or the new column", async () => {
    const [t] = await sql`SELECT to_regclass('public.oauth_consent') AS t`;
    expect(t.t).toBeNull();
    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'mcp_pending_actions' AND column_name = 'oauth_consent_id'`;
    expect(cols).toHaveLength(0);
  });

  it("applies cleanly and keeps existing PAT and pending-action rows", async () => {
    const db = makeDb(sql);
    await seedDefaultConfig(db);
    await seedCustomers(db);
    await seedUsers(db);
    await insertTickets(db, WORLD_TICKETS);
    await sql`
      INSERT INTO mcp_access_tokens (id, user_id, name, key_prefix, key_hash, scopes, expires_at)
      VALUES ('pat-1', 'user-alice', 'laptop', 'dkm_aaaaaaaa', 'hash-1',
              ARRAY['tickets:read'], now() + interval '7 days'),
             ('pat-2', 'user-alice', 'second', 'dkm_bbbbbbbb', 'hash-2',
              ARRAY['tickets:read'], now() + interval '7 days')`;
    await sql`
      INSERT INTO mcp_pending_actions (id, kind, ticket_id, requested_by_id, credential_id, payload, status, expires_at)
      VALUES ('pa-1', 'close', ${tid(101)}, 'user-alice', 'pat-1', '{}'::jsonb, 'pending', now() + interval '1 day'),
             ('pa-2', 'close', ${tid(109)}, 'user-alice', 'pat-2', '{}'::jsonb, 'pending', now() + interval '1 day')`;

    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });

    const tokens =
      await sql`SELECT id, key_hash, revoked_at FROM mcp_access_tokens ORDER BY id`;
    expect(tokens.map((t) => [t.id, t.key_hash, t.revoked_at])).toEqual([
      ["pat-1", "hash-1", null],
      ["pat-2", "hash-2", null],
    ]);
    const actions = await sql`
      SELECT id, status, credential_id, oauth_consent_id FROM mcp_pending_actions ORDER BY id`;
    expect(
      actions.map((a) => [a.id, a.status, a.credential_id, a.oauth_consent_id])
    ).toEqual([
      ["pa-1", "pending", "pat-1", null],
      ["pa-2", "pending", "pat-2", null],
    ]);
  });

  it("creates the OAuth tables, the column, the CHECK and the triggers", async () => {
    for (const table of [
      "jwks",
      "oauth_client",
      "oauth_resource",
      "oauth_client_resource",
      "oauth_refresh_token",
      "oauth_access_token",
      "oauth_consent",
      "oauth_client_assertion",
    ]) {
      const [t] = await sql`SELECT to_regclass(${`public.${table}`}) AS t`;
      expect(t.t, table).not.toBeNull();
    }
    const [check] = await sql`
      SELECT conname FROM pg_constraint
      WHERE conname = 'mcp_pending_actions_one_credential_chk'`;
    expect(check).toBeDefined();
    const triggers = await sql`
      SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`;
    const names = triggers.map((t) => t.tgname);
    expect(names).toEqual(
      expect.arrayContaining([
        "mcp_access_tokens_revoke_on_user_update",
        "mcp_pending_actions_cancel_on_token_revoke",
        "mcp_pending_actions_cancel_on_consent_delete",
      ])
    );
  });

  it("keeps the 0018 token-revoke trigger working on the pre-existing rows", async () => {
    await sql`UPDATE mcp_access_tokens SET revoked_at = now() WHERE id = 'pat-1'`;
    const [a] =
      await sql`SELECT status, status_reason FROM mcp_pending_actions WHERE id = 'pa-1'`;
    expect(a).toMatchObject({
      status: "cancelled",
      status_reason: "token_revoked",
    });
    const [other] =
      await sql`SELECT status FROM mcp_pending_actions WHERE id = 'pa-2'`;
    expect(other.status).toBe("pending");
  });

  it("keeps the 0017 ban trigger revoking PATs and now also clears OAuth grants", async () => {
    await sql`
      INSERT INTO oauth_client (id, client_id, redirect_uris, name)
      VALUES ('c-1', 'client-1', ARRAY['https://a.test/cb'], 'App')`;
    await sql`
      INSERT INTO oauth_consent (id, client_id, user_id, scopes)
      VALUES ('consent-1', 'client-1', 'user-alice', ARRAY['tickets:read'])`;
    await sql`
      INSERT INTO mcp_pending_actions (id, kind, ticket_id, requested_by_id, oauth_consent_id, payload, status, expires_at)
      VALUES ('pa-3', 'close', ${tid(110)}, 'user-alice', 'consent-1', '{}'::jsonb, 'pending', now() + interval '1 day')`;

    await sql`UPDATE "user" SET banned = true WHERE id = 'user-alice'`;

    const [pat] =
      await sql`SELECT revoked_reason FROM mcp_access_tokens WHERE id = 'pat-2'`;
    expect(pat.revoked_reason).toBe("user_banned");
    const consents =
      await sql`SELECT id FROM oauth_consent WHERE user_id = 'user-alice'`;
    expect(consents).toHaveLength(0);
    const [action] =
      await sql`SELECT status, status_reason, oauth_consent_id FROM mcp_pending_actions WHERE id = 'pa-3'`;
    expect(action).toMatchObject({
      status: "cancelled",
      status_reason: "token_revoked",
      oauth_consent_id: null,
    });
  });

  it("is recorded as applied and is idempotent to re-run", async () => {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });
    const rows =
      await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    const journal = JSON.parse(
      readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8")
    ) as { entries: unknown[] };
    expect(rows[0].n).toBe(journal.entries.length);
  });
});
