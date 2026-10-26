import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  assertSafeTestUrl,
  hasMarker,
  MARKER_ID,
  MARKER_TABLE,
  openTestConnection,
  trace,
} from "../tests/integration/guard";

/**
 * Explicit initialization of the disposable integration-test database.
 * The only code path allowed to migrate a database that has no marker.
 */
async function main() {
  // I-1: read only TEST_DATABASE_URL; unset exits before any connection.
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL is not set (there is no fallback).");
  }
  // I-2: guards 1, 2, 3, 5 on the parsed URL, before connecting.
  assertSafeTestUrl(url);

  // I-3: connect, then guard 6.
  const sql = openTestConnection(url);
  try {
    trace("guard6");
    if (await hasMarker(sql)) {
      console.log("Marker present: already initialized, applying migrations.");
    } else {
      const [{ count }] = await sql`
        SELECT count(*)::int AS count FROM pg_tables
        WHERE schemaname IN ('public', 'drizzle')`;
      if (count > 0) {
        throw new Error(
          `Guard 6: database has ${count} table(s) but no ${MARKER_TABLE} marker. Refusing to initialize a non-empty database.`
        );
      }
    }

    // I-4: programmatic migrator on the same validated connection.
    trace("migrate");
    await migrate(drizzle(sql), {
      migrationsFolder: path.resolve(process.cwd(), "db/migrations"),
    });

    // I-5: marker last.
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS public.${MARKER_TABLE} (id text PRIMARY KEY, created_at timestamptz DEFAULT now())`
    );
    await sql.unsafe(
      `INSERT INTO public.${MARKER_TABLE} (id) VALUES ('${MARKER_ID}') ON CONFLICT DO NOTHING`
    );
    trace("marker-create");

    const [{ tables }] = await sql`
      SELECT count(*)::int AS tables FROM pg_tables WHERE schemaname = 'public'`;
    console.log(`Test database ready. ${tables} tables in schema public.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(
    `test:db:setup refused/failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
