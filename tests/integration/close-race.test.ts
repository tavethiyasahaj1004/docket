import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emailOutbox,
  ticketActivity,
  tickets,
  webhookDeliveries,
} from "@/db/schema";
import { db } from "@/lib/db";
import { tid } from "./fixtures";

// Makes the "already closed?" early check see an OPEN ticket the next `count`
// times it is called, i.e. a read that went stale before the UPDATE ran.
const staleReads = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/lib/auth", async () =>
  (await import("./characterization/write-helpers")).authModule()
);
vi.mock("@/lib/worker/enqueue", async () =>
  (await import("./characterization/write-helpers")).enqueueModule()
);
vi.mock("@/lib/realtime", async (importOriginal) =>
  (await import("./characterization/write-helpers")).realtimeModule(
    await importOriginal<Record<string, unknown>>()
  )
);
vi.mock("@/lib/push", async (importOriginal) =>
  (await import("./characterization/write-helpers")).pushModule(
    await importOriginal<Record<string, unknown>>()
  )
);
vi.mock("@/lib/api-auth", () => ({
  requireApiKey: () => Promise.resolve({ id: "key-race", name: "Race key" }),
}));
vi.mock("@/lib/ticket-config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ticket-config")>();
  return {
    ...original,
    isClosedStatusSlug: (slug: string) => {
      if (staleReads.count > 0) {
        staleReads.count--;
        return Promise.resolve(false);
      }
      return original.isClosedStatusSlug(slug);
    },
  };
});

import { PATCH as CLOSE } from "@/app/api/tickets/[id]/close/route";
import { PATCH as V1_STATUS } from "@/app/api/v1/tickets/[id]/status/route";
import {
  agentSession,
  callLog,
  ctx,
  getSession,
  resetMocks,
  seedWriteWorld,
} from "./characterization/write-helpers";

const TICKET = tid(101); // open, customer Ann (ann@example.test, token-101)
const ALREADY_CLOSED = {
  status: 400,
  body: { error: "Ticket is already closed." },
};

type Path = "agent" | "portal" | "v1";

/** One close request on `path`. The agent session is picked per request by a
 * header, so racing paths can use different callers. */
async function close(path: Path, id = TICKET) {
  let res: Response;
  if (path === "v1") {
    res = await V1_STATUS(
      new NextRequest(`http://localhost:3000/api/v1/tickets/${id}/status`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test",
        },
        body: JSON.stringify({ email: "ann@example.test", action: "close" }),
      }),
      ctx(id)
    );
  } else {
    res = await CLOSE(
      new NextRequest(`http://localhost:3000/api/tickets/${id}/close`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-test-role": path,
        },
        body: JSON.stringify(path === "portal" ? { token: "token-101" } : {}),
      }),
      ctx(id)
    );
  }
  return { status: res.status, body: (await res.json()) as unknown };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const emailJobs = () => callLog.filter((c) => c.job === "email.send");

/** What the ticket accumulated, after the fire-and-forget email had time. */
async function effects(id = TICKET) {
  await sleep(300);
  const activity = await db
    .select({ id: ticketActivity.id })
    .from(ticketActivity)
    .where(
      and(
        eq(ticketActivity.ticketId, id),
        eq(ticketActivity.action, "ticket_closed")
      )
    );
  const closedDeliveries = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.event, "ticket.closed"),
        eq(webhookDeliveries.entityId, id)
      )
    );
  const outbox = await db.select({ id: emailOutbox.id }).from(emailOutbox);
  return {
    activity: activity.length,
    deliveries: closedDeliveries.length,
    outbox: outbox.length,
    emailJobs: emailJobs().length,
  };
}

const ONE_OF_EACH = { activity: 1, deliveries: 1, outbox: 1, emailJobs: 1 };
const NONE = { activity: 0, deliveries: 0, outbox: 0, emailJobs: 0 };

beforeEach(async () => {
  resetMocks();
  staleReads.count = 0;
  getSession.mockImplementation((opts: { headers: Headers }) =>
    Promise.resolve(
      opts.headers.get("x-test-role") === "agent" ? agentSession : null
    )
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await seedWriteWorld();
  return () => {
    vi.restoreAllMocks();
  };
});

describe("conditional close: a stale 'already closed?' read writes nothing", () => {
  it.each([
    "agent",
    "portal",
    "v1",
  ] as const)("%s close: ticket closed in the DB but read as open -> already closed, no activity/email/webhook", async (path) => {
    const closedAt = new Date("2026-03-15T11:00:00.000Z");
    await db
      .update(tickets)
      .set({ status: "closed", closedAt, updatedAt: closedAt })
      .where(eq(tickets.id, TICKET));

    staleReads.count = 1;
    const res = await close(path);

    expect(staleReads.count).toBe(0); // the early check really saw "open"
    expect(res).toEqual(ALREADY_CLOSED);
    expect(await effects()).toEqual(NONE);
    // the loser did not touch the row the winner wrote
    const [row] = await db.select().from(tickets).where(eq(tickets.id, TICKET));
    expect(row.status).toBe("closed");
    expect(row.closedAt).toEqual(closedAt);
    expect(row.updatedAt).toEqual(closedAt);
  });
});

describe("conditional close: concurrent closes", () => {
  it.each([
    "agent",
    "portal",
    "v1",
  ] as const)("two concurrent %s closes -> one activity row, one email, one ticket.closed", async (path) => {
    const results = await Promise.all([close(path), close(path)]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(results.find((r) => r.status === 400)).toEqual(ALREADY_CLOSED);
    expect(await effects()).toEqual(ONE_OF_EACH);
  });

  it.each([
    ["agent", "portal"],
    ["agent", "v1"],
    ["portal", "v1"],
  ] as const)("%s vs %s racing -> one activity row, one email, one ticket.closed", async (a, b) => {
    const results = await Promise.all([close(a), close(b)]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(results.find((r) => r.status === 400)).toEqual(ALREADY_CLOSED);
    expect(await effects()).toEqual(ONE_OF_EACH);
  });
});
