import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  mcpPendingActions,
  mcpToolCalls,
  rateLimitHits,
  ticketReplyDrafts,
} from "@/db/schema";
import { db } from "@/lib/db";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { createPendingAction } from "@/lib/mcp/pending-actions";
import { createDocketMcpServer } from "@/lib/mcp/server";
import { textToRichTextJson } from "@/lib/rich-text";
import { sweepExpiredLeasePendingCalls } from "@/lib/worker/handlers/mcp-tool-calls-prune";
import { setupMcpWorld } from "./mcp-helpers";
import {
  ALICE,
  activityOn,
  approve,
  auditOf,
  BOB,
  call,
  commentsOn,
  connectWith,
  deliveryEvents,
  dismiss,
  expectError,
  expectOk,
  FRANK,
  key,
  ledger,
  notificationRows,
  OPERATOR_SCOPES,
  outboxCount,
  pendingRow,
  pendingRows,
  pushCalls,
  SEC_BODY,
  seedPhase6World,
  setReplyGate,
  T_CLOSED,
  T_MERGED,
  T_OPEN,
  ticketState,
  UPDATED_101,
  USERS,
} from "./mcp-phase6-helpers";
import { callTool, closeMcpClients } from "./mcp-read-helpers";

const world = setupMcpWorld();

const quiet: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(async () => {
  for (const method of ["log", "warn", "error", "info"] as const) {
    quiet.push(vi.spyOn(console, method).mockImplementation(() => undefined));
  }
  await seedPhase6World(world);
});

afterEach(async () => {
  await closeMcpClients();
  vi.restoreAllMocks();
  quiet.length = 0;
});

async function operator(userId: string = ALICE) {
  return (await connectWith(world, userId, OPERATOR_SCOPES)).client;
}

/** Everything a close or a reply could change on a ticket, plus the counters
 * an approval is the only thing allowed to move. */
async function effects(ticketId: string = T_OPEN) {
  return {
    state: await ticketState(ticketId),
    activity: (await activityOn(ticketId)).length,
    comments: (await commentsOn(ticketId)).length,
    deliveries: await deliveryEvents(),
    outbox: await outboxCount(),
  };
}

const requestNotifications = async () =>
  (await notificationRows()).filter((n) => n.type === "mcp_action_pending");

async function requestAudits() {
  return await auditOf("mcp.action_requested");
}

/** Rewinds the ledger row of a call to a state a crash could leave behind. */
async function rewindLedger(
  tool: string,
  to: "failed" | "lease_expired"
): Promise<string> {
  const rows = (await ledger()).filter((r) => r.tool === tool);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  await db
    .update(mcpToolCalls)
    .set(
      to === "failed"
        ? {
            status: "failed",
            errorCode: "interrupted",
            resultJson: null,
            sideEffectsUncertain: false,
          }
        : {
            status: "pending",
            errorCode: null,
            resultJson: null,
            leaseExpiresAt: new Date(Date.now() - 60_000),
          }
    )
    .where(eq(mcpToolCalls.id, row.id));
  return row.id;
}

/* ============================================================ close_ticket */

