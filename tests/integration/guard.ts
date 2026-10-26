import { appendFileSync } from "node:fs";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "../../db/schema";

/**
 * Shared guards for the disposable integration-test database.
 *
 * Everything here is dependency-light and (for the URL guards) pure string
 * parsing: no DNS lookup, no network, no environment reads other than the two
 * values the guards exist to check (NODE_ENV and the ambient DATABASE_URL).
 */

export const TEST_DB_PORT = 54_330;
export const MARKER_TABLE = "docket_test_guard";
export const MARKER_ID = "docket-test-guard-v1";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const LOCAL_SERVER_ADDRESSES = new Set(["127.0.0.1", "::1"]);

export type Sql = ReturnType<typeof postgres>;

export type ParsedTestDbUrl = {
  host: string;
  port: number;
  database: string;
};

/** Append one line to $DOCKET_TEST_GUARD_TRACE (if set) so ordering is testable. */
export function trace(step: string): void {
  const file = process.env.DOCKET_TEST_GUARD_TRACE;
  if (file) {
    appendFileSync(file, `${step}\n`);
  }
}

/** Pure string parsing. Throws on anything that is not a plain postgres URL. */
export function parseTestDbUrl(raw: string): ParsedTestDbUrl {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("Test database URL is empty.");
  }
  if (raw.includes(",")) {
    throw new Error("Test database URL must name exactly one host.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Test database URL is not a valid URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Test database URL must use the postgres(ql):// scheme.");
  }
  if (url.search !== "" || url.hash !== "") {
    // postgres-js lets query parameters override host/port/database.
    throw new Error(
      "Test database URL must not carry query parameters or a fragment."
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (host === "") {
    throw new Error("Test database URL has no host.");
  }
  if (database === "" || database.includes("/")) {
    throw new Error("Test database URL has no (or an invalid) database name.");
  }
  const port = url.port === "" ? 5432 : Number(url.port);
  return { host, port, database };
}

function normalizeHost(host: string): string {
  return LOCAL_HOSTS.has(host) ? "local" : host;
}

function validateUrl(raw: string): ParsedTestDbUrl {
  const parsed = parseTestDbUrl(raw);

  // Guard 1: database name.
  if (!parsed.database.endsWith("_test")) {
    throw new Error(
      `Guard 1: database name "${parsed.database}" must end in "_test".`
    );
  }
  // Guard 2: host.
  if (!LOCAL_HOSTS.has(parsed.host)) {
    throw new Error(
      `Guard 2: host "${parsed.host}" is not local (allowed: ${[...LOCAL_HOSTS].join(", ")}).`
    );
  }
  // Fixed port of the disposable instance.
  if (parsed.port !== TEST_DB_PORT) {
    throw new Error(
      `Guard 2: port ${parsed.port} is not the disposable test port ${TEST_DB_PORT}.`
    );
  }
  // Guard 3: must differ from the ambient DATABASE_URL (parsed host/port/db,
  // so password or parameter order cannot slip past). Only an already
  // exported DATABASE_URL is compared; no file is ever read.
  const ambient = process.env.DATABASE_URL;
  if (ambient) {
    let other: ParsedTestDbUrl | null = null;
    try {
      other = parseTestDbUrl(ambient);
    } catch {
      other = null;
    }
    if (
      other &&
      normalizeHost(other.host) === normalizeHost(parsed.host) &&
      other.port === parsed.port &&
      other.database === parsed.database
    ) {
      throw new Error(
        "Guard 3: TEST_DATABASE_URL resolves to the same host, port and database as DATABASE_URL."
      );
    }
  }
  // Guard 5: mode.
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      `Guard 5: NODE_ENV must be "test" (got "${process.env.NODE_ENV ?? ""}").`
    );
  }
  return parsed;
}

/** Guards 1, 2, 3, 5 on the parsed URL. Never touches the network. */
export function assertSafeTestUrl(raw: string): ParsedTestDbUrl {
  const parsed = validateUrl(raw);
  trace("url-guards");
  return parsed;
}

/**
 * The only way the harness opens a connection: re-validates the URL, records
 * the `connect` step, and builds a client from that validated URL alone.
 */
export function openTestConnection(raw: string): Sql {
  validateUrl(raw);
  trace("connect");
  return postgres(raw, { max: 1, onnotice: () => undefined });
}

/** True when the marker table exists and holds its marker row. */
export async function hasMarker(sql: Sql): Promise<boolean> {
  const [reg] = await sql`SELECT to_regclass(${`public.${MARKER_TABLE}`}) AS t`;
  if (!reg?.t) {
    return false;
  }
  const rows = await sql.unsafe(
    `SELECT id FROM public.${MARKER_TABLE} WHERE id = '${MARKER_ID}'`
  );
  return rows.length === 1;
}

/** Live-connection check: database name, server port/address, marker row. */
export async function assertLiveConnectionSafe(sql: Sql): Promise<void> {
  trace("marker-check");
  const [info] = await sql`
    SELECT current_database() AS db,
           inet_server_port() AS port,
           host(inet_server_addr()) AS addr`;
  if (!String(info?.db).endsWith("_test")) {
    throw new Error(
      `Live guard: connected database "${info?.db}" does not end in "_test".`
    );
  }
  if (Number(info?.port) !== TEST_DB_PORT) {
    throw new Error(
      `Live guard: connected server port ${info?.port} is not ${TEST_DB_PORT}.`
    );
  }
  if (!LOCAL_SERVER_ADDRESSES.has(String(info?.addr))) {
    throw new Error(
      `Live guard: connected server address "${info?.addr}" is not local.`
    );
  }
  if (!(await hasMarker(sql))) {
    throw new Error(
      `Live guard: marker table "${MARKER_TABLE}" is missing or empty. Run pnpm test:db:setup.`
    );
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Qualified, quoted names of every app table in the Drizzle schema. */
export function appTableNames(): string[] {
  const names: string[] = [];
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) {
      const { name, schema: tableSchema } = getTableConfig(value);
      if (name === MARKER_TABLE) {
        continue;
      }
      names.push(`${quoteIdent(tableSchema ?? "public")}.${quoteIdent(name)}`);
    }
  }
  return [...new Set(names)];
}

/**
 * Truncate every app table. The live connection is re-checked immediately
 * before the TRUNCATE, so safety does not depend on hook or import order.
 */
export async function resetTestDb(sql: Sql): Promise<void> {
  await assertLiveConnectionSafe(sql);
  const tables = appTableNames();
  if (tables.length === 0) {
    throw new Error("resetTestDb: no app tables found in the Drizzle schema.");
  }
  trace("truncate");
  await sql.unsafe(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
}
