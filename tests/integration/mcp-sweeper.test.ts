import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emailOutbox,
  mcpToolCalls,
  ticketActivity,
  ticketComments,
  tickets,
  webhookDeliveries,
} from "@/db/schema";
import { db } from "@/lib/db";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { claimWriteCall } from "@/lib/mcp/idempotency";
import { MCP_PENDING_QUICK_SWEEP_AFTER_LEASE_MS } from "@/lib/mcp/limits";
import {
  type Reconciler,
  reconcileCloseCall,
  reconcilePendingActionCall,
} from "@/lib/mcp/reconcile";
import { QUEUE_OPTIONS } from "@/lib/worker/ensure-queues";
import { handleMcpPendingCallsSweep } from "@/lib/worker/handlers/mcp-pending-calls-sweep";
import {
  DEFAULT_PENDING_RECONCILERS,
  handleMcpToolCallsPrune,
  sweepExpiredLeasePendingCalls,
  sweepStalePendingCalls,
} from "@/lib/worker/handlers/mcp-tool-calls-prune";
import { JOB_NAMES } from "@/lib/worker/job-types";
import { reseed } from "./characterization/helpers";
import { seedWorld, tid, USERS } from "./fixtures";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);

// close_ticket now only creates an approval request, so its default reconciler
// looks for that request (reconcilePendingActionCall). These tests exercise
// reconcileCloseCall's rules (a close that landed under its planned activity
// row) through the sweepers, so they hand the sweeper that reconciler for
// close_ticket explicitly.
const DIRECT_CLOSE_RECONCILERS = {
  ...DEFAULT_PENDING_RECONCILERS,
  close_ticket: reconcileCloseCall,
};

beforeEach(async () => {
  await reseed(seedWorld);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  return () => {
    vi.restoreAllMocks();
  };
});

async function insertCall(
  id: string,
  createdAt: Date,
  over: Partial<typeof mcpToolCalls.$inferInsert> = {}
) {
  await db.insert(mcpToolCalls).values({
    id,
    requestId: `req-${id}`,
    userId: USERS.alice.id,
    authMethod: "pat",
    tool: "add_internal_note",
    status: "pending",
    plannedEntityId: `planned-${id}`,
    leaseExpiresAt: new Date(createdAt.getTime() + MINUTE),
    createdAt,
    updatedAt: createdAt,
    ...over,
  });
}

async function rowOf(id: string) {
  const [row] = await db
    .select()
    .from(mcpToolCalls)
    .where(eq(mcpToolCalls.id, id));
  return row;
}

async function sideEffectCounts() {
  return {
    comments: (await db.select().from(ticketComments)).length,
    activity: (await db.select().from(ticketActivity)).length,
    deliveries: (await db.select().from(webhookDeliveries)).length,
    outbox: (await db.select().from(emailOutbox)).length,
  };
}

const found = (result: Record<string, unknown> = { commentId: "c1" }) =>
  vi.fn<Reconciler>(() =>
    Promise.resolve({ done: true, result, sideEffectsUncertain: true })
  );
const notFound = () =>
  vi.fn<Reconciler>(() => Promise.resolve({ done: false }));