describe("close_ticket", () => {
  it("creates exactly one approval request and closes nothing", async () => {
    const client = await operator();
    const before = await effects();
    const r = expectOk(
      await call(client, "close_ticket", {
        ticket: 101,
        clientRequestId: key("close-1"),
      })
    );

    const [row] = await pendingRows();
    expect(await pendingRows()).toHaveLength(1);
    expect(row).toMatchObject({
      kind: "close",
      ticketId: T_OPEN,
      requestedById: ALICE,
      status: "pending",
      payload: {},
    });
    expect(r).toMatchObject({
      status: "awaiting_approval",
      requestId: row.id,
      ticket: { number: 101 },
      approvalNote:
        "The ticket owner must approve this in Docket (ticket page).",
    });
    expect(r.expiresAt).toBe(row.expiresAt.toISOString());
    expect(r.existingRequest).toBeUndefined();

    // The request id is the ledger call's planned id; the row traces the call.
    const [call1] = await ledger();
    expect(call1).toMatchObject({
      tool: "close_ticket",
      status: "succeeded",
      plannedEntityId: row.id,
      lockGroup: null,
    });
    expect(row.toolCallId).toBe(call1.id);

    // Nothing the customer sees, and nothing on the ticket.
    expect(await effects()).toEqual(before);
    expect((await ticketState(T_OPEN)).status).toBe("open");

    // The owner is told; the request is audited.
    const notes = await requestNotifications();
    expect(notes).toHaveLength(1);
    expect(notes[0].userId).toBe(ALICE);
    expect(pushCalls()).toHaveLength(1);
    const audits = await requestAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: ALICE, entityId: row.id });
  });

  it("replays a repeated key: same request, nothing new", async () => {
    const client = await operator();
    const args = { ticket: 101, clientRequestId: key("close-2") };
    const first = expectOk(await call(client, "close_ticket", args));
    const again = expectOk(await call(client, "close_ticket", args));
    expect(again.replayed).toBe(true);
    expect(again.requestId).toBe(first.requestId);
    expect(again.existingRequest).toBeUndefined();
    expect(await pendingRows()).toHaveLength(1);
    expect(await requestNotifications()).toHaveLength(1);
    expect(await requestAudits()).toHaveLength(1);
  });

  it("returns the pending request again for a new key, creating no second request or notification", async () => {
    const client = await operator();
    const first = expectOk(
      await call(client, "close_ticket", {
        ticket: 101,
        clientRequestId: key("close-3a"),
      })
    );
    const second = expectOk(
      await call(client, "close_ticket", {
        ticket: 101,
        clientRequestId: key("close-3b"),
      })
    );
    expect(second.requestId).toBe(first.requestId);
    expect(second.existingRequest).toBe(true);
    expect(second.status).toBe("awaiting_approval");
    expect(await pendingRows()).toHaveLength(1);
    expect(await requestNotifications()).toHaveLength(1);
    expect(await requestAudits()).toHaveLength(1);
    expect(await ledger()).toHaveLength(2);
  });

  it("creates no request for an already closed ticket", async () => {
    const client = await operator();
    const before = await effects(T_CLOSED);
    const r = expectOk(
      await call(client, "close_ticket", {
        ticket: 107,
        clientRequestId: key("close-4"),
      })
    );
    expect(r).toMatchObject({
      status: "already_closed",
      alreadyClosed: true,
      ticket: { number: 107 },
    });
    expect(r.requestId).toBeUndefined();
    expect(await pendingRows()).toHaveLength(0);
    expect(await requestNotifications()).toHaveLength(0);
    expect(await effects(T_CLOSED)).toEqual(before);
    // The no-op is stored too, so a replay says the same.
    const again = expectOk(
      await call(client, "close_ticket", {
        ticket: 107,
        clientRequestId: key("close-4"),
      })
    );
    expect(again).toMatchObject({ status: "already_closed", replayed: true });
  });

  it("answers merged for a merged ticket and creates no request", async () => {
    const client = await operator();
    const error = expectError(
      await call(client, "close_ticket", {
        ticket: 120,
        clientRequestId: key("close-5"),
      }),
      "merged"
    );
    expect(error.details).toMatchObject({ mergedIntoTicketNumber: 101 });
    expect(await pendingRows()).toHaveLength(0);
  });

  it("answers not_found for an unknown ticket", async () => {
    const client = await operator();
    expectError(
      await call(client, "close_ticket", {
        ticket: 99_999,
        clientRequestId: key("close-6"),
      }),
      "not_found"
    );
  });

  it("conflicts on a stale expectedUpdatedAt and requests nothing", async () => {
    const client = await operator();
    const error = expectError(
      await call(client, "close_ticket", {
        ticket: 101,
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        clientRequestId: key("close-7"),
      }),
      "conflict"
    );
    expect(error.details).toMatchObject({ currentUpdatedAt: UPDATED_101 });
    expect(await pendingRows()).toHaveLength(0);
    expect(await requestNotifications()).toHaveLength(0);

    expectOk(
      await call(client, "close_ticket", {
        ticket: 101,
        expectedUpdatedAt: UPDATED_101,
        clientRequestId: key("close-7b"),
      })
    );
    expect(await pendingRows()).toHaveLength(1);
  });

  it("requires a clientRequestId", async () => {
    const client = await operator();
    const r = await callTool(client, "close_ticket", { ticket: 101 });
    expect(r.isError || r.protocolError !== null).toBe(true);
    expect(await pendingRows()).toHaveLength(0);
  });

  it("closes only after the owner approves in Docket, once, and get_action_status follows", async () => {
    const client = await operator();
    const r = expectOk(
      await call(client, "close_ticket", {
        ticket: 101,
        clientRequestId: key("close-8"),
      })
    );
    const requestId = String(r.requestId);
    const before = await effects();

    const waiting = expectOk(
      await call(client, "get_action_status", { requestId })
    );
    expect(waiting).toMatchObject({
      requestId,
      kind: "close",
      status: "pending",
      ticket: { number: 101 },
    });
    expect(waiting.outcome).toBeUndefined();

    // Another agent can't approve it; nothing changes.
    expect((await approve(requestId, "frank")).status).toBe(404);
    expect((await approve(requestId, "bob")).status).toBe(404);
    expect(await effects()).toEqual(before);

    const approved = await approve(requestId, "alice");
    expect(approved).toEqual({
      status: 200,
      body: { status: "approved", outcome: "closed" },
    });
    expect((await ticketState(T_OPEN)).status).toBe("closed");
    const closeActivity = (await activityOn(T_OPEN)).filter(
      (a) => a.action === "ticket_closed"
    );
    expect(closeActivity).toHaveLength(1);
    expect(closeActivity[0].actorId).toBe(ALICE);
    expect(await outboxCount()).toBe(before.outbox + 1);
    expect(
      (await deliveryEvents()).filter((e) => e === "ticket.closed")
    ).toEqual(["ticket.closed"]);

    const done = expectOk(
      await call(client, "get_action_status", { requestId })
    );
    expect(done).toMatchObject({
      requestId,
      kind: "close",
      status: "approved",
      outcome: "closed",
    });
    expect(typeof done.decidedAt).toBe("string");
  });
});

