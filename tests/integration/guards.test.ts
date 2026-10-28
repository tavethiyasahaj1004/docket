import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseTestDbUrl, TEST_DB_PORT } from "./guard";

/**
 * Guard acceptance cases (a)-(f), (d2), (d3). Every case runs the real setup
 * script or startup probe as a child process against CANARY databases on the
 * disposable instance only, then proves the canary row is untouched.
 */

const ROOT = process.cwd();
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
const SETUP_SCRIPT = "scripts/test-db-setup.ts";
const PROBE = "tests/integration/probe.ts";

const baseUrl = process.env.TEST_DATABASE_URL ?? "";
const parsed = parseTestDbUrl(baseUrl);
// The admin connection is built only after confirming the disposable instance.
if (parsed.port !== TEST_DB_PORT) {
  throw new Error("guards.test.ts must run against the disposable instance.");
}
const credentials = new URL(baseUrl);
const urlFor = (db: string, host = "127.0.0.1") =>
  `postgresql://${credentials.username}:${credentials.password}@${host}:${TEST_DB_PORT}/${db}`;

const CANARY_PLAIN = "docket_canary"; // no _test suffix
const CANARY_UNMARKED = "docket_canary_test"; // unmarked, holds canary table
const CANARY_EMPTY = "docket_canary_empty_test"; // empty, for happy paths
const CANARIES = [CANARY_PLAIN, CANARY_UNMARKED, CANARY_EMPTY];

const PASSTHROUGH = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "ComSpec",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
];

function childEnv(extra: Record<string, string | undefined>) {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function runNode(args: string[], extra: Record<string, string | undefined>) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: childEnv(extra) as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    status: result.status,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

const runSetup = (extra: Record<string, string | undefined>) =>
  runNode([TSX, SETUP_SCRIPT], extra);
const runProbe = (mode: string, extra: Record<string, string | undefined>) =>
  runNode([TSX, PROBE, mode], extra);

let admin: ReturnType<typeof postgres>;
let traceDir: string;
let traceCounter = 0;

function newTrace() {
  traceCounter += 1;
  return path.join(traceDir, `trace-${traceCounter}.log`);
}
function readTrace(file: string): string[] {
  return existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean)
    : [];
}

function dbClient(db: string) {
  return postgres(urlFor(db), { max: 1, onnotice: () => undefined });
}