describe("sweeper: stale pending rows", () => {
  it("marks a row succeeded + uncertain when its reconciler finds the write", async () => {
    await insertCall("stale", ago(2 * HOUR));
    const reconcile = found({ commentId: "c1", note: "free text dropped" });

    await sweepStalePendingCalls({ add_internal_note: reconcile });

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0][0]).toMatchObject({
      id: "stale",
      plannedEntityId: "planned-stale",
    });
    expect(await rowOf("stale")).toMatchObject({
      status: "succeeded",
      errorCode: null,
      sideEffectsUncertain: true,
      resultJson: { commentId: "c1" },
    });
  });

  it("marks a row failed: interrupted when the reconciler finds nothing", async () => {
    await insertCall("stale", ago(2 * HOUR));
    const reconcile = notFound();
    await sweepStalePendingCalls({ add_internal_note: reconcile });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(await rowOf("stale")).toMatchObject({
      status: "failed",
      errorCode: "interrupted",
      resultJson: null,
    });
  });

  it("marks a row failed: interrupted when its tool has no reconciler", async () => {
    await insertCall("stale", ago(2 * HOUR), { tool: "close_ticket" });
    const other = notFound();
    await sweepStalePendingCalls({ add_internal_note: other });
    expect(other).not.toHaveBeenCalled();
    expect(await rowOf("stale")).toMatchObject({
      status: "failed",
      errorCode: "interrupted",
    });
  });

  it("marks a row failed: interrupted when its reconciler throws", async () => {
    await insertCall("stale", ago(2 * HOUR));
    await sweepStalePendingCalls({
      add_internal_note: () => Promise.reject(new Error("db blip ann@x.test")),
    });
    const row = await rowOf("stale");
    expect(row).toMatchObject({ status: "failed", errorCode: "interrupted" });
    expect(JSON.stringify(row)).not.toContain("ann@x.test");
  });

  it("leaves a pending row younger than an hour alone", async () => {
    await insertCall("recent", ago(30 * MINUTE));
    await insertCall("edge", ago(HOUR - MINUTE));
    const reconcile = found();
    await sweepStalePendingCalls({ add_internal_note: reconcile });
    expect(reconcile).not.toHaveBeenCalled();
    expect((await rowOf("recent")).status).toBe("pending");
    expect((await rowOf("edge")).status).toBe("pending");
  });

  it("does not touch settled rows", async () => {
    await insertCall("done", ago(2 * HOUR), {
      status: "succeeded",
      resultJson: { commentId: "kept" },
    });
    await insertCall("bad", ago(2 * HOUR), {
      status: "failed",
      errorCode: "not_found",
    });
    const reconcile = found();
    await sweepStalePendingCalls({ add_internal_note: reconcile });
    expect(reconcile).not.toHaveBeenCalled();
    expect(await rowOf("done")).toMatchObject({
      status: "succeeded",
      resultJson: { commentId: "kept" },
      sideEffectsUncertain: false,
    });
    expect(await rowOf("bad")).toMatchObject({
      status: "failed",
      errorCode: "not_found",
    });
  });

  it("does not overwrite a row another worker took over meanwhile", async () => {
    await insertCall("stale", ago(2 * HOUR));
    await sweepStalePendingCalls({
      add_internal_note: async (row) => {
        // A retry takes the row over while the sweeper is reconciling it.
        await db
          .update(mcpToolCalls)
          .set({ attempts: row.attempts + 1 })
          .where(eq(mcpToolCalls.id, row.id));
        return { done: false };
      },
    });
    expect(await rowOf("stale")).toMatchObject({
      status: "pending",
      attempts: 2,
    });
  });

  it("settling a row frees its per-ticket lock", async () => {
    await insertCall("stale", ago(2 * HOUR), {
      tool: "close_ticket",
      lockGroup: "ticket_state",
      targetTicketId: tid(101),
    });
    await sweepStalePendingCalls({});
    await insertCall("next", new Date(), {
      lockGroup: "ticket_state",
      targetTicketId: tid(101),
    });
    expect((await rowOf("next")).status).toBe("pending");
  });

  it("re-executes nothing: no comment, activity, delivery, email or call row appears", async () => {
    await insertCall("a", ago(2 * HOUR));
    await insertCall("b", ago(3 * HOUR), { tool: "reply_to_customer" });
    await insertCall("c", ago(4 * HOUR), { tool: "close_ticket" });
    const before = await sideEffectCounts();
    const rowsBefore = (await db.select().from(mcpToolCalls)).length;

    await sweepStalePendingCalls({
      add_internal_note: notFound(),
      reply_to_customer: found(),
    });

    expect(await sideEffectCounts()).toEqual(before);
    expect((await db.select().from(mcpToolCalls)).length).toBe(rowsBefore);
  });
});