/* ====================================================== retry safety (E) */

describe("retry safety: a ledger row left behind AFTER its request was created", () => {
  async function closeOnce(client: Awaited<ReturnType<typeof operator>>) {
    const k = key("retry-close");
    const first = expectOk(
      await call(client, "close_ticket", { ticket: 101, clientRequestId: k })
    );
    return { k, requestId: String(first.requestId) };
  }

  /** Approve (the ticket closes), then reopen it, as the issue describes. */
  async function approveAndReopen(
    client: Awaited<ReturnType<typeof operator>>,
    requestId: string
  ) {
    expect((await approve(requestId)).status).toBe(200);
    expect((await ticketState(T_OPEN)).status).toBe("closed");
    expectOk(await call(client, "reopen_ticket", { ticket: 101 }));
    expect((await ticketState(T_OPEN)).status).toBe("open");
  }

  async function closeCounts() {
    return {
      closes: (await activityOn(T_OPEN)).filter(
        (a) => a.action === "ticket_closed"
      ).length,
      emails: await outboxCount(),
      closedEvents: (await deliveryEvents()).filter(
        (e) => e === "ticket.closed"
      ).length,
      requests: (await pendingRows()).length,
      notifications: (await requestNotifications()).length,
      audits: (await requestAudits()).length,
    };
  }

  it("close_ticket: a failed row retried after approve + reopen points at the same request and the ticket stays open", async () => {
    const client = await operator();
    const { k, requestId } = await closeOnce(client);
    await rewindLedger("close_ticket", "failed");
    await approveAndReopen(client, requestId);
    const before = await closeCounts();
    expect(before).toMatchObject({ closes: 1, emails: 1, closedEvents: 1 });

    const retry = expectOk(
      await call(client, "close_ticket", { ticket: 101, clientRequestId: k })
    );
    expect(retry.requestId).toBe(requestId);
    expect(retry.status).toBe("awaiting_approval");
    expect(retry.existingRequest).toBeUndefined();
    expect((await ticketState(T_OPEN)).status).toBe("open");
    expect(await closeCounts()).toEqual(before);

    const row = (await ledger()).find((r) => r.tool === "close_ticket");
    expect(row).toMatchObject({
      status: "succeeded",
      attempts: 2,
      resultJson: { requestId },
    });
  });

  it("close_ticket: an expired-lease pending row is reconciled to the same request, no second request", async () => {
    const client = await operator();
    const { k, requestId } = await closeOnce(client);
    await rewindLedger("close_ticket", "lease_expired");
    await approveAndReopen(client, requestId);
    const before = await closeCounts();

    const retry = expectOk(
      await call(client, "close_ticket", { ticket: 101, clientRequestId: k })
    );
    expect(retry.requestId).toBe(requestId);
    expect((await ticketState(T_OPEN)).status).toBe("open");
    expect(await closeCounts()).toEqual(before);
    const row = (await ledger()).find((r) => r.tool === "close_ticket");
    expect(row).toMatchObject({
      status: "succeeded",
      sideEffectsUncertain: false,
      resultJson: { requestId },
    });
  });

  it("close_ticket: a failed row retried while the request is still pending returns it without a second notification", async () => {
    const client = await operator();
    const { k, requestId } = await closeOnce(client);
    await rewindLedger("close_ticket", "failed");
    const retry = expectOk(
      await call(client, "close_ticket", { ticket: 101, clientRequestId: k })
    );
    expect(retry.requestId).toBe(requestId);
    expect(retry.existingRequest).toBeUndefined();
    expect(await pendingRows()).toHaveLength(1);
    expect(await requestNotifications()).toHaveLength(1);
    expect(await requestAudits()).toHaveLength(1);
  });

  describe("reply_to_customer", () => {
    beforeEach(async () => {
      await setReplyGate(world, true);
    });

    async function replyOnce(client: Awaited<ReturnType<typeof operator>>) {
      const k = key("retry-reply");
      const first = expectOk(
        await call(client, "reply_to_customer", {
          ticket: 101,
          body: SEC_BODY,
          clientRequestId: k,
        })
      );
      return { k, requestId: String(first.requestId) };
    }

    async function replyCounts() {
      return {
        comments: (await commentsOn(T_OPEN)).length,
        emails: await outboxCount(),
        replied: (await deliveryEvents()).filter((e) => e === "ticket.replied")
          .length,
        requests: (await pendingRows()).length,
        notifications: (await requestNotifications()).length,
      };
    }

    it("a failed row retried after the reply was approved creates no second request and no comment", async () => {
      const client = await operator();
      const { k, requestId } = await replyOnce(client);
      await rewindLedger("reply_to_customer", "failed");
      expect((await approve(requestId)).status).toBe(200);
      const before = await replyCounts();
      expect(before).toMatchObject({ emails: 1, replied: 1, requests: 1 });

      const retry = expectOk(
        await call(client, "reply_to_customer", {
          ticket: 101,
          body: SEC_BODY,
          clientRequestId: k,
        })
      );
      expect(retry.requestId).toBe(requestId);
      expect(retry.existingRequest).toBeUndefined();
      expect(await replyCounts()).toEqual(before);
    });

    it("an expired-lease pending row is reconciled to the same request, no second request, no comment", async () => {
      const client = await operator();
      const { k, requestId } = await replyOnce(client);
      await rewindLedger("reply_to_customer", "lease_expired");
      expect((await approve(requestId)).status).toBe(200);
      const before = await replyCounts();

      const retry = expectOk(
        await call(client, "reply_to_customer", {
          ticket: 101,
          body: SEC_BODY,
          clientRequestId: k,
        })
      );
      expect(retry.requestId).toBe(requestId);
      expect(await replyCounts()).toEqual(before);
      const row = (await ledger()).find((r) => r.tool === "reply_to_customer");
      expect(row).toMatchObject({
        status: "succeeded",
        resultJson: { requestId },
      });
    });
  });
});

