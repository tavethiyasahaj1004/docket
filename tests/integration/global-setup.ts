import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  assertLiveConnectionSafe,
  assertSafeTestUrl,
  openTestConnection,
  trace,
} from "./guard";

/**
 * Normal startup (path II-2). Never initializes: without the marker it throws
 * before any migration or destructive statement.
 */
export default async function setup() {
  // First statement: pins the time zone for this process (workers get TZ from
  // vitest.integration.config.ts test.env).
  process.env.TZ = "UTC";
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL is not set (there is no fallback).");
  }
  assertSafeTestUrl(url);

  const sql = openTestConnection(url);
  try {
    await assertLiveConnectionSafe(sql);
    trace("migrate");
    await migrate(drizzle(sql), {
      migrationsFolder: path.resolve(process.cwd(), "db/migrations"),
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