describe("sweeper: the default reconcilers", () => {
  it("settle a comment tool whose comment exists, via the real reconciler", async () => {
    await insertCall("with-comment", ago(2 * HOUR), {
      tool: "add_internal_note",
    });
    await insertCall("without-comment", ago(2 * HOUR), {
      tool: "add_internal_note",
    });
    await db.insert(ticketComments).values({
      id: "planned-with-comment",
      ticketId: tid(101),
      authorId: USERS.alice.id,
      authorName: USERS.alice.name,
      authorRole: "agent",
      content: "x",
    });

    await handleMcpToolCallsPrune([]);

    expect(await rowOf("with-comment")).toMatchObject({
      status: "succeeded",
      sideEffectsUncertain: true,
      resultJson: { commentId: "planned-with-comment" },
    });
    expect(await rowOf("without-comment")).toMatchObject({
      status: "failed",
      errorCode: "interrupted",
    });
  });

  it("cover close_ticket and reply_to_customer: the approval-request reconciler is registered", () => {
    expect(DEFAULT_PENDING_RECONCILERS.close_ticket).toBe(
      reconcilePendingActionCall
    );
    expect(DEFAULT_PENDING_RECONCILERS.reply_to_customer).toBe(
      reconcilePendingActionCall
    );
  });

  it("settle a stuck close whose ticket was closed by its own planned activity row", async () => {
    await insertCall("stuck-close", ago(2 * HOUR), {
      tool: "close_ticket",
      targetTicketId: tid(101),
    });
    await db
      .update(tickets)
      .set({ status: "closed", closedAt: ago(2 * HOUR - MINUTE) })
      .where(eq(tickets.id, tid(101)));
    await db.insert(ticketActivity).values({
      id: "planned-stuck-close",
      ticketId: tid(101),
      actorId: USERS.alice.id,
      actorName: USERS.alice.name,
      actorRole: "agent",
      action: "ticket_closed",
      metadata: { from: "open", to: "closed" },
      createdAt: ago(2 * HOUR - MINUTE),
    });

    await handleMcpToolCallsPrune([], DIRECT_CLOSE_RECONCILERS);

    expect(await rowOf("stuck-close")).toMatchObject({
      status: "succeeded",
      errorCode: null,
      sideEffectsUncertain: true,
      resultJson: { activityId: "planned-stuck-close" },
    });
  });

  it("mark a stuck close failed: interrupted when its ticket is still open", async () => {
    await insertCall("stuck-close", ago(2 * HOUR), {
      tool: "close_ticket",
      targetTicketId: tid(101),
    });
    await handleMcpToolCallsPrune([]);
    expect(await rowOf("stuck-close")).toMatchObject({
      status: "failed",
      errorCode: "interrupted",
      resultJson: null,
    });
    const [ticket] = await db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, tid(101)));
    expect(ticket.status).toBe("open");
  });
});

describe("the job: reconcile first, then the 30-day delete", () => {
  it("still deletes everything older than 30 days and keeps the rest", async () => {
    await insertCall("old-pending", ago(31 * DAY));
    await insertCall("old-done", ago(45 * DAY), { status: "succeeded" });
    await insertCall("keep-29d", ago(29 * DAY), { status: "succeeded" });
    await insertCall("keep-stale-pending", ago(2 * HOUR));
    await insertCall("keep-recent-pending", ago(5 * MINUTE));

    await handleMcpToolCallsPrune([]);

    const rows = await db.select().from(mcpToolCalls);
    expect(rows.map((r) => r.id).sort()).toEqual([
      "keep-29d",
      "keep-recent-pending",
      "keep-stale-pending",
    ]);
    expect(rows.find((r) => r.id === "keep-stale-pending")?.errorCode).toBe(
      "interrupted"
    );
    expect(rows.find((r) => r.id === "keep-recent-pending")?.status).toBe(
      "pending"
    );
  });
});