/* ======================================== createPendingAction + the sweeper */

describe("createPendingAction with a planned id", () => {
  it("creates the request under that id, and a re-run returns it without a second notification or audit", async () => {
    const { tokenId } = await connectWith(world, ALICE, OPERATOR_SCOPES);
    const input = {
      id: "planned-request-0001",
      userId: ALICE,
      credentialId: tokenId,
      ticketId: T_OPEN,
      kind: "close" as const,
    };
    const first = await createPendingAction(input);
    expect(first).toMatchObject({
      status: "created",
      action: { id: "planned-request-0001" },
    });
    const again = await createPendingAction(input);
    expect(again).toMatchObject({
      status: "existing",
      action: { id: "planned-request-0001" },
    });
    expect(await pendingRows()).toHaveLength(1);
    expect(await requestNotifications()).toHaveLength(1);
    expect(await requestAudits()).toHaveLength(1);
  });

  it("returns a settled request under that id as it is, whatever its status", async () => {
    const { tokenId } = await connectWith(world, ALICE, OPERATOR_SCOPES);
    const input = {
      id: "planned-request-0002",
      userId: ALICE,
      credentialId: tokenId,
      ticketId: T_OPEN,
      kind: "close" as const,
    };
    await createPendingAction(input);
    expect((await dismiss("planned-request-0002")).status).toBe(200);
    const again = await createPendingAction(input);
    expect(again).toMatchObject({
      status: "existing",
      action: { id: "planned-request-0002", status: "dismissed" },
    });
    expect(await pendingRows()).toHaveLength(1);
  });

  it("still generates an id when none is given", async () => {
    const { tokenId } = await connectWith(world, ALICE, OPERATOR_SCOPES);
    const created = await createPendingAction({
      userId: ALICE,
      credentialId: tokenId,
      ticketId: T_OPEN,
      kind: "close",
    });
    expect(created.status).toBe("created");
    if (created.status === "created") {
      expect(created.action.id).toMatch(/^[a-z0-9]{20,32}$/);
    }
  });
});

