import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  mcpToolCalls,
  ticketActivity,
  ticketComments,
  tickets,
} from "@/db/schema";
import { db } from "@/lib/db";
import { MCP_WRITE_LEASE_MS } from "@/lib/mcp/limits";
import {
  type McpToolCallRow,
  reconcileCloseCall,
  reconcileCommentCall,
} from "@/lib/mcp/reconcile";
import { DEFAULT_PENDING_RECONCILERS } from "@/lib/worker/handlers/mcp-tool-calls-prune";
import { reseed } from "./characterization/helpers";
import { seedWorld, tid, USERS } from "./fixtures";

const CLAIM = new Date("2026-03-15T12:00:00.000Z");
const at = (offsetMs: number) => new Date(CLAIM.getTime() + offsetMs);
const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const PLANNED = "planned-activity-id";
const TICKET = tid(101);

beforeEach(async () => {
  await reseed(seedWorld);
});

async function claimRow(
  over: Partial<typeof mcpToolCalls.$inferInsert> = {}
): Promise<McpToolCallRow> {
  const id = createId();
  await db.insert(mcpToolCalls).values({
    id,
    requestId: "req-1",
    userId: USERS.alice.id,
    authMethod: "pat",
    tool: "close_ticket",
    clientRequestId: "key-1",
    status: "pending",
    plannedEntityId: PLANNED,
    lockGroup: "ticket_state",
    targetTicketId: TICKET,
    leaseExpiresAt: at(-1),
    createdAt: CLAIM,
    updatedAt: CLAIM,
    ...over,
  });
  const [row] = await db
    .select()
    .from(mcpToolCalls)
    .where(eq(mcpToolCalls.id, id));
  return row;
}

async function closeTicketRow(closedAt: Date | null, ticketId = TICKET) {
  await db
    .update(tickets)
    .set({ status: "closed", closedAt })
    .where(eq(tickets.id, ticketId));
}

async function addClosedActivity(
  id: string,
  createdAt: Date,
  over: Partial<typeof ticketActivity.$inferInsert> = {}
) {
  await db.insert(ticketActivity).values({
    id,
    ticketId: TICKET,
    actorId: USERS.alice.id,
    actorName: USERS.alice.name,
    actorRole: "agent",
    action: "ticket_closed",
    createdAt,
    ...over,
  });
}

describe("reconcileCommentCall", () => {
  it("done + uncertain when the comment exists under the planned id", async () => {
    const row = await claimRow({
      tool: "reply_to_customer",
      plannedEntityId: "planned-comment-id",
    });
    await db.insert(ticketComments).values({
      id: "planned-comment-id",
      ticketId: TICKET,
      authorId: USERS.alice.id,
      authorName: USERS.alice.name,
      authorRole: "agent",
      content: "x",
    });
    expect(await reconcileCommentCall(row)).toEqual({
      done: true,
      result: { commentId: "planned-comment-id" },
      sideEffectsUncertain: true,
    });
  });

  it("not done when no such comment exists", async () => {
    const row = await claimRow({ plannedEntityId: "nobody-wrote-this" });
    expect(await reconcileCommentCall(row)).toEqual({ done: false });
  });

  it("not done without a planned id", async () => {
    const row = await claimRow({ plannedEntityId: null });
    expect(await reconcileCommentCall(row)).toEqual({ done: false });
  });
});