async function dropCanary(name: string) {
  if (!name.startsWith("docket_canary")) {
    throw new Error(`refusing to drop non-canary database ${name}`);
  }
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

async function createCanary(name: string, withTable: boolean) {
  await dropCanary(name);
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  if (withTable) {
    const sql = dbClient(name);
    try {
      await sql`CREATE TABLE canary (v text)`;
      await sql`INSERT INTO canary (v) VALUES ('canary-intact')`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
}

async function expectCanaryIntact(name: string) {
  const sql = dbClient(name);
  try {
    const rows = await sql`SELECT v FROM canary`;
    expect(rows.map((r) => r.v)).toEqual(["canary-intact"]);
    const [{ tables }] = await sql`
      SELECT count(*)::int AS tables FROM pg_tables WHERE schemaname IN ('public','drizzle')`;
    return tables as number;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  traceDir = mkdtempSync(path.join(tmpdir(), "docket-guard-"));
  admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => undefined });
  await createCanary(CANARY_PLAIN, true);
  await createCanary(CANARY_UNMARKED, true);
  await createCanary(CANARY_EMPTY, false);
}, 60_000);

afterAll(async () => {
  for (const name of CANARIES) {
    await dropCanary(name);
  }
  await admin.end({ timeout: 5 });
  rmSync(traceDir, { recursive: true, force: true });
}, 60_000);

describe("guard acceptance cases", () => {
  it("(a) TEST_DATABASE_URL unset while DATABASE_URL points at the canary", async () => {
    const trace = newTrace();
    const env = {
      NODE_ENV: "test",
      DATABASE_URL: urlFor(CANARY_PLAIN),
      DOCKET_TEST_GUARD_TRACE: trace,
    };
    const setup = runSetup(env);
    expect(setup.status).not.toBe(0);
    expect(setup.out).toContain("TEST_DATABASE_URL is not set");
    const startup = runProbe("startup", env);
    expect(startup.status).not.toBe(0);
    expect(startup.out).toContain("TEST_DATABASE_URL is not set");
    // The integration vitest config throws while being evaluated (II-1).
    const config = runNode(
      [VITEST, "run", "--config", "vitest.integration.config.ts"],
      env
    );
    expect(config.status).not.toBe(0);
    expect(config.out).toContain("TEST_DATABASE_URL is not set");
    expect(readTrace(trace)).not.toContain("connect");
    expect(readTrace(trace)).toEqual([]);
    await expectCanaryIntact(CANARY_PLAIN);
  }, 120_000);

  it("(b) TEST_DATABASE_URL resolves to the same host/port/db as DATABASE_URL", async () => {
    for (const mode of ["setup", "startup"]) {
      const trace = newTrace();
      // Different password and `localhost` spelling must not get past guard 3.
      const env = {
        NODE_ENV: "test",
        TEST_DATABASE_URL: urlFor(CANARY_UNMARKED),
        DATABASE_URL: `postgresql://other:different@localhost:${TEST_DB_PORT}/${CANARY_UNMARKED}`,
        DOCKET_TEST_GUARD_TRACE: trace,
      };
      const res = mode === "setup" ? runSetup(env) : runProbe("startup", env);
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("Guard 3");
      expect(readTrace(trace)).toEqual([]);
    }
    await expectCanaryIntact(CANARY_UNMARKED);
  }, 120_000);

  it("(c) database name without _test is refused before connecting", async () => {
    for (const mode of ["setup", "startup"]) {
      const trace = newTrace();
      const env = {
        NODE_ENV: "test",
        TEST_DATABASE_URL: urlFor(CANARY_PLAIN),
        DOCKET_TEST_GUARD_TRACE: trace,
      };
      const res = mode === "setup" ? runSetup(env) : runProbe("startup", env);
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("Guard 1");
      expect(readTrace(trace)).not.toContain("connect");
    }
    await expectCanaryIntact(CANARY_PLAIN);
  }, 120_000);

  it("(d) startup against an unmarked _test database stops at the marker check", async () => {
    const trace = newTrace();
    const env = {
      NODE_ENV: "test",
      TEST_DATABASE_URL: urlFor(CANARY_UNMARKED),
      DOCKET_TEST_GUARD_TRACE: trace,
    };
    const startup = runProbe("startup", env);
    expect(startup.status).not.toBe(0);
    expect(startup.out).toContain("pnpm test:db:setup");
    expect(readTrace(trace)).toEqual(["url-guards", "connect", "marker-check"]);

    const resetTrace = newTrace();
    const reset = runProbe("reset", {
      ...env,
      DOCKET_TEST_GUARD_TRACE: resetTrace,
    });
    expect(reset.status).not.toBe(0);
    expect(reset.out).toContain("marker");
    const steps = readTrace(resetTrace);
    expect(steps).toContain("marker-check");
    expect(steps).not.toContain("truncate");
    expect(steps).not.toContain("migrate");

    const tables = await expectCanaryIntact(CANARY_UNMARKED);
    expect(tables).toBe(1); // nothing migrated
  }, 120_000);

  it("(d2) non-local host with a _test name is refused before connecting", async () => {
    for (const mode of ["setup", "startup"]) {
      const trace = newTrace();
      const env = {
        NODE_ENV: "test",
        TEST_DATABASE_URL: `postgresql://postgres:postgres@db.example.com:${TEST_DB_PORT}/${CANARY_UNMARKED}`,
        DOCKET_TEST_GUARD_TRACE: trace,
      };
      const res = mode === "setup" ? runSetup(env) : runProbe("startup", env);
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("Guard 2");
      expect(readTrace(trace)).toEqual([]);
    }
    await expectCanaryIntact(CANARY_UNMARKED);
  }, 120_000);

  it("(d3) setup against an unmarked, non-empty _test database is refused by guard 6", async () => {
    const trace = newTrace();
    const res = runSetup({
      NODE_ENV: "test",
      TEST_DATABASE_URL: urlFor(CANARY_UNMARKED),
      DOCKET_TEST_GUARD_TRACE: trace,
    });
    expect(res.status).not.toBe(0);
    expect(res.out).toContain("Guard 6");
    expect(readTrace(trace)).toEqual(["url-guards", "connect", "guard6"]);
    const tables = await expectCanaryIntact(CANARY_UNMARKED);
    expect(tables).toBe(1); // no migration, no marker table
  }, 120_000);

  it("(e) ordering: setup, normal startup, and resetTestDb", async () => {
    const env = {
      NODE_ENV: "test",
      TEST_DATABASE_URL: urlFor(CANARY_EMPTY),
    };

    const setupTrace = newTrace();
    const setup = runSetup({ ...env, DOCKET_TEST_GUARD_TRACE: setupTrace });
    expect(setup.out).toContain("Test database ready");
    expect(setup.status).toBe(0);
    expect(readTrace(setupTrace)).toEqual([
      "url-guards",
      "connect",
      "guard6",
      "migrate",
      "marker-create",
    ]);

    const startupTrace = newTrace();
    const startup = runProbe("startup", {
      ...env,
      DOCKET_TEST_GUARD_TRACE: startupTrace,
    });
    expect(startup.out).not.toContain("refused");
    expect(startup.status).toBe(0);
    expect(readTrace(startupTrace)).toEqual([
      "url-guards",
      "connect",
      "marker-check",
      "migrate",
    ]);

    const resetTrace = newTrace();
    const reset = runProbe("reset", {
      ...env,
      DOCKET_TEST_GUARD_TRACE: resetTrace,
    });
    expect(reset.out).not.toContain("refused");
    expect(reset.status).toBe(0);
    // The probe opens the connection directly (no URL-guard step).
    expect(readTrace(resetTrace)).toEqual([
      "connect",
      "marker-check",
      "truncate",
    ]);

    // The marker survives a reset and is never truncated.
    const sql = dbClient(CANARY_EMPTY);
    try {
      const rows = await sql`SELECT id FROM docket_test_guard`;
      expect(rows).toHaveLength(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 180_000);
});

describe("(f) no unsafe path", () => {
  const FORBIDDEN: [string, RegExp][] = [
    ["scripts/setup", /scripts\/setup/],
    ["pnpm setup", /pnpm setup/],
    ["db:migrate", /db:migrate/],
    ["drizzle-kit", /drizzle-kit/],
    ["loadEnvFile", /loadEnvFile/],
    // A reference to an env FILE; `process.env` / `test.env` do not match.
    [".env file", /(?<![\w$)\]])\.env\b/],
  ];

  function collect(dir: string, out: string[]) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        collect(full, out);
      } else {
        out.push(full);
      }
    }
  }

  it("integration and setup code never reaches the dev database path", () => {
    const files: string[] = [
      path.join(ROOT, "scripts", "test-db.ts"),
      path.join(ROOT, "scripts", "test-db-setup.ts"),
      path.join(ROOT, "vitest.integration.config.ts"),
    ];
    collect(path.join(ROOT, "tests", "integration"), files);
    const scanned = files.filter(
      (f) => path.basename(f) !== "guards.test.ts" && /\.(ts|mjs|js)$/.test(f)
    );
    expect(scanned.length).toBeGreaterThanOrEqual(6);
    const hits: string[] = [];
    for (const file of scanned) {
      const text = readFileSync(file, "utf8");
      for (const [label, pattern] of FORBIDDEN) {
        if (pattern.test(text)) {
          hits.push(`${path.relative(ROOT, file)}: ${label}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