describe("the sweeper and close_ticket / reply_to_customer calls", () => {
  it("settles a stuck call whose request exists with that request, and a stuck call without one as interrupted", async () => {
    const client = await operator();
    const requestId = String(
      expectOk(
        await call(client, "close_ticket", {
          ticket: 101,
          clientRequestId: key("sweep-1"),
        })
      ).requestId
    );
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await db
      .update(mcpToolCalls)
      .set({
        status: "pending",
        resultJson: null,
        leaseExpiresAt: old,
        createdAt: old,
        updatedAt: old,
      })
      .where(eq(mcpToolCalls.tool, "close_ticket"));
    await db.insert(mcpToolCalls).values({
      id: "stuck-no-request",
      requestId: "req-stuck",
      userId: ALICE,
      authMethod: "pat",
      credentialId: "cred-x",
      tool: "reply_to_customer",
      clientRequestId: key("sweep-2"),
      status: "pending",
      plannedEntityId: "no-such-request-00000001",
      targetTicketId: T_OPEN,
      leaseExpiresAt: old,
      createdAt: old,
      updatedAt: old,
    });

    await sweepExpiredLeasePendingCalls();

    const rows = await ledger();
    expect(rows.find((r) => r.tool === "close_ticket")).toMatchObject({
      status: "succeeded",
      resultJson: { requestId },
    });
    expect(rows.find((r) => r.id === "stuck-no-request")).toMatchObject({
      status: "failed",
      errorCode: "interrupted",
    });
    expect(await pendingRows()).toHaveLength(1);
  });
});

/* ======================================================= reply_to_customer */

