import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emailOutbox,
  mcpToolCalls,
  ticketActivity,
  ticketComments,
  webhookDeliveries,
} from "@/db/schema";
import { db } from "@/lib/db";
import type { Reconciler } from "@/lib/mcp/reconcile";
import {
  DEFAULT_PENDING_RECONCILERS,
  handleMcpToolCallsPrune,
  sweepStalePendingCalls,
} from "@/lib/worker/handlers/mcp-tool-calls-prune";
import { reseed } from "./characterization/helpers";
import { seedWorld, tid, USERS } from "./fixtures";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);

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
      tool: "reply_to_customer",
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

  it("do not cover close_ticket: a stuck close is just interrupted", async () => {
    expect(Object.keys(DEFAULT_PENDING_RECONCILERS)).not.toContain(
      "close_ticket"
    );
    await insertCall("stuck-close", ago(2 * HOUR), {
      tool: "close_ticket",
      targetTicketId: tid(101),
    });
    await handleMcpToolCallsPrune([]);
    expect(await rowOf("stuck-close")).toMatchObject({
      status: "failed",
      errorCode: "interrupted",
    });
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
