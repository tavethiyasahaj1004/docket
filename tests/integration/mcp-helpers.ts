import { createId } from "@paralleldrive/cuid2";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { mcpAccessTokens, platformSettings, user } from "@/db/schema";
import { generateMcpToken } from "@/lib/mcp-tokens";
import { openWorkerTestConnection } from "./characterization/helpers";
import { makeDb, seedUsers, type TestDb, USERS } from "./fixtures";
import { resetTestDb, type Sql } from "./guard";

export { USERS };

export const PAST = new Date("2026-01-02T03:04:05.000Z");

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resolves true if `promise` settles within `ms`, false if it is still pending. */
export async function settlesWithin(
  promise: Promise<unknown>,
  ms: number
): Promise<boolean> {
  return await Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    sleep(ms).then(() => false),
  ]);
}

export type McpWorld = {
  readonly sql: Sql;
  readonly db: TestDb;
  /** Opens one more guarded connection (caller must end it). */
  open(): Sql;
};

/**
 * One guarded harness connection per file. Before every test the database is
 * wiped and re-seeded with the fixture users plus a platform_settings row with
 * MCP enabled, so tests never see each other's tokens or audit rows.
 */
export function setupMcpWorld(
  options: { mcpEnabled?: boolean } = {}
): McpWorld {
  const world = {} as { sql: Sql; db: TestDb };
  const url = () => {
    const value = process.env.TEST_DATABASE_URL;
    if (!value) {
      throw new Error("TEST_DATABASE_URL is not set.");
    }
    return value;
  };

  beforeAll(() => {
    world.sql = openWorkerTestConnection(url());
    world.db = makeDb(world.sql);
  });
  beforeEach(async () => {
    await resetTestDb(world.sql);
    await seedUsers(world.db);
    await world.db
      .insert(platformSettings)
      .values({ id: "default", mcpEnabled: options.mcpEnabled ?? true });
  });
  afterAll(async () => {
    await world.sql?.end({ timeout: 5 });
  });

  return {
    get sql() {
      return world.sql;
    },
    get db() {
      return world.db;
    },
    open: () => openWorkerTestConnection(url()),
  };
}

/** Adds an extra user (the fixtures only seed five). */
export async function addUser(
  db: TestDb,
  over: Partial<typeof user.$inferInsert> = {}
) {
  const id = over.id ?? `user-${createId()}`;
  await db.insert(user).values({
    id,
    name: `Name ${id}`,
    email: `${id}@example.test`,
    emailVerified: true,
    role: "agent",
    ...over,
  });
  return id;
}

/** Inserts a token row directly (no trigger fires on insert). */
export async function addToken(
  db: TestDb,
  userId: string,
  over: Partial<typeof mcpAccessTokens.$inferInsert> = {}
) {
  const generated = generateMcpToken();
  const id = over.id ?? createId();
  await db.insert(mcpAccessTokens).values({
    id,
    userId,
    name: "test token",
    keyPrefix: generated.prefix,
    keyHash: generated.hash,
    scopes: ["tickets:read", "customers:read"],
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    ...over,
  });
  return { id, raw: generated.raw, hash: generated.hash };
}

export type TokenState = {
  id: string;
  // Timestamps come back as text: the drizzle wrapper around the harness
  // connection switches the driver to string timestamps.
  revoked_at: string | null;
  revoked_reason: string | null;
};

export async function tokenStates(
  sql: Sql,
  userId: string
): Promise<TokenState[]> {
  const rows = await sql`
    SELECT id, revoked_at, revoked_reason
    FROM mcp_access_tokens
    WHERE user_id = ${userId}
    ORDER BY id`;
  return rows as unknown as TokenState[];
}

export async function liveTokenCount(sql: Sql, userId: string) {
  const [row] = await sql`
    SELECT count(*)::int AS n FROM mcp_access_tokens
    WHERE user_id = ${userId} AND revoked_at IS NULL`;
  return row.n as number;
}

export async function auditRows(sql: Sql, action: string) {
  const rows = await sql`
    SELECT actor_id, actor_email, action, entity_type, entity_id, description, metadata
    FROM audit_logs WHERE action = ${action} ORDER BY entity_id`;
  return rows as unknown as Array<{
    actor_id: string | null;
    actor_email: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    description: string;
    metadata: Record<string, unknown> | null;
  }>;
}