describe("the 5-minute sweep: pending rows whose lease expired", () => {
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
  const lockedClaim = (clientRequestId: string) =>
    claimWriteCall({
      principal,
      requestId: `req-${clientRequestId}`,
      tool: "close_ticket",
      args: { ticket: "t-101" },
      clientRequestId,
      lockGroup: "ticket_state",
      targetTicketId: tid(101),
    });
  // A crashed attempt: pending, lease expired `leaseAgo` ago, claimed `createdAgo` ago.
  const crashed = (
    id: string,
    createdAgo: number,
    leaseAgo: number,
    over: Partial<typeof mcpToolCalls.$inferInsert> = {}
  ) =>
    insertCall(id, ago(createdAgo), {
      leaseExpiresAt: ago(leaseAgo),
      ...over,
    });

  it("is registered like the daily prune job and runs every 5 minutes", () => {
    expect(JOB_NAMES.MCP_PENDING_CALLS_SWEEP).toBe("mcp.pending-calls-sweep");
    expect(QUEUE_OPTIONS[JOB_NAMES.MCP_PENDING_CALLS_SWEEP]).toEqual(
      QUEUE_OPTIONS[JOB_NAMES.MCP_TOOL_CALLS_PRUNE]
    );
    expect(MCP_PENDING_QUICK_SWEEP_AFTER_LEASE_MS).toBe(5 * MINUTE);
  });

  it("frees a crashed lock holder within one sweep, so a new key can claim the ticket", async () => {
    await crashed("holder", 7 * MINUTE, 6 * MINUTE, {
      tool: "close_ticket",
      lockGroup: "ticket_state",
      targetTicketId: tid(101),
      clientRequestId: "key-crashed-holder-0001",
    });

    // Before the sweep the dead holder still blocks other keys.
    expect(await lockedClaim("key-other-caller-00001")).toMatchObject({
      kind: "in_progress",
    });

    await handleMcpPendingCallsSweep([]);

    expect(await rowOf("holder")).toMatchObject({
      status: "failed",
      errorCode: "interrupted",
    });
    const next = await lockedClaim("key-other-caller-00001");
    expect(next.kind).toBe("claimed");
  });

  it("settles a stuck close through its reconciler, like the daily sweep", async () => {
    await crashed("holder", 7 * MINUTE, 6 * MINUTE, {
      tool: "close_ticket",
      lockGroup: "ticket_state",
      targetTicketId: tid(101),
    });
    await db
      .update(tickets)
      .set({ status: "closed", closedAt: ago(7 * MINUTE) })
      .where(eq(tickets.id, tid(101)));
    await db.insert(ticketActivity).values({
      id: "planned-holder",
      ticketId: tid(101),
      actorId: USERS.alice.id,
      actorName: USERS.alice.name,
      actorRole: "agent",
      action: "ticket_closed",
      metadata: { from: "open", to: "closed" },
      createdAt: ago(7 * MINUTE),
    });
    const before = await sideEffectCounts();

    await handleMcpPendingCallsSweep([], DIRECT_CLOSE_RECONCILERS);

    expect(await rowOf("holder")).toMatchObject({
      status: "succeeded",
      sideEffectsUncertain: true,
      resultJson: { activityId: "planned-holder" },
    });
    expect(await sideEffectCounts()).toEqual(before);
  });

  it("leaves a row with a live lease alone, however old it is", async () => {
    await insertCall("live", ago(2 * HOUR), { leaseExpiresAt: ago(-MINUTE) });
    const reconcile = found();
    await sweepExpiredLeasePendingCalls({ add_internal_note: reconcile });
    expect(reconcile).not.toHaveBeenCalled();
    expect((await rowOf("live")).status).toBe("pending");
  });

  it("leaves a row whose lease expired only 2 minutes ago alone", async () => {
    await crashed("recent", 10 * MINUTE, 2 * MINUTE);
    await crashed("edge", 10 * MINUTE, 5 * MINUTE - 5000);
    const reconcile = found();
    await sweepExpiredLeasePendingCalls({ add_internal_note: reconcile });
    expect(reconcile).not.toHaveBeenCalled();
    expect((await rowOf("recent")).status).toBe("pending");
    expect((await rowOf("edge")).status).toBe("pending");
  });

  it("settles a row whose lease expired more than 5 minutes ago, even though it is under an hour old", async () => {
    await crashed("quick", 30 * MINUTE, 6 * MINUTE);
    await sweepExpiredLeasePendingCalls({ add_internal_note: notFound() });
    expect(await rowOf("quick")).toMatchObject({
      status: "failed",
      errorCode: "interrupted",
    });
  });

  it("does not touch settled rows, delete anything or re-execute anything", async () => {
    await crashed("done", 2 * HOUR, 90 * MINUTE, {
      status: "succeeded",
      resultJson: { commentId: "kept" },
    });
    await insertCall("ancient", ago(45 * DAY), { status: "succeeded" });
    await crashed("stuck", 20 * MINUTE, 10 * MINUTE);
    const before = await sideEffectCounts();
    const reconcile = found();

    await sweepExpiredLeasePendingCalls({ add_internal_note: reconcile });

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(await rowOf("done")).toMatchObject({
      status: "succeeded",
      resultJson: { commentId: "kept" },
      sideEffectsUncertain: false,
    });
    expect(await rowOf("ancient")).toBeDefined(); // only the daily job prunes
    expect(await sideEffectCounts()).toEqual(before);
  });

  it("does not overwrite a row taken over (attempts changed) while it is reconciled", async () => {
    await crashed("stuck", 20 * MINUTE, 10 * MINUTE);
    await sweepExpiredLeasePendingCalls({
      add_internal_note: async (row) => {
        // A retry takes the row over: new attempt, fresh lease.
        await db
          .update(mcpToolCalls)
          .set({ attempts: row.attempts + 1, leaseExpiresAt: ago(-MINUTE) })
          .where(eq(mcpToolCalls.id, row.id));
        return { done: false };
      },
    });
    expect(await rowOf("stuck")).toMatchObject({
      status: "pending",
      attempts: 2,
    });
  });

  it("does not overwrite a row finalized while it is reconciled", async () => {
    await crashed("stuck", 20 * MINUTE, 10 * MINUTE);
    await sweepExpiredLeasePendingCalls({
      add_internal_note: async (row) => {
        // The slow original attempt finalizes just before the sweeper writes.
        await db
          .update(mcpToolCalls)
          .set({ status: "succeeded", resultJson: { commentId: "real" } })
          .where(eq(mcpToolCalls.id, row.id));
        return { done: false };
      },
    });
    expect(await rowOf("stuck")).toMatchObject({
      status: "succeeded",
      resultJson: { commentId: "real" },
      sideEffectsUncertain: false,
    });
  });

  it("treats a NULL lease as expired once the row has not been updated for 5 minutes", async () => {
    await insertCall("null-old", ago(20 * MINUTE), { leaseExpiresAt: null });
    await insertCall("null-new", ago(20 * MINUTE), {
      leaseExpiresAt: null,
      updatedAt: ago(MINUTE),
    });
    await sweepExpiredLeasePendingCalls({ add_internal_note: notFound() });
    expect((await rowOf("null-old")).status).toBe("failed");
    expect((await rowOf("null-new")).status).toBe("pending");
  });

  it("leaves the daily sweep exactly as it was: age counts, the lease does not", async () => {
    // Over an hour old with a live lease: the daily sweep still settles it.
    await insertCall("old-live", ago(2 * HOUR), { leaseExpiresAt: ago(-HOUR) });
    // Under an hour old with an expired lease: the daily sweep still skips it.
    await crashed("young-expired", 30 * MINUTE, 20 * MINUTE);

    await sweepStalePendingCalls({ add_internal_note: notFound() });

    expect((await rowOf("old-live")).status).toBe("failed");
    expect((await rowOf("young-expired")).status).toBe("pending");
  });
});
