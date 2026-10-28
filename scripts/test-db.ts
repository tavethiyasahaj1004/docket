import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import postgres from "postgres";
import {
  assertSafeTestUrl,
  parseTestDbUrl,
  TEST_DB_PORT,
} from "../tests/integration/guard";

// This script is part of the test harness, so it runs in test mode.
(process.env as Record<string, string | undefined>).NODE_ENV ??= "test";

const DATA_DIR_NAME = ".docket-postgres-test";

// Reads ONLY TEST_DATABASE_URL; never falls back to any other variable.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "TEST_DATABASE_URL is not set. Example: postgresql://postgres:postgres@127.0.0.1:54330/docket_test"
  );
  process.exit(1);
}

let database = "";
try {
  assertSafeTestUrl(databaseUrl);
  database = parseTestDbUrl(databaseUrl).database;
} catch (error) {
  console.error(
    `Refusing to start: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
}

const url = new URL(databaseUrl);
const user = decodeURIComponent(url.username) || "postgres";
const password = decodeURIComponent(url.password) || "postgres";
const dataDir = path.resolve(process.cwd(), DATA_DIR_NAME);

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();

async function main() {
  const hasPid = existsSync(path.join(dataDir, "postmaster.pid"));
  if (await isListening(TEST_DB_PORT)) {
    console.error(
      hasPid
        ? `Port ${TEST_DB_PORT} is already serving ${dataDir}; it is already running.`
        : `Port ${TEST_DB_PORT} is already in use by something that is not this data directory (${dataDir} has no postmaster.pid). Refusing to start.`
    );
    process.exit(1);
  }

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    password,
    persistent: true,
    port: TEST_DB_PORT,
    user,
    // Pinned so results do not depend on the host OS: byte-order collation and
    // UTC session time zone behave identically on Windows, macOS and Linux CI.
    initdbFlags: ["--locale=C", "--encoding=UTF8"],
    postgresFlags: ["-c", "timezone=UTC"],
  });

  if (!existsSync(path.join(dataDir, "PG_VERSION"))) {
    console.log(`Initialising Postgres data directory at ${dataDir}`);
    await pg.initialise();
  }
  await pg.start();

  async function stop(signal: string) {
    console.log(`Received ${signal}; stopping Postgres`);
    await pg.stop();
    process.exit(0);
  }
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));

  // Verify we are talking to the instance we just started.
  const admin = postgres({
    host: "127.0.0.1",
    port: TEST_DB_PORT,
    database: "postgres",
    username: user,
    password,
    max: 1,
    onnotice: () => undefined,
  });
  try {
    const [{ port }] = await admin`SELECT current_setting('port') AS port`;
    const [{ data_directory: dataDirectory }] =
      await admin`SELECT current_setting('data_directory') AS data_directory`;
    if (
      Number(port) !== TEST_DB_PORT ||
      norm(dataDirectory) !== norm(dataDir)
    ) {
      console.error(
        `Isolation check failed: port=${port}, data_directory=${dataDirectory}`
      );
      await admin.end({ timeout: 5 });
      await pg.stop();
      process.exit(1);
    }
    console.log(`SHOW port: ${port}`);
    console.log(`SHOW data_directory: ${dataDirectory}`);

    const exists =
      await admin`SELECT 1 FROM pg_database WHERE datname = ${database}`;
    if (exists.length === 0) {
      await admin.unsafe(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
      console.log(`Created database '${database}'`);
    }
    const dbs = await admin`SELECT datname FROM pg_database ORDER BY datname`;
    console.log(`Databases: ${dbs.map((d) => d.datname).join(", ")}`);

    // The characterization snapshots assume byte-order collation and UTC.
    const [{ datcollate }] =
      await admin`SELECT datcollate FROM pg_database WHERE datname = ${database}`;
    const [{ TimeZone: timeZone }] = await admin`SHOW TimeZone`;
    console.log(`datcollate (${database}): ${datcollate}`);
    console.log(`SHOW TimeZone: ${timeZone}`);
    if (datcollate !== "C" || timeZone !== "UTC") {
      console.error(
        `Refusing to continue: expected datcollate=C and TimeZone=UTC, got datcollate=${datcollate}, TimeZone=${timeZone}. Stop Postgres, delete ${dataDir} and re-initialise the data dir (pnpm test:db:start creates it with --locale=C and timezone=UTC).`
      );
      await admin.end({ timeout: 5 });
      await pg.stop();
      process.exit(1);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  console.log(`Test Postgres ready at ${databaseUrl}`);
}

main().catch((error) => {
  console.error("Failed to start test Postgres:", error);
  process.exit(1);
});
