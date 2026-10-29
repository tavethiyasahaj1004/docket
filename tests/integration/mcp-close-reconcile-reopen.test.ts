import { and, sql as dsql, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emailOutbox,
  mcpToolCalls,
  ticketActivity,
  tickets,
  webhookDeliveries,
} from "@/db/schema";
import { db } from "@/lib/db";
import type { McpPrincipal } from "@/lib/mcp/auth";
import {
  claimWriteCall,
  type ExecuteResult,
  runIdempotentWrite,
  type WriteCallContext,
} from "@/lib/mcp/idempotency";
import { reconcileCloseCall } from "@/lib/mcp/reconcile";
import { closeTicket } from "@/lib/tickets/services/close";
import { reopenTicket } from "@/lib/tickets/services/reopen";
import type { ServiceActor } from "@/lib/tickets/services/types";
import {
  DEFAULT_PENDING_RECONCILERS,
  sweepExpiredLeasePendingCalls,
} from "@/lib/worker/handlers/mcp-tool-calls-prune";
import {
  callLog,
  resetMocks,
  seedWriteWorld,
} from "./characterization/write-helpers";
import { tid, USERS } from "./fixtures";

// Regression for H1: a close_ticket call that landed its close and crashed
// before it was finalized, followed by a reopen of the ticket. Recovery (the
// sweeper or a same-key retry) must answer "done" from the call's OWN activity
// row; it must not see an open ticket, re-run the close, and silently re-close
// the reopened ticket under the same planned id.
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

const TICKET = tid(101); // open, customer Ann
const MINUTE = 60 * 1000;
const principal: McpPrincipal = {
  userId: USERS.alice.id,
  name: USERS.alice.name,
  email: USERS.alice.email,
  role: "agent",
  scopes: ["tickets:read"],
  authMethod: "pat",
  credentialId: "cred-1",
  credentialName: "laptop",
  credentialExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
};
const actor: ServiceActor = {
  id: USERS.alice.id,
  name: USERS.alice.name,
  role: "agent",
};

let counter = 0;
// What a close_ticket call looks like to the ledger: the per-ticket lock group
// and the target ticket, under a fixed client request id.
function closeCtx(): WriteCallContext {
  counter += 1;
  return {
    principal,
    requestId: `req-${counter}`,
    tool: "close_ticket",
    args: { ticket: "t-101" },
    clientRequestId: "key-close-0001",
    lockGroup: "ticket_state",
    targetTicketId: TICKET,
  };
}

// The hooks a close_ticket tool would pass to runIdempotentWrite.
function closeHooks() {
  const execute = vi.fn(async (planned: string): Promise<ExecuteResult> => {
    const result = await closeTicket({
      ticketId: TICKET,
      actor,
      activityId: planned,
      activityMetadata: { via: "mcp", credentialId: principal.credentialId },
    });
    if (result.status === "closed") {
      await result.email;
      return { result: { activityId: result.activityId } };
    }
    if (result.status === "already_closed") {
      return { result: { alreadyClosed: true } };
    }
    throw new Error(`unexpected close result: ${result.status}`);
  });
  return { execute, reconcile: reconcileCloseCall };
}

type Effects = {
  closeActivity: number;
  closedDeliveries: number;
  deliveries: number;
  emailJobs: number;
  outbox: number;
};

async function effects(): Promise<Effects> {
  const [[closeActivity], [closedDeliveries], [deliveries], [outbox]] =
    await Promise.all([
      db
        .select({ n: dsql<number>`count(*)::int` })
        .from(ticketActivity)
        .where(
          and(
            eq(ticketActivity.ticketId, TICKET),
            eq(ticketActivity.action, "ticket_closed")
          )
        ),
      db
        .select({ n: dsql<number>`count(*)::int` })
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.event, "ticket.closed"),
            eq(webhookDeliveries.entityId, TICKET)
          )
        ),
      db.select({ n: dsql<number>`count(*)::int` }).from(webhookDeliveries),
      db.select({ n: dsql<number>`count(*)::int` }).from(emailOutbox),
    ]);
  return {
    closeActivity: closeActivity.n,
    closedDeliveries: closedDeliveries.n,
    deliveries: deliveries.n,
    outbox: outbox.n,
    emailJobs: callLog.filter((c) => c.job === "email.send").length,
  };
}

async function ticketState() {
  const [row] = await db
    .select({ status: tickets.status, closedAt: tickets.closedAt })
    .from(tickets)
    .where(eq(tickets.id, TICKET));
  return row;
}

const callRows = () => db.select().from(mcpToolCalls);

let baseline: Effects;

