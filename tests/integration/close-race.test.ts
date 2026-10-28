import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emailOutbox,
  ticketActivity,
  ticketStatuses,
  tickets,
  webhookDeliveries,
} from "@/db/schema";
import { db } from "@/lib/db";
import { tid } from "./fixtures";

// Makes the "already closed?" early check see an OPEN ticket the next `count`
// times it is called, i.e. a read that went stale before the UPDATE ran.
const staleReads = vi.hoisted(() => ({ count: 0 }));
// Makes the generic PATCH load a ticket snapshot taken BEFORE a concurrent
// close (the snapshot every status change in that request is based on).
const staleSnapshot = vi.hoisted(() => ({ snapshot: null as unknown }));

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
vi.mock("@/lib/tickets/services/ticket-fields", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/lib/tickets/services/ticket-fields")
    >();
  return {
    ...original,
    loadTicketForChange: (id: string) => {
      const stale = staleSnapshot.snapshot;
      if (stale) {
        staleSnapshot.snapshot = null;
        return Promise.resolve(stale);
      }
      return original.loadTicketForChange(id);
    },
  };
});
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
import { PATCH as GENERIC_PATCH } from "@/app/api/tickets/[id]/route";
import { PATCH as V1_STATUS } from "@/app/api/v1/tickets/[id]/status/route";
import {
  changeTicketStatusGeneric,
  loadTicketForChange,
} from "@/lib/tickets/services/ticket-fields";
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
  staleSnapshot.snapshot = null;
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

/* ------------------------------------------------ generic status PATCH (W10) */

