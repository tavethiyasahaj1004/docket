import setup from "./global-setup";
import { openTestConnection, resetTestDb } from "./guard";

/**
 * Child-process probe used by guards.test.ts.
 *   startup : runs the real globalSetup
 *   reset   : opens a connection and calls resetTestDb directly
 */
async function main() {
  const mode = process.argv[2];
  if (mode === "startup") {
    await setup();
    return;
  }
  if (mode === "reset") {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL is not set.");
    }
    const sql = openTestConnection(url);
    try {
      await resetTestDb(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
    return;
  }
  throw new Error(`unknown probe mode "${mode}"`);
}

main().catch((error) => {
  console.error(
    `probe refused/failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