describe("reply_to_customer", () => {
  beforeEach(async () => {
    await setReplyGate(world, true);
  });

  const reply = (
    client: Awaited<ReturnType<typeof operator>>,
    over: Record<string, unknown> = {}
  ) =>
    call(client, "reply_to_customer", {
      ticket: 101,
      body: SEC_BODY,
      clientRequestId: key("reply-1"),
      ...over,
    });

  it("creates a pending reply and sends nothing; the owner's draft is untouched", async () => {
    const draft = {
      ticketId: T_OPEN,
      userId: ALICE,
      content: textToRichTextJson("my half-written draft"),
      isInternal: false,
    };
    await db.insert(ticketReplyDrafts).values(draft);
    const [draftBefore] = await db.select().from(ticketReplyDrafts);
    const client = await operator();
    const before = await effects();

    const r = expectOk(await reply(client));

    const [row] = await pendingRows();
    expect(row).toMatchObject({
      kind: "reply",
      ticketId: T_OPEN,
      requestedById: ALICE,
      status: "pending",
    });
    const content = (row.payload as { content: string }).content;
    expect(content).toBe(textToRichTextJson(SEC_BODY));
    expect(r).toMatchObject({
      status: "awaiting_approval",
      requestId: row.id,
      ticket: { number: 101 },
      approvalNote:
        "The ticket owner must approve this in Docket (ticket page).",
    });
    expect(r.expiresAt).toBe(row.expiresAt.toISOString());
    // No body echo, no portal link: the scan in `call` already passed.
    expect(JSON.stringify(r)).not.toContain(SEC_BODY);

    expect(await effects()).toEqual(before);
    const [draftAfter] = await db.select().from(ticketReplyDrafts);
    expect(draftAfter).toEqual(draftBefore);

    expect(await requestNotifications()).toHaveLength(1);
    // The notification, push and audit never carry the reply text.
    expect(JSON.stringify(await notificationRows())).not.toContain(SEC_BODY);
    expect(JSON.stringify(pushCalls())).not.toContain(SEC_BODY);
    expect(JSON.stringify(await requestAudits())).not.toContain(SEC_BODY);

    // The ledger row holds a keyed hash, never the text.
    const [ledgerRow] = await ledger();
    expect(ledgerRow.bodyHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ledgerRow)).not.toContain(SEC_BODY);
    expect(ledgerRow.lockGroup).toBeNull();
    expect(row.toolCallId).toBe(ledgerRow.id);
  });

  it("replays a repeated key: same request, nothing new", async () => {
    const client = await operator();
    const first = expectOk(await reply(client));
    const again = expectOk(await reply(client));
    expect(again.replayed).toBe(true);
    expect(again.requestId).toBe(first.requestId);
    expect(await pendingRows()).toHaveLength(1);
    expect(await requestNotifications()).toHaveLength(1);
  });

  it("flags a new key with the same text within 10 minutes as duplicate_suspected", async () => {
    const client = await operator();
    const first = expectOk(await reply(client));
    // The first request is decided, so pending-uniqueness can't mask the check.
    expect((await dismiss(String(first.requestId))).status).toBe(200);

    const error = expectError(
      await reply(client, { clientRequestId: key("reply-2") }),
      "duplicate_suspected"
    );
    expect(error.details).toMatchObject({ requestId: first.requestId });
    expect(await pendingRows()).toHaveLength(1);

    // Whitespace-only differences are still the same text.
    expectError(
      await reply(client, {
        body: `  ${SEC_BODY}\n`,
        clientRequestId: key("reply-3"),
      }),
      "duplicate_suspected"
    );

    // A different text is fine.
    const other = expectOk(
      await reply(client, {
        body: `${SEC_BODY} but different`,
        clientRequestId: key("reply-4"),
      })
    );
    expect(other.requestId).not.toBe(first.requestId);
    expect(await pendingRows()).toHaveLength(2);
  });

  it("does not flag the same text once the earlier call is older than 10 minutes", async () => {
    const client = await operator();
    const first = expectOk(await reply(client));
    expect((await dismiss(String(first.requestId))).status).toBe(200);
    await db
      .update(mcpToolCalls)
      .set({ createdAt: new Date(Date.now() - 11 * 60 * 1000) })
      .where(eq(mcpToolCalls.tool, "reply_to_customer"));
    expectOk(await reply(client, { clientRequestId: key("reply-5") }));
    expect(await pendingRows()).toHaveLength(2);
  });

  it("does not flag the same text sent by another agent", async () => {
    const client = await operator();
    const other = await operator(FRANK);
    expectOk(await reply(client));
    expectOk(await reply(other, { clientRequestId: key("reply-6") }));
    expect(await pendingRows()).toHaveLength(2);
  });

  it("returns the pending reply for another text without replacing it, and says so", async () => {
    const client = await operator();
    const first = expectOk(await reply(client));
    const second = expectOk(
      await reply(client, {
        body: "A completely different answer",
        clientRequestId: key("reply-7"),
      })
    );
    expect(second.requestId).toBe(first.requestId);
    expect(second.existingRequest).toBe(true);
    expect(String(second.approvalNote)).toContain("did not replace");
    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as { content: string }).content).toBe(
      textToRichTextJson(SEC_BODY)
    );
    expect(await requestNotifications()).toHaveLength(1);
  });

  it("limits a user to 10 reply calls a minute", async () => {
    // The limit is a fixed clock-minute window: start early in one.
    const into = Date.now() % 60_000;
    if (into > 35_000) {
      await new Promise((resolve) => setTimeout(resolve, 60_000 - into + 500));
    }
    const client = await operator();
    for (let i = 0; i < 10; i++) {
      expectOk(
        await reply(client, {
          body: `${SEC_BODY} ${i}`,
          clientRequestId: key(`limit-${i}`),
        })
      );
    }
    const error = expectError(
      await reply(client, {
        body: `${SEC_BODY} 11th`,
        clientRequestId: key("limit-11"),
      }),
      "rate_limited"
    );
    expect(error.details?.retryAfterSeconds).toEqual(expect.any(Number));
    expect(Number(error.details?.retryAfterSeconds)).toBeGreaterThanOrEqual(1);
    expect(Number(error.details?.retryAfterSeconds)).toBeLessThanOrEqual(60);
    // The limit is per user.
    const other = await operator(FRANK);
    expectOk(await reply(other, { clientRequestId: key("limit-frank") }));
  }, 60_000);

  it("limits a user to 100 reply calls a day", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    await db.insert(rateLimitHits).values({
      bucketKey: `mcp_replies_day:${ALICE}`,
      windowStart: new Date(Math.floor(Date.now() / dayMs) * dayMs),
      count: 100,
    });
    const client = await operator();
    const error = expectError(await reply(client), "rate_limited");
    expect(Number(error.details?.retryAfterSeconds)).toBeGreaterThan(0);
    expect(Number(error.details?.retryAfterSeconds)).toBeLessThanOrEqual(
      86_400
    );
    expect(await pendingRows()).toHaveLength(0);
  });

  it("answers ticket_closed for a closed ticket and requests nothing", async () => {
    const client = await operator();
    const error = expectError(
      await reply(client, { ticket: 107 }),
      "ticket_closed"
    );
    expect(error.details).toMatchObject({ ticketNumber: 107 });
    expect(await pendingRows()).toHaveLength(0);
  });

  it("forwards a merged ticket to the one it was merged into and says so", async () => {
    const client = await operator();
    const r = expectOk(await reply(client, { ticket: 120 }));
    expect(r).toMatchObject({
      ticket: { number: 101 },
      mergedFrom: { requested: "#120" },
    });
    const [row] = await pendingRows();
    expect(row.ticketId).toBe(T_OPEN);
    expect(T_MERGED).not.toBe(row.ticketId);
  });

  it("rejects a body with no visible text", async () => {
    const client = await operator();
    expectError(
      await reply(client, { body: "<p> </p>", format: "html" }),
      "invalid_input"
    );
    expect(await pendingRows()).toHaveLength(0);
  });

  it("conflicts on a stale expectedUpdatedAt", async () => {
    const client = await operator();
    const error = expectError(
      await reply(client, { expectedUpdatedAt: "2026-01-01T00:00:00.000Z" }),
      "conflict"
    );
    expect(error.details).toMatchObject({ currentUpdatedAt: UPDATED_101 });
    expect(await pendingRows()).toHaveLength(0);
  });

  it("accepts html and keeps its formatting", async () => {
    const client = await operator();
    expectOk(
      await reply(client, {
        body: `<p>Hello <strong>${SEC_BODY}</strong></p>`,
        format: "html",
      })
    );
    const [row] = await pendingRows();
    expect((row.payload as { content: string }).content).toContain("bold");
  });

  it("sends exactly one public comment and one reply email only when the owner approves", async () => {
    const client = await operator();
    const r = expectOk(await reply(client));
    const requestId = String(r.requestId);
    const before = await effects();

    const approved = await approve(requestId);
    expect(approved).toEqual({
      status: 200,
      body: { status: "approved", outcome: "replied" },
    });

    const comments = await commentsOn(T_OPEN);
    expect(comments).toHaveLength(before.comments + 1);
    const sent = comments.at(-1);
    expect(sent).toMatchObject({
      authorId: ALICE,
      isInternal: false,
      content: textToRichTextJson(SEC_BODY),
    });
    expect(await outboxCount()).toBe(before.outbox + 1);
    expect(
      (await deliveryEvents()).filter((e) => e === "ticket.replied")
    ).toHaveLength(1);

    const done = expectOk(
      await call(client, "get_action_status", { requestId })
    );
    expect(done).toMatchObject({
      kind: "reply",
      status: "approved",
      outcome: "replied",
      commentId: sent?.id,
    });
    expect(JSON.stringify(done)).not.toContain(SEC_BODY);
  });

  it("answers disabled when the setting is turned off after the server was built", async () => {
    // The endpoint builds the server per request; here a server built while the
    // setting was on is called after an admin turned it off.
    const { InMemoryTransport } = await import("@modelcontextprotocol/server");
    const { Client } = await import("@modelcontextprotocol/client");
    const principal: McpPrincipal = {
      userId: ALICE,
      name: USERS.alice.name,
      email: USERS.alice.email,
      role: "agent",
      scopes: ["tickets:read", "tickets:reply"],
      authMethod: "pat",
      credentialId: "cred-inline",
      credentialName: "inline",
      credentialExpiresAt: new Date(Date.now() + 86_400_000),
    };
    const server = createDocketMcpServer(principal, "req-inline", {
      customerRepliesEnabled: true,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const inline = new Client({ name: "inline", version: "0.0.0" });
    await server.connect(serverSide);
    await inline.connect(clientSide);
    await setReplyGate(world, false);

    const r = await callTool(inline, "reply_to_customer", {
      ticket: 101,
      body: SEC_BODY,
      clientRequestId: key("inline-1"),
    });
    expectError(r, "disabled");
    expect(await pendingRows()).toHaveLength(0);
    await inline.close();
  });
});