/** The generic status PATCH (the sidebar status menu), as an agent. */
async function patchStatus(status: string, id = TICKET) {
  const res = await GENERIC_PATCH(
    new NextRequest(`http://localhost:3000/api/tickets/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-role": "agent" },
      body: JSON.stringify({ status }),
    }),
    ctx(id)
  );
  return { status: res.status, body: (await res.json()) as unknown };
}

async function deliveredEvents(id = TICKET) {
  await sleep(300);
  const rows = await db
    .select({ event: webhookDeliveries.event })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.entityId, id));
  return rows.map((r) => r.event).sort();
}

const closedActivityRows = async (id = TICKET) =>
  (
    await db
      .select({ id: ticketActivity.id })
      .from(ticketActivity)
      .where(
        and(
          eq(ticketActivity.ticketId, id),
          eq(ticketActivity.action, "ticket_closed")
        )
      )
  ).length;

const changedFlag = (r: { body: unknown }) =>
  (r.body as { changed: boolean }).changed;

describe("conditional generic close: a non-racing change is unchanged", () => {
  it("close: one ticket.closed, one ticket_closed activity row, no email, no SLA/flag reset", async () => {
    const res = await patchStatus("closed");

    expect(res).toEqual({ status: 200, body: { ok: true, changed: true } });
    expect(await deliveredEvents()).toEqual(["ticket.closed"]);
    expect(await closedActivityRows()).toBe(1);
    expect(emailJobs()).toHaveLength(0);
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
    const [row] = await db.select().from(tickets).where(eq(tickets.id, TICKET));
    expect(row.status).toBe("closed");
    expect(row.closedAt).not.toBeNull();
    expect(row.awaitingReply).toBe(true); // generic close never resets it
  });

  it("open -> open still emits ticket.status_changed", async () => {
    const res = await patchStatus("in_progress");

    expect(res).toEqual({ status: 200, body: { ok: true, changed: true } });
    expect(await deliveredEvents()).toEqual(["ticket.status_changed"]);
    expect(await closedActivityRows()).toBe(0);
  });

  it("closed -> closed still emits ticket.status_changed", async () => {
    await db.insert(ticketStatuses).values({
      id: "status-resolved",
      slug: "resolved",
      label: "Resolved",
      color: "green",
      sortOrder: 3,
      isDefault: false,
      isClosedState: true,
    });
    const closedTicket = tid(108);

    const res = await patchStatus("resolved", closedTicket);

    expect(res).toEqual({ status: 200, body: { ok: true, changed: true } });
    expect(await deliveredEvents(closedTicket)).toEqual([
      "ticket.status_changed",
    ]);
    const [row] = await db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, closedTicket));
    expect(row.status).toBe("resolved");
  });

  it("close -> reopen -> close fires ticket.closed twice (a legitimate second close)", async () => {
    expect((await patchStatus("closed")).body).toEqual({
      ok: true,
      changed: true,
    });
    expect((await patchStatus("open")).body).toEqual({
      ok: true,
      changed: true,
    });
    expect((await patchStatus("closed")).body).toEqual({
      ok: true,
      changed: true,
    });

    expect(await deliveredEvents()).toEqual([
      "ticket.closed",
      "ticket.closed",
      "ticket.reopened",
    ]);
    expect(await closedActivityRows()).toBe(2);
  });
});

describe("conditional generic close: a stale snapshot writes nothing", () => {
  const closeBehindTheSnapshot = async () => {
    const loaded = await loadTicketForChange(TICKET);
    expect(loaded.status).toBe("ok");
    const closedAt = new Date("2026-03-15T11:00:00.000Z");
    await db
      .update(tickets)
      .set({ status: "closed", closedAt, updatedAt: closedAt })
      .where(eq(tickets.id, TICKET));
    return { loaded, closedAt };
  };

  it("the route answers unchanged (as for an unchanged status), with no activity row or webhook", async () => {
    const { loaded, closedAt } = await closeBehindTheSnapshot();
    staleSnapshot.snapshot = loaded;

    const res = await patchStatus("closed");

    expect(staleSnapshot.snapshot).toBeNull(); // the stale snapshot was used
    expect(res).toEqual({ status: 200, body: { ok: true, changed: false } });
    expect(await deliveredEvents()).toEqual([]);
    expect(await closedActivityRows()).toBe(0);
    const [row] = await db.select().from(tickets).where(eq(tickets.id, TICKET));
    expect(row.closedAt).toEqual(closedAt);
    expect(row.updatedAt).toEqual(closedAt);
  });

  it("changeTicketStatusGeneric returns unchanged", async () => {
    const { loaded } = await closeBehindTheSnapshot();
    if (loaded.status !== "ok") {
      throw new Error("ticket should load");
    }

    const result = await changeTicketStatusGeneric({
      snapshot: loaded,
      actor: { id: "user-alice", name: "Alice", role: "agent" },
      value: "closed",
      now: new Date(),
    });

    expect(result).toEqual({ status: "unchanged" });
    expect(await deliveredEvents()).toEqual([]);
    expect(await closedActivityRows()).toBe(0);
  });
});

describe("conditional generic close: a dedicated close lands first (deterministic)", () => {
  it.each([
    "agent",
    "portal",
    "v1",
  ] as const)("generic PATCH whose snapshot predates a %s close -> unchanged, still one ticket.closed and one activity row", async (other) => {
    // The generic request has already loaded the (open) ticket ...
    const stale = await loadTicketForChange(TICKET);
    // ... when the dedicated close completes ...
    expect((await close(other)).status).toBe(200);
    // ... and only then does the generic request go on to update.
    staleSnapshot.snapshot = stale;
    const generic = await patchStatus("closed");

    expect(staleSnapshot.snapshot).toBeNull();
    expect(generic).toEqual({
      status: 200,
      body: { ok: true, changed: false },
    });
    expect(await deliveredEvents()).toEqual(["ticket.closed"]);
    expect(await closedActivityRows()).toBe(1);
    expect(emailJobs()).toHaveLength(1);
  });
});

describe("conditional generic close: concurrent closes", () => {
  it("two concurrent generic closes -> one ticket.closed, one ticket_closed activity row, no email", async () => {
    const results = await Promise.all([
      patchStatus("closed"),
      patchStatus("closed"),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map(changedFlag).sort()).toEqual([false, true]);
    expect(await deliveredEvents()).toEqual(["ticket.closed"]);
    expect(await closedActivityRows()).toBe(1);
    expect(emailJobs()).toHaveLength(0);
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
  });

  it.each([
    "agent",
    "portal",
    "v1",
  ] as const)("generic PATCH vs %s close -> exactly one ticket.closed and one activity row", async (other) => {
    const [generic, dedicated] = await Promise.all([
      patchStatus("closed"),
      close(other),
    ]);

    // Exactly one of the two closed the ticket.
    const genericWon = changedFlag(generic);
    expect(dedicated.status).toBe(genericWon ? 400 : 200);
    if (genericWon) {
      expect(dedicated).toEqual(ALREADY_CLOSED);
    }
    expect(await deliveredEvents()).toEqual(["ticket.closed"]);
    expect(await closedActivityRows()).toBe(1);
    // the dedicated paths email on close; the generic one never does
    expect(emailJobs()).toHaveLength(genericWon ? 0 : 1);
    expect(await db.select().from(emailOutbox)).toHaveLength(
      genericWon ? 0 : 1
    );
  });
});