beforeEach(async () => {
  resetMocks();
  counter = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await seedWriteWorld();
  baseline = await effects();
  return () => {
    vi.restoreAllMocks();
  };
});

/** A claimed close_ticket call lands its close (ticket closed, activity row P,
 * webhook, email) and then "crashes" before it is finalized, so its ledger row
 * stays pending. The ticket is then reopened through the real reopen service
 * and the lease runs out. Returns P and the effects the landed close left. */
async function crashedCloseThenReopen() {
  const claimed = await claimWriteCall(closeCtx());
  if (claimed.kind !== "claimed") {
    throw new Error(`expected claimed, got ${claimed.kind}`);
  }
  const planned = claimed.claim.plannedEntityId;

  const closed = await closeTicket({
    ticketId: TICKET,
    actor,
    activityId: planned,
    activityMetadata: { via: "mcp", credentialId: principal.credentialId },
  });
  expect(closed.status).toBe("closed");
  if (closed.status === "closed") {
    await closed.email;
  }
  // (the crash: finalizeWriteCall is never called)

  const reopened = await reopenTicket({ ticketId: TICKET, actor });
  expect(reopened.status).toBe("reopened");
  expect((await ticketState()).status).toBe("open");

  await db
    .update(mcpToolCalls)
    .set({ leaseExpiresAt: new Date(Date.now() - 10 * MINUTE) })
    .where(eq(mcpToolCalls.id, claimed.claim.id));

  const afterCrash = await effects();
  // The landed close left exactly one activity row, one ticket.closed delivery
  // and one close email.
  expect(afterCrash.closeActivity).toBe(baseline.closeActivity + 1);
  expect(afterCrash.closedDeliveries).toBe(baseline.closedDeliveries + 1);
  expect(afterCrash.outbox).toBe(baseline.outbox + 1);
  expect(afterCrash.emailJobs).toBe(baseline.emailJobs + 1);

  const [pending] = await callRows();
  expect(pending).toMatchObject({
    status: "pending",
    plannedEntityId: planned,
  });
  return { planned, afterCrash };
}

describe("close landed, call crashed, ticket reopened", () => {
  it("sweeper: settles the row as succeeded + uncertain with the planned activity id, then a same-key retry replays it without re-closing", async () => {
    const { planned, afterCrash } = await crashedCloseThenReopen();

    // close_ticket's default reconciler now looks for an approval request; this
    // test is about reconcileCloseCall's own rules, so it is passed explicitly.
    await sweepExpiredLeasePendingCalls(
      { ...DEFAULT_PENDING_RECONCILERS, close_ticket: reconcileCloseCall },
      new Date()
    );

    const [row] = await callRows();
    expect(row).toMatchObject({
      status: "succeeded",
      errorCode: null,
      sideEffectsUncertain: true,
      resultJson: { activityId: planned },
    });
    expect(await effects()).toEqual(afterCrash);

    const hooks = closeHooks();
    const outcome = await runIdempotentWrite(closeCtx(), hooks);

    expect(outcome).toMatchObject({
      kind: "succeeded",
      replayed: true,
      sideEffectsUncertain: true,
      result: { activityId: planned, replayed: true },
    });
    expect(hooks.execute).not.toHaveBeenCalled();
    expect(await ticketState()).toMatchObject({
      status: "open",
      closedAt: null,
    });
    expect(await effects()).toEqual(afterCrash);
    expect(await callRows()).toHaveLength(1);
  });

  it("takeover: a same-key retry after the lease expired reconciles to done, does not execute, and leaves the reopened ticket open", async () => {
    const { planned, afterCrash } = await crashedCloseThenReopen();

    const hooks = closeHooks();
    const outcome = await runIdempotentWrite(closeCtx(), hooks);

    expect(outcome).toMatchObject({
      kind: "succeeded",
      replayed: false,
      sideEffectsUncertain: true,
      result: { activityId: planned },
    });
    expect(hooks.execute).not.toHaveBeenCalled();
    expect(await ticketState()).toMatchObject({
      status: "open",
      closedAt: null,
    });
    expect(await effects()).toEqual(afterCrash);

    const [row] = await callRows();
    expect(row).toMatchObject({
      status: "succeeded",
      attempts: 2,
      sideEffectsUncertain: true,
      resultJson: { activityId: planned },
    });

    // And the stored success is what any further retry sees.
    const again = closeHooks();
    expect(await runIdempotentWrite(closeCtx(), again)).toMatchObject({
      kind: "succeeded",
      replayed: true,
      result: { activityId: planned, replayed: true },
    });
    expect(again.execute).not.toHaveBeenCalled();
    expect(await effects()).toEqual(afterCrash);
  });
});