/* ===================================================== get_action_status */

describe("get_action_status", () => {
  beforeEach(async () => {
    await setReplyGate(world, true);
  });

  async function makeClose(
    client: Awaited<ReturnType<typeof operator>>,
    n = "g",
    ticket = 101
  ) {
    return String(
      expectOk(
        await call(client, "close_ticket", {
          ticket,
          clientRequestId: key(`status-${n}`),
        })
      ).requestId
    );
  }

  const status = (
    client: Awaited<ReturnType<typeof operator>>,
    requestId: string
  ) => call(client, "get_action_status", { requestId });

  it("reports a pending request without any content", async () => {
    const client = await operator();
    const requestId = await makeClose(client);
    const r = expectOk(await status(client, requestId));
    expect(r).toMatchObject({
      requestId,
      kind: "close",
      status: "pending",
      ticket: { number: 101, agentUrl: "http://localhost:3000/tickets/101" },
    });
    expect(Object.keys(r).sort()).toEqual(
      ["createdAt", "expiresAt", "kind", "requestId", "status", "ticket"].sort()
    );
  });

  it("reports a pending request past its expiry as expired", async () => {
    const client = await operator();
    const requestId = await makeClose(client);
    await db
      .update(mcpPendingActions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(mcpPendingActions.id, requestId));
    expect(expectOk(await status(client, requestId)).status).toBe("expired");
    // The row itself is only settled by the sweeper.
    expect((await pendingRow(requestId)).status).toBe("pending");
  });

  it("reports dismissed, cancelled and failed with their reasons", async () => {
    const client = await operator();
    const dismissed = await makeClose(client, "d");
    expect((await dismiss(dismissed)).status).toBe(200);
    const d = expectOk(await status(client, dismissed));
    expect(d.status).toBe("dismissed");
    expect(typeof d.decidedAt).toBe("string");

    const cancelled = await makeClose(client, "c");
    await db
      .update(mcpPendingActions)
      .set({ status: "cancelled", statusReason: "ticket_merged" })
      .where(eq(mcpPendingActions.id, cancelled));
    expect(expectOk(await status(client, cancelled))).toMatchObject({
      status: "cancelled",
      reason: "ticket_merged",
    });

    const failed = await makeClose(client, "f");
    await db
      .update(mcpPendingActions)
      .set({
        status: "failed",
        statusReason: "interrupted",
        sideEffectsUncertain: true,
      })
      .where(eq(mcpPendingActions.id, failed));
    expect(expectOk(await status(client, failed))).toMatchObject({
      status: "failed",
      reason: "interrupted",
      sideEffectsUncertain: true,
    });
  });

  it("derives the outcome of an approved request from its result", async () => {
    const client = await operator();
    const closed = await makeClose(client, "o1");
    expect((await approve(closed)).status).toBe(200);
    expect(expectOk(await status(client, closed))).toMatchObject({
      status: "approved",
      outcome: "closed",
    });

    // already_closed: the ticket was closed by someone else before approval.
    const reopen = await makeClose(client, "o2", 105);
    await db
      .update(mcpPendingActions)
      .set({
        status: "approved",
        decidedAt: new Date(),
        result: { alreadyClosed: true },
      })
      .where(eq(mcpPendingActions.id, reopen));
    expect(expectOk(await status(client, reopen))).toMatchObject({
      status: "approved",
      outcome: "already_closed",
    });
  });

  it("answers an unknown id and another user's request identically", async () => {
    const mine = await operator();
    const theirs = await operator(FRANK);
    const requestId = await makeClose(mine, "x");

    const other = expectError(await status(theirs, requestId), "not_found");
    const unknown = expectError(
      await status(theirs, "does-not-exist-00000000"),
      "not_found"
    );
    expect(other).toEqual(unknown);
    // Not even an admin can read it through this tool.
    const admin = await operator(BOB);
    expect(expectError(await status(admin, requestId), "not_found")).toEqual(
      unknown
    );
  });

  it("is read-only: no idempotency claim and no request side effects", async () => {
    const client = await operator();
    const requestId = await makeClose(client, "r");
    const before = await effects();
    const requestsBefore = await pendingRows();
    expectOk(await status(client, requestId));
    expect(await effects()).toEqual(before);
    expect(await pendingRows()).toEqual(requestsBefore);
    const row = (await ledger()).find((r) => r.tool === "get_action_status");
    expect(row).toMatchObject({
      clientRequestId: null,
      plannedEntityId: null,
      lockGroup: null,
    });
  });

  it("works for a token that only holds tickets:reply", async () => {
    const owner = await operator();
    const requestId = await makeClose(owner, "s");
    const { client } = await connectWith(world, ALICE, [
      "tickets:read",
      "tickets:reply",
    ]);
    expect(expectOk(await status(client, requestId)).status).toBe("pending");
  });
});

/* ============================================================ audit etc. */

describe("outputs", () => {
  it("never carry the customer token, a portal link or a storage key", async () => {
    await setReplyGate(world, true);
    const client = await operator();
    const outputs = [
      await call(client, "close_ticket", {
        ticket: 101,
        clientRequestId: key("out-1"),
      }),
      await call(client, "reply_to_customer", {
        ticket: 105,
        body: SEC_BODY,
        clientRequestId: key("out-2"),
      }),
      await call(client, "assign_ticket", { ticket: 105, assignee: FRANK }),
      await call(client, "set_ticket_status", {
        ticket: 105,
        status: "in_progress",
      }),
      await call(client, "reopen_ticket", { ticket: 107 }),
    ];
    for (const o of outputs) {
      expectOk(o);
      for (const forbidden of ["token-", "/ticket/", "token=", "storage"]) {
        expect(o.text).not.toContain(forbidden);
      }
    }
  });
});
