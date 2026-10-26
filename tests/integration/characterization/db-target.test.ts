import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { seedDefaults } from "@/lib/seed-defaults";
import {
  DEFAULT_CATEGORIES,
  DEFAULT_PRIORITIES,
  DEFAULT_STATUSES,
} from "../fixtures";
import { reseed } from "./helpers";

/**
 * Proves the app code under test (everything that imports `@/lib/db`) talks to
 * the disposable instance, from inside a Vitest worker (verification item C19),
 * and that the explicit fixtures mirror lib/seed-defaults.ts.
 */
describe("test worker database target", () => {
  it("DATABASE_URL equals TEST_DATABASE_URL inside the worker", () => {
    expect(process.env.TEST_DATABASE_URL).toBeTruthy();
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
    expect(process.env.NODE_ENV).toBe("test");
  });

  it("the app's own db client reports the disposable instance (port 54330)", async () => {
    const rows = await db.execute<{
      port: string;
      db: string;
      addr: string;
    }>(
      sql`select inet_server_port()::text as port, current_database() as db, host(inet_server_addr()) as addr`
    );
    const [row] = rows as unknown as Array<{
      port: string;
      db: string;
      addr: string;
    }>;
    expect(Number(row.port)).toBe(54_330);
    expect(row.db).toBe("docket_test");
    expect(["127.0.0.1", "::1"]).toContain(row.addr);
  });
});

describe("fixtures mirror lib/seed-defaults.ts", () => {
  it("explicit default statuses/categories/priorities match seedDefaults() except ids and timestamps", async () => {
    await reseed(async () => {});
    await seedDefaults();

    const strip = <T extends Record<string, unknown>>(rows: T[]) =>
      rows
        .map(({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => rest)
        .sort((a, b) => String(a.slug).localeCompare(String(b.slug)));

    const statuses = await db.query.ticketStatuses.findMany();
    const categories = await db.query.ticketCategories.findMany();
    const priorities = await db.query.ticketPriorities.findMany();

    expect(strip(statuses)).toEqual(strip(DEFAULT_STATUSES));
    expect(strip(categories)).toEqual(strip(DEFAULT_CATEGORIES));
    expect(strip(priorities)).toEqual(strip(DEFAULT_PRIORITIES));
  });
});
