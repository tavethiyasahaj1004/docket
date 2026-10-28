import { afterAll, beforeAll, vi } from "vitest";
import { FIXED_NOW, makeDb, type TestDb } from "../fixtures";
import { openTestConnection, resetTestDb, type Sql } from "../guard";

/**
 * Opens the harness connection from inside a Vitest worker.
 *
 * guard.ts Guard 3 refuses a TEST_DATABASE_URL that equals the ambient
 * DATABASE_URL. Inside a worker that equality holds BY CONSTRUCTION:
 * vitest.integration.config.ts copies TEST_DATABASE_URL into DATABASE_URL so the
 * app code under test (lib/db.ts) hits the disposable database. So here we
 * assert exactly that, hide DATABASE_URL for the synchronous duration of the
 * openTestConnection() call, and restore it immediately. Guards 1, 2, 5 and the
 * live-connection checks in resetTestDb() still run unchanged.
 */
export function openWorkerTestConnection(url: string): Sql {
  const ambient = process.env.DATABASE_URL;
  if (ambient !== url) {
    throw new Error(
      "Worker DATABASE_URL must equal TEST_DATABASE_URL (set by vitest.integration.config.ts)."
    );
  }
  delete process.env.DATABASE_URL;
  try {
    return openTestConnection(url);
  } finally {
    process.env.DATABASE_URL = ambient;
  }
}

/**
 * Opens the guarded test connection, wipes + seeds the database once for the
 * file, and closes the connection afterwards. All writes go through the
 * harness connection (guard.ts); the app code under test reads through its own
 * `@/lib/db` client, which the integration config points at the same database.
 */
export function useSeededDatabase(seed: (db: TestDb) => Promise<void>) {
  let sql: Sql;
  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL is not set.");
    }
    sql = openWorkerTestConnection(url);
    await resetTestDb(sql);
    await seed(makeDb(sql));
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });
}

/** Re-seeds from scratch (for files whose datasets differ between tests). */
export async function reseed(seed: (db: TestDb) => Promise<void>) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL is not set.");
  }
  const sql = openWorkerTestConnection(url);
  try {
    await resetTestDb(sql);
    await seed(makeDb(sql));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Freezes ONLY Date (postgres-js timers keep working). */
export function freezeDate(at: Date = FIXED_NOW) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
}

export function unfreezeDate() {
  vi.useRealTimers();
}

/** Records a Response as {status, body}; body is parsed JSON when possible. */
export async function recordResponse(res: Response) {
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // leave as text
  }
  return { status: res.status, body };
}

/** Records either the response or whatever the handler threw. */
export async function recordOutcome(run: () => Promise<Response>) {
  try {
    return {
      kind: "response" as const,
      ...(await recordResponse(await run())),
    };
  } catch (error) {
    if (error instanceof Response) {
      return {
        kind: "thrown-response" as const,
        ...(await recordResponse(error)),
      };
    }
    const e = error as Error;
    return { kind: "threw" as const, name: e?.name, message: e?.message };
  }
}