describe("reconcileCloseCall (7.3 cases 1-5)", () => {
  it("1. ticket not closed: not done, so the call runs again", async () => {
    const row = await claimRow();
    expect(await reconcileCloseCall(row)).toEqual({ done: false });
  });

  it("1. an old ticket_closed activity on a reopened ticket does not count", async () => {
    await addClosedActivity("older", at(-HOUR));
    const row = await claimRow();
    expect(await reconcileCloseCall(row)).toEqual({ done: false });
  });

  it("2. our own activity row exists: done + uncertain", async () => {
    await closeTicketRow(at(2 * SECOND));
    await addClosedActivity(PLANNED, at(2 * SECOND));
    const row = await claimRow();
    expect(await reconcileCloseCall(row)).toEqual({
      done: true,
      result: { activityId: PLANNED },
      sideEffectsUncertain: true,
    });
  });

  it("2. wins over 3: our activity row decides even if closedAt looks old", async () => {
    await closeTicketRow(at(-HOUR));
    await addClosedActivity(PLANNED, at(2 * SECOND));
    const row = await claimRow();
    expect(await reconcileCloseCall(row)).toMatchObject({
      done: true,
      sideEffectsUncertain: true,
      result: { activityId: PLANNED },
    });
  });

  it("3. closed before the claim: alreadyClosed, not uncertain", async () => {
    await closeTicketRow(at(-HOUR));
    await addClosedActivity("someone-else", at(-HOUR));
    const row = await claimRow();
    expect(await reconcileCloseCall(row)).toEqual({
      done: true,
      result: { alreadyClosed: true },
      sideEffectsUncertain: false,
    });
  });

  it("3. a gap smaller than the lease window is treated as case 5", async () => {
    await closeTicketRow(at(-(MCP_WRITE_LEASE_MS - 5 * SECOND)));
    const row = await claimRow();
    expect(await reconcileCloseCall(row)).toEqual({
      done: true,
      result: { alreadyClosed: true },
      sideEffectsUncertain: true,
    });
  });

  it("3. a gap just beyond the lease window is case 3", async () => {
    await closeTicketRow(at(-(MCP_WRITE_LEASE_MS + SECOND)));
    const row = await claimRow();
    expect(await reconcileCloseCall(row)).toMatchObject({
      done: true,
      sideEffectsUncertain: false,
    });
  });

  it("4. another actor's close activity since the claim: alreadyClosed, not uncertain", async () => {
    await closeTicketRow(at(5 * SECOND));
    await addClosedActivity("other-closer", at(5 * SECOND), {
      actorId: USERS.bob.id,
      actorName: USERS.bob.name,
    });
    const row = await claimRow();
    expect(await reconcileCloseCall(row)).toEqual({
      done: true,
      result: { alreadyClosed: true },
      sideEffectsUncertain: false,
    });
  });

  it("4. an activity exactly at the claim time counts (>=)", async () => {
    await closeTicketRow(at(0));
    await addClosedActivity("other-closer", at(0));
    const row = await claimRow();
    expect(await reconcileCloseCall(row)).toMatchObject({
      done: true,
      sideEffectsUncertain: false,
    });
  });

  it("5. closed since the claim with no close activity: alreadyClosed + uncertain", async () => {
    await closeTicketRow(at(5 * SECOND));
    const row = await claimRow();
    expect(await reconcileCloseCall(row)).toEqual({
      done: true,
      result: { alreadyClosed: true },
      sideEffectsUncertain: true,
    });
  });

  it("5. a close activity from before the claim, or another action, does not make it case 4", async () => {
    await closeTicketRow(at(5 * SECOND));
    await addClosedActivity("older-close", at(-HOUR));
    await addClosedActivity("newer-other-action", at(4 * SECOND), {
      action: "status_changed",
    });
    const row = await claimRow();
    expect(await reconcileCloseCall(row)).toMatchObject({
      done: true,
      sideEffectsUncertain: true,
    });
  });

  it("5. a close activity on another ticket does not count either", async () => {
    await closeTicketRow(at(5 * SECOND));
    await db.insert(ticketActivity).values({
      id: "other-ticket-close",
      ticketId: tid(102),
      actorName: "x",
      actorRole: "agent",
      action: "ticket_closed",
      createdAt: at(5 * SECOND),
    });
    const row = await claimRow();
    expect(await reconcileCloseCall(row)).toMatchObject({
      done: true,
      sideEffectsUncertain: true,
    });
  });

  it("a closed ticket without closedAt is treated conservatively (case 5)", async () => {
    await closeTicketRow(null);
    const row = await claimRow();
    expect(await reconcileCloseCall(row)).toMatchObject({
      done: true,
      sideEffectsUncertain: true,
    });
  });

  it("not done when the ticket or its target is missing", async () => {
    expect(
      await reconcileCloseCall(await claimRow({ targetTicketId: null }))
    ).toEqual({ done: false });
    expect(
      await reconcileCloseCall(
        await claimRow({
          targetTicketId: "no-such-ticket",
          clientRequestId: "k2",
        })
      )
    ).toEqual({ done: false });
    expect(
      await reconcileCloseCall(
        await claimRow({ plannedEntityId: null, clientRequestId: "k3" })
      )
    ).toEqual({ done: false });
  });
});

describe("close_ticket is wired to the sweeper (P10 is in)", () => {
  it("is in the default reconciler map", () => {
    expect(DEFAULT_PENDING_RECONCILERS.close_ticket).toBe(reconcileCloseCall);
    expect(Object.keys(DEFAULT_PENDING_RECONCILERS).sort()).toEqual([
      "add_internal_note",
      "close_ticket",
      "reply_to_customer",
    ]);
  });
});
