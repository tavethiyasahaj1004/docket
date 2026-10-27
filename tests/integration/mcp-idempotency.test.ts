import { and, sql as dsql, eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  emailOutbox,
  mcpToolCalls,
  ticketActivity,
  ticketComments,
  webhookDeliveries,
} from "@/db/schema";
import { db } from "@/lib/db";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { McpToolError } from "@/lib/mcp/errors";
import {
  claimWriteCall,
  finalizeWriteCall,
  PlannedEntityExistsError,
  runIdempotentWrite,
  takeOverExpiredCall,
  violatedIndex,
  type WriteCallContext,
  type WriteClaim,
} from "@/lib/mcp/idempotency";
import { MCP_WRITE_LEASE_MS } from "@/lib/mcp/limits";
import { reconcileCommentCall } from "@/lib/mcp/reconcile";
import { hmacToolArgs } from "@/lib/mcp/safe-handler";
import {
  addTicketComment,
  loadCommentTarget,
} from "@/lib/tickets/services/comments";
import type { ServiceActor } from "@/lib/tickets/services/types";
import { openWorkerTestConnection } from "./characterization/helpers";
import { resetMocks, seedWriteWorld } from "./characterization/write-helpers";
import { doc, tid, USERS } from "./fixtures";
import type { Sql } from "./guard";

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
const BIG = 1_000_000_000;

let counter = 0;
function ctxFor(over: Partial<WriteCallContext> = {}): WriteCallContext {
  counter += 1;
  return {
    principal,
    requestId: `req-${counter}`,
    tool: "reply_to_customer",
    args: { ticket: "t-101", body: "Hello" },
    clientRequestId: "key-1",
    lockGroup: "ticket_state",
    targetTicketId: tid(101),
    ...over,
  };
}

let probe: Sql;
beforeAll(() => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL is not set.");
  }
  probe = openWorkerTestConnection(url);
});
afterAll(async () => {
  await probe?.end({ timeout: 5 });
});
beforeEach(async () => {
  resetMocks();
  counter = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await seedWriteWorld();
  baseline = await rawCounts();
  return () => {
    vi.restoreAllMocks();
  };
});

const callRows = () => db.select().from(mcpToolCalls);
async function onlyRow() {
  const rows = await callRows();
  expect(rows).toHaveLength(1);
  return rows[0];
}
const expireLease = (id: string) =>
  db
    .update(mcpToolCalls)
    .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
    .where(eq(mcpToolCalls.id, id));

function claimedOrThrow(
  result: Awaited<ReturnType<typeof claimWriteCall>>
): WriteClaim {
  if (result.kind !== "claimed") {
    throw new Error(`expected claimed, got ${result.kind}`);
  }
  return result.claim;
}

type Counts = {
  comments: number;
  activity: number;
  deliveries: number;
  outbox: number;
};

// The seeded world already has comments and activity: counts are reported
// relative to the state right after seeding.
let baseline: Counts = { comments: 0, activity: 0, deliveries: 0, outbox: 0 };

async function rawCounts(): Promise<Counts> {
  const [[comments], [activity], [deliveries], [outbox]] = await Promise.all([
    db.select({ n: dsql<number>`count(*)::int` }).from(ticketComments),
    db.select({ n: dsql<number>`count(*)::int` }).from(ticketActivity),
    db.select({ n: dsql<number>`count(*)::int` }).from(webhookDeliveries),
    db.select({ n: dsql<number>`count(*)::int` }).from(emailOutbox),
  ]);
  return {
    comments: comments.n,
    activity: activity.n,
    deliveries: deliveries.n,
    outbox: outbox.n,
  };
}

async function counts(): Promise<Counts> {
  const now = await rawCounts();
  return {
    comments: now.comments - baseline.comments,
    activity: now.activity - baseline.activity,
    deliveries: now.deliveries - baseline.deliveries,
    outbox: now.outbox - baseline.outbox,
  };
}

/** The reply a future reply_to_customer tool would send: a public agent reply
 * whose comment id is the call's planned id. */
async function sendReply(plannedEntityId: string) {
  const target = await loadCommentTarget(tid(101));
  if (!target) {
    throw new Error("seed ticket missing");
  }
  const result = await addTicketComment({
    ticketId: tid(101),
    target,
    actor,
    content: doc("Thanks, on it."),
    contentText: "Thanks, on it.",
    isInternal: false,
    attachments: [],
    maxPerTicketSizeBytes: BIG,
    commentId: plannedEntityId,
  });
  if (result.status === "exists") {
    throw new PlannedEntityExistsError();
  }
  if (result.status !== "ok") {
    throw new Error(`unexpected ${result.status}`);
  }
  await result.email;
  return { result: { commentId: result.commentId } };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("claimWriteCall: a fresh claim", () => {
  it("inserts a pending row with a lease, a planned id and only HMACs", async () => {
    const ctx = ctxFor({ bodyHmac: "b".repeat(64) });
    const before = Date.now();
    const claim = claimedOrThrow(await claimWriteCall(ctx));
    const row = await onlyRow();
    expect(row).toMatchObject({
      id: claim.id,
      status: "pending",
      attempts: 1,
      plannedEntityId: claim.plannedEntityId,
      userId: USERS.alice.id,
      tool: "reply_to_customer",
      clientRequestId: "key-1",
      lockGroup: "ticket_state",
      targetTicketId: tid(101),
      bodyHmac: "b".repeat(64),
      argsHmac: hmacToolArgs(ctx.args),
      errorCode: null,
      resultJson: null,
      sideEffectsUncertain: false,
      notificationErrors: null,
    });
    expect(claim.plannedEntityId).toMatch(/^[a-z0-9]{24}$/);
    const lease = row.leaseExpiresAt?.getTime() ?? 0;
    expect(lease).toBeGreaterThanOrEqual(before + MCP_WRITE_LEASE_MS - 50);
    expect(lease).toBeLessThanOrEqual(Date.now() + MCP_WRITE_LEASE_MS);
    expect(JSON.stringify(row)).not.toContain("Hello");
  });

  it("claims a call without a client request id too (for the lock)", async () => {
    const ctx = ctxFor({ clientRequestId: undefined });
    claimedOrThrow(await claimWriteCall(ctx));
    const row = await onlyRow();
    expect(row.clientRequestId).toBeNull();
    expect(row.status).toBe("pending");
    // The lock still applies to a second keyless call on the same ticket.
    expect(
      await claimWriteCall(ctxFor({ clientRequestId: undefined }))
    ).toMatchObject({ kind: "in_progress" });
  });

  it("calls without a lock group never block each other", async () => {
    const free = { lockGroup: undefined, targetTicketId: undefined };
    claimedOrThrow(
      await claimWriteCall(ctxFor({ ...free, clientRequestId: "a" }))
    );
    claimedOrThrow(
      await claimWriteCall(ctxFor({ ...free, clientRequestId: "b" }))
    );
    expect(await callRows()).toHaveLength(2);
  });

  it("rejects a lock group without a target ticket", async () => {
    await expect(
      claimWriteCall(ctxFor({ targetTicketId: undefined }))
    ).rejects.toThrow(/go together/);
  });
});

describe("claimWriteCall: the 7.3 table", () => {
  it("a different argsHmac under the same key is idempotency_key_reused", async () => {
    const claim = claimedOrThrow(await claimWriteCall(ctxFor()));
    await finalizeWriteCall(claim, { status: "succeeded", result: {} });
    const result = await claimWriteCall(ctxFor({ args: { body: "other" } }));
    expect(result).toMatchObject({
      kind: "error",
      error: { code: "idempotency_key_reused" },
    });
  });

  it("key reuse is detected whatever the row's state", async () => {
    claimedOrThrow(await claimWriteCall(ctxFor())); // still pending
    const result = await claimWriteCall(ctxFor({ args: { body: "other" } }));
    expect(result).toMatchObject({
      kind: "error",
      error: { code: "idempotency_key_reused" },
    });
  });

  it("succeeded replays the stored result with replayed: true", async () => {
    const claim = claimedOrThrow(await claimWriteCall(ctxFor()));
    await finalizeWriteCall(claim, {
      status: "succeeded",
      result: { commentId: "c1", note: "free text dropped" },
      notificationErrors: ["email_not_queued"],
    });
    const result = await claimWriteCall(ctxFor());
    expect(result).toEqual({
      kind: "replay",
      result: { commentId: "c1", replayed: true },
      sideEffectsUncertain: false,
      notificationErrors: ["email_not_queued"],
    });
    expect(await callRows()).toHaveLength(1);
  });

  it.each([
    "invalid_input",
    "not_found",
    "merged",
    "ticket_closed",
    "ticket_open",
    "conflict",
    "draft_exists",
    "disabled",
    "rate_limited",
  ] as const)("failed %s replays the same structured error", async (code) => {
    const claim = claimedOrThrow(await claimWriteCall(ctxFor()));
    await finalizeWriteCall(claim, {
      status: "failed",
      errorCode: code,
      error: {
        code,
        message: "Written for the model.",
        details: { ticketNumber: 12 },
      },
    });
    expect(await claimWriteCall(ctxFor())).toEqual({
      kind: "error",
      error: {
        code,
        message: "Written for the model.",
        details: { ticketNumber: 12 },
      },
    });
    expect((await onlyRow()).status).toBe("failed");
  });

  it.each([
    "internal",
    "interrupted",
  ] as const)("failed %s goes back to pending with attempts+1 and the same planned id", async (code) => {
    const first = claimedOrThrow(await claimWriteCall(ctxFor()));
    await finalizeWriteCall(first, { status: "failed", errorCode: code });
    const result = await claimWriteCall(ctxFor({ requestId: "req-retry" }));
    const second = claimedOrThrow(result);
    expect(second.id).toBe(first.id);
    expect(second.plannedEntityId).toBe(first.plannedEntityId);
    expect(second.attempts).toBe(2);
    const row = await onlyRow();
    expect(row).toMatchObject({
      status: "pending",
      attempts: 2,
      errorCode: null,
      resultJson: null,
      requestId: "req-retry",
      plannedEntityId: first.plannedEntityId,
    });
    expect(row.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("pending with an active lease is in_progress with retryAfterSeconds", async () => {
    claimedOrThrow(await claimWriteCall(ctxFor()));
    const result = await claimWriteCall(ctxFor());
    expect(result.kind).toBe("in_progress");
    if (result.kind === "in_progress") {
      expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(58);
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it("retryAfterSeconds is at least 1 near the end of the lease", async () => {
    claimedOrThrow(await claimWriteCall(ctxFor()));
    const now = new Date(Date.now() + MCP_WRITE_LEASE_MS - 100);
    const result = await claimWriteCall(ctxFor({ now }));
    expect(result).toEqual({ kind: "in_progress", retryAfterSeconds: 1 });
  });

  it("pending with an expired lease asks to reconcile", async () => {
    const claim = claimedOrThrow(await claimWriteCall(ctxFor()));
    await expireLease(claim.id);
    const result = await claimWriteCall(ctxFor());
    expect(result.kind).toBe("reconcile");
    if (result.kind === "reconcile") {
      expect(result.row).toMatchObject({
        id: claim.id,
        plannedEntityId: claim.plannedEntityId,
        status: "pending",
        attempts: 1,
      });
    }
  });

  it("the key is scoped to user and tool", async () => {
    claimedOrThrow(await claimWriteCall(ctxFor()));
    claimedOrThrow(
      await claimWriteCall(
        ctxFor({
          principal: { ...principal, userId: USERS.bob.id },
          targetTicketId: tid(102),
        })
      )
    );
    claimedOrThrow(
      await claimWriteCall(
        ctxFor({
          tool: "add_internal_note",
          lockGroup: undefined,
          targetTicketId: undefined,
        })
      )
    );
    expect(await callRows()).toHaveLength(3);
  });
});

describe("takeOverExpiredCall", () => {
  it("moves an expired pending row to a new lease, attempts+1, same planned id", async () => {
    const first = claimedOrThrow(await claimWriteCall(ctxFor()));
    await expireLease(first.id);
    const [row] = await callRows();
    const taken = await takeOverExpiredCall(row, new Date(), "req-takeover");
    expect(taken).toMatchObject({
      id: first.id,
      plannedEntityId: first.plannedEntityId,
      attempts: 2,
    });
    const after = await onlyRow();
    expect(after).toMatchObject({
      status: "pending",
      attempts: 2,
      requestId: "req-takeover",
    });
    expect(after.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("returns null when another worker won (stale attempts)", async () => {
    const first = claimedOrThrow(await claimWriteCall(ctxFor()));
    await expireLease(first.id);
    const [stale] = await callRows();
    expect(await takeOverExpiredCall(stale)).not.toBeNull();
    // The second worker still holds the row it read before the first took over.
    expect(await takeOverExpiredCall(stale)).toBeNull();
    expect((await onlyRow()).attempts).toBe(2);
  });

  it("returns null while the lease is still active", async () => {
    claimedOrThrow(await claimWriteCall(ctxFor()));
    const [row] = await callRows();
    expect(await takeOverExpiredCall(row)).toBeNull();
    expect((await onlyRow()).attempts).toBe(1);
  });

  it("two parallel takeovers: exactly one wins", async () => {
    const first = claimedOrThrow(await claimWriteCall(ctxFor()));
    await expireLease(first.id);
    const [row] = await callRows();
    const results = await Promise.all([
      takeOverExpiredCall(row),
      takeOverExpiredCall(row),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("finalizeWriteCall", () => {
  it("applies once, only while pending under the claim's attempt", async () => {
    const claim = claimedOrThrow(await claimWriteCall(ctxFor()));
    expect(
      await finalizeWriteCall(claim, {
        status: "succeeded",
        result: { commentId: "c1" },
        sideEffectsUncertain: true,
        notificationErrors: ["webhook_dispatch_failed"],
      })
    ).toBe(true);
    const row = await onlyRow();
    expect(row).toMatchObject({
      status: "succeeded",
      errorCode: null,
      resultJson: { commentId: "c1" },
      sideEffectsUncertain: true,
      notificationErrors: ["webhook_dispatch_failed"],
    });
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    // A second finalize (a slow duplicate) changes nothing.
    expect(
      await finalizeWriteCall(claim, {
        status: "failed",
        errorCode: "internal",
      })
    ).toBe(false);
    expect((await onlyRow()).status).toBe("succeeded");
  });

  it("does not apply after a takeover bumped the attempt", async () => {
    const first = claimedOrThrow(await claimWriteCall(ctxFor()));
    await expireLease(first.id);
    const [row] = await callRows();
    await takeOverExpiredCall(row);
    expect(
      await finalizeWriteCall(first, { status: "succeeded", result: {} })
    ).toBe(false);
    expect((await onlyRow()).status).toBe("pending");
  });

  it("stores empty notification errors as null and keeps uncertainty sticky", async () => {
    const first = claimedOrThrow(await claimWriteCall(ctxFor()));
    await finalizeWriteCall(first, {
      status: "failed",
      errorCode: "internal",
      sideEffectsUncertain: true,
    });
    const second = claimedOrThrow(await claimWriteCall(ctxFor()));
    await finalizeWriteCall(second, {
      status: "succeeded",
      result: {},
      notificationErrors: [],
    });
    const row = await onlyRow();
    expect(row.notificationErrors).toBeNull();
    expect(row.sideEffectsUncertain).toBe(true);
  });

  it("sanitizes the stored result to ids, numbers, booleans and slugs", async () => {
    const claim = claimedOrThrow(await claimWriteCall(ctxFor()));
    await finalizeWriteCall(claim, {
      status: "succeeded",
      result: {
        commentId: "c1",
        count: 2,
        body: "Dear Ann, here is your refund",
        email: "ann@example.test",
        long: "x".repeat(65),
      },
    });
    expect((await onlyRow()).resultJson).toEqual({ commentId: "c1", count: 2 });
  });
});

describe("concurrency", () => {
  it("two parallel claims with the same key: exactly one claimed", async () => {
    const results = await Promise.all([
      claimWriteCall(ctxFor()),
      claimWriteCall(ctxFor()),
    ]);
    expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "in_progress")).toHaveLength(1);
    expect(await callRows()).toHaveLength(1);
  });

  it("two parallel claims on one ticket with different keys: one claimed, one in_progress", async () => {
    const results = await Promise.all([
      claimWriteCall(ctxFor({ clientRequestId: "key-a" })),
      claimWriteCall(ctxFor({ clientRequestId: "key-b" })),
    ]);
    expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
    const blocked = results.find((r) => r.kind === "in_progress");
    expect(blocked).toMatchObject({ kind: "in_progress" });
    if (blocked?.kind === "in_progress") {
      expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
    expect(await callRows()).toHaveLength(1);
  });

  it("the lock is per ticket and frees on finalize", async () => {
    const a = claimedOrThrow(
      await claimWriteCall(ctxFor({ clientRequestId: "key-a" }))
    );
    // Another ticket is unaffected.
    claimedOrThrow(
      await claimWriteCall(
        ctxFor({ clientRequestId: "key-c", targetTicketId: tid(102) })
      )
    );
    expect(
      await claimWriteCall(ctxFor({ clientRequestId: "key-b" }))
    ).toMatchObject({ kind: "in_progress" });

    await finalizeWriteCall(a, { status: "succeeded", result: {} });
    claimedOrThrow(await claimWriteCall(ctxFor({ clientRequestId: "key-b" })));
  });

  it("a failed call frees the lock as well", async () => {
    const a = claimedOrThrow(
      await claimWriteCall(ctxFor({ clientRequestId: "key-a" }))
    );
    await finalizeWriteCall(a, { status: "failed", errorCode: "conflict" });
    claimedOrThrow(await claimWriteCall(ctxFor({ clientRequestId: "key-b" })));
  });

  it("retrying a failed internal call while another call holds the ticket lock is in_progress", async () => {
    const a = claimedOrThrow(
      await claimWriteCall(ctxFor({ clientRequestId: "key-a" }))
    );
    await finalizeWriteCall(a, { status: "failed", errorCode: "internal" });
    claimedOrThrow(await claimWriteCall(ctxFor({ clientRequestId: "key-b" })));
    const retry = await claimWriteCall(ctxFor({ clientRequestId: "key-a" }));
    expect(retry.kind).toBe("in_progress");
    // The failed row was not moved.
    const [row] = await db
      .select()
      .from(mcpToolCalls)
      .where(eq(mcpToolCalls.id, a.id));
    expect(row).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("two parallel retries of one failed internal call: exactly one claimed", async () => {
    const a = claimedOrThrow(await claimWriteCall(ctxFor()));
    await finalizeWriteCall(a, { status: "failed", errorCode: "internal" });
    const results = await Promise.all([
      claimWriteCall(ctxFor()),
      claimWriteCall(ctxFor()),
    ]);
    expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "in_progress")).toHaveLength(1);
    expect((await onlyRow()).attempts).toBe(2);
  });

  it("a same-key retry of a crashed call reconciles even though it holds the lock", async () => {
    const a = claimedOrThrow(await claimWriteCall(ctxFor()));
    await expireLease(a.id);
    expect(await claimWriteCall(ctxFor())).toMatchObject({
      kind: "reconcile",
    });
    // A different key on the same ticket stays blocked.
    expect(
      await claimWriteCall(ctxFor({ clientRequestId: "other" }))
    ).toMatchObject({ kind: "in_progress" });
  });
});

describe("how the two unique indexes are told apart", () => {
  async function insertRaw(over: Record<string, unknown>) {
    return await db.insert(mcpToolCalls).values({
      requestId: "r",
      userId: USERS.alice.id,
      authMethod: "pat",
      tool: "t",
      status: "pending",
      ...over,
    });
  }

  it("reads the constraint name off the driver error behind Drizzle's wrapper", async () => {
    await insertRaw({
      clientRequestId: "k",
      lockGroup: "ticket_state",
      targetTicketId: "tt",
    });
    const idem = await insertRaw({ clientRequestId: "k" }).catch(
      (e: unknown) => e
    );
    const lock = await insertRaw({
      clientRequestId: "other",
      lockGroup: "ticket_state",
      targetTicketId: "tt",
    }).catch((e: unknown) => e);
    expect(violatedIndex(idem)).toBe("idempotency");
    expect(violatedIndex(lock)).toBe("ticket_lock");
    expect(
      (idem as { cause?: { constraint_name?: string } }).cause?.constraint_name
    ).toBe("mcp_tool_calls_idempotency_idx");
  });
});

describe("the claim is committed before the write runs", () => {
  it("is visible to a second connection from inside execute", async () => {
    let seen: Array<Record<string, unknown>> = [];
    let planned = "";
    const outcome = await runIdempotentWrite(ctxFor(), {
      execute: async (plannedEntityId) => {
        planned = plannedEntityId;
        seen = await probe`
          SELECT status, planned_entity_id, attempts
          FROM mcp_tool_calls WHERE client_request_id = 'key-1'`;
        return { result: { done: true } };
      },
    });
    expect(seen).toEqual([
      { status: "pending", planned_entity_id: planned, attempts: 1 },
    ]);
    expect(outcome).toMatchObject({ kind: "succeeded", replayed: false });
    expect((await onlyRow()).status).toBe("succeeded");
  });

  it("a concurrent retry from inside execute sees in_progress", async () => {
    let inner: Awaited<ReturnType<typeof runIdempotentWrite>> | undefined;
    const run = vi.fn(async () => ({ result: { done: true } }));
    await runIdempotentWrite(ctxFor(), {
      execute: async () => {
        inner = await runIdempotentWrite(ctxFor(), { execute: run });
        return { result: { done: true } };
      },
    });
    expect(run).not.toHaveBeenCalled();
    expect(inner).toMatchObject({
      kind: "failed",
      error: { code: "in_progress" },
    });
    if (inner?.kind === "failed") {
      expect(inner.error.details?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("runIdempotentWrite: success and replay", () => {
  it("executes once and replays the stored result on a repeat", async () => {
    const execute = vi.fn(async () => ({
      result: { commentId: "c1" },
      notificationErrors: ["email_not_queued" as const],
    }));
    const first = await runIdempotentWrite(ctxFor(), { execute });
    expect(first).toEqual({
      kind: "succeeded",
      result: { commentId: "c1" },
      replayed: false,
      sideEffectsUncertain: false,
      notificationErrors: ["email_not_queued"],
    });
    const second = await runIdempotentWrite(ctxFor(), { execute });
    expect(second).toEqual({
      kind: "succeeded",
      result: { commentId: "c1", replayed: true },
      replayed: true,
      sideEffectsUncertain: false,
      notificationErrors: ["email_not_queued"],
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await callRows()).toHaveLength(1);
  });

  it("passes the planned id to execute and stores a sanitized result", async () => {
    let planned = "";
    await runIdempotentWrite(ctxFor(), {
      execute: async (id) => {
        planned = id;
        return { result: { commentId: id, body: "free text" } };
      },
    });
    const row = await onlyRow();
    expect(row.plannedEntityId).toBe(planned);
    expect(row.resultJson).toEqual({ commentId: planned });
  });

  it("a key reused with other arguments never executes", async () => {
    const execute = vi.fn(async () => ({ result: {} }));
    await runIdempotentWrite(ctxFor(), { execute });
    const outcome = await runIdempotentWrite(ctxFor({ args: { x: 1 } }), {
      execute,
    });
    expect(outcome).toMatchObject({
      kind: "failed",
      error: { code: "idempotency_key_reused" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("runIdempotentWrite: errors", () => {
  it("an McpToolError fails the row with its code and replays its structured error", async () => {
    const execute = vi.fn(async () => {
      throw new McpToolError("merged", "This ticket was merged into #7.", {
        mergedIntoTicketNumber: 7,
        // not on the allowlist: dropped before it is stored
        secret: "leak",
      } as never);
    });
    const first = await runIdempotentWrite(ctxFor(), { execute });
    const expected = {
      code: "merged",
      message: "This ticket was merged into #7.",
      details: { mergedIntoTicketNumber: 7 },
    };
    expect(first).toEqual({ kind: "failed", error: expected, replayed: false });

    const row = await onlyRow();
    expect(row).toMatchObject({ status: "failed", errorCode: "merged" });
    expect(row.resultJson).toEqual({ error: expected });
    expect(JSON.stringify(row)).not.toContain("leak");

    const second = await runIdempotentWrite(ctxFor(), { execute });
    expect(second).toEqual({ kind: "failed", error: expected, replayed: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("an error message carrying an address is not stored", async () => {
    await runIdempotentWrite(ctxFor(), {
      execute: async () => {
        throw new McpToolError("conflict", "Clashes with ann@example.test");
      },
    });
    const row = await onlyRow();
    expect(JSON.stringify(row)).not.toContain("ann@example.test");
    expect(row.resultJson).toEqual({
      error: { code: "conflict", message: "The request failed (conflict)." },
    });
  });

  it("a generic throw fails as internal and stores no message or cause", async () => {
    const execute = vi.fn(async () => {
      throw Object.assign(new Error("duplicate key for ann@example.test"), {
        cause: new Error("SELECT secret-body FROM t"),
      });
    });
    const outcome = await runIdempotentWrite(ctxFor(), { execute });
    expect(outcome).toEqual({
      kind: "failed",
      error: { code: "internal", message: "Internal error (ref: req-1)" },
      replayed: false,
    });
    const row = await onlyRow();
    expect(row).toMatchObject({
      status: "failed",
      errorCode: "internal",
      resultJson: null,
    });
    const stored = JSON.stringify(row);
    expect(stored).not.toContain("ann@example.test");
    expect(stored).not.toContain("secret-body");
    expect(stored).not.toContain("Internal error");
  });

  it("a failed internal call retries with the same planned id and attempts+1", async () => {
    const ids: string[] = [];
    const flaky = vi.fn(async (id: string) => {
      ids.push(id);
      if (ids.length === 1) {
        throw new Error("boom");
      }
      return { result: { commentId: id } };
    });
    const first = await runIdempotentWrite(ctxFor(), { execute: flaky });
    expect(first).toMatchObject({ kind: "failed" });
    const second = await runIdempotentWrite(ctxFor(), { execute: flaky });
    expect(second).toMatchObject({ kind: "succeeded", replayed: false });
    expect(ids[1]).toBe(ids[0]);
    const row = await onlyRow();
    expect(row).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("an in-flight duplicate returns in_progress without executing", async () => {
    const claim = claimedOrThrow(await claimWriteCall(ctxFor()));
    expect(claim.attempts).toBe(1);
    const execute = vi.fn(async () => ({ result: {} }));
    const outcome = await runIdempotentWrite(ctxFor(), { execute });
    expect(outcome).toMatchObject({
      kind: "failed",
      error: { code: "in_progress" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("a finalize that fails leaves the row pending and still returns the real outcome", async () => {
    const spy = vi.spyOn(db, "update").mockImplementationOnce(() => {
      throw new Error("db down");
    });
    const outcome = await runIdempotentWrite(ctxFor(), {
      execute: async () => ({ result: { commentId: "c1" } }),
    });
    spy.mockRestore();
    expect(outcome).toMatchObject({
      kind: "succeeded",
      result: { commentId: "c1" },
    });
    expect((await onlyRow()).status).toBe("pending");
  });
});

describe("crash after the comment insert", () => {
  it("reconciles to succeeded + uncertain and sends nothing again", async () => {
    // Attempt 1: claim, write the comment (with its webhook and email), then
    // "crash" before finalizing.
    const claim = claimedOrThrow(await claimWriteCall(ctxFor()));
    await sendReply(claim.plannedEntityId);
    await expireLease(claim.id);

    const before = await counts();
    expect(before).toEqual({
      comments: 1,
      activity: 1,
      deliveries: 1,
      outbox: 1,
    });

    // Attempt 2: the client retries with the same key.
    const execute = vi.fn(async (id: string) => await sendReply(id));
    const outcome = await runIdempotentWrite(ctxFor(), {
      execute,
      reconcile: reconcileCommentCall,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      kind: "succeeded",
      result: { commentId: claim.plannedEntityId },
      replayed: false,
      sideEffectsUncertain: true,
      notificationErrors: [],
    });
    expect(await counts()).toEqual(before);

    const row = await onlyRow();
    expect(row).toMatchObject({
      status: "succeeded",
      sideEffectsUncertain: true,
      attempts: 2,
      plannedEntityId: claim.plannedEntityId,
      resultJson: { commentId: claim.plannedEntityId },
    });

    // And a third call just replays it.
    const third = await runIdempotentWrite(ctxFor(), {
      execute,
      reconcile: reconcileCommentCall,
    });
    expect(third).toMatchObject({
      kind: "succeeded",
      replayed: true,
      sideEffectsUncertain: true,
    });
    expect(await counts()).toEqual(before);
  });

  it("a crash before the comment insert re-executes with the same planned id", async () => {
    const claim = claimedOrThrow(await claimWriteCall(ctxFor()));
    await expireLease(claim.id);
    const seen: string[] = [];
    const outcome = await runIdempotentWrite(ctxFor(), {
      execute: async (id) => {
        seen.push(id);
        return await sendReply(id);
      },
      reconcile: reconcileCommentCall,
    });
    expect(seen).toEqual([claim.plannedEntityId]);
    expect(outcome).toMatchObject({
      kind: "succeeded",
      sideEffectsUncertain: false,
    });
    expect(await counts()).toEqual({
      comments: 1,
      activity: 1,
      deliveries: 1,
      outbox: 1,
    });
    expect((await onlyRow()).attempts).toBe(2);
  });

  it("an expired call without a reconciler re-executes (no-op-safe tools)", async () => {
    const claim = claimedOrThrow(await claimWriteCall(ctxFor()));
    await expireLease(claim.id);
    const execute = vi.fn(async () => ({ result: { ok: true } }));
    const outcome = await runIdempotentWrite(ctxFor(), { execute });
    expect(execute).toHaveBeenCalledWith(claim.plannedEntityId);
    expect(outcome).toMatchObject({ kind: "succeeded" });
  });

  it("a reconciler that throws fails the call as internal, retryable", async () => {
    const claim = claimedOrThrow(await claimWriteCall(ctxFor()));
    await expireLease(claim.id);
    const execute = vi.fn(async () => ({ result: {} }));
    const outcome = await runIdempotentWrite(ctxFor(), {
      execute,
      reconcile: () => Promise.reject(new Error("db blip")),
    });
    expect(execute).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: "failed",
      error: { code: "internal" },
    });
    expect((await onlyRow()).errorCode).toBe("internal");
  });
});

describe("slow duplicate after the lease expires", () => {
  const settled = {
    comments: 1,
    activity: 1,
    deliveries: 1,
    outbox: 1,
  };

  it("original still running: the takeover writes, the original loses its insert and does nothing", async () => {
    const gate = deferred();
    const started = deferred<string>();
    const first = runIdempotentWrite(ctxFor(), {
      execute: async (id) => {
        started.resolve(id);
        await gate.promise; // "still running"
        return await sendReply(id);
      },
      reconcile: reconcileCommentCall,
    });
    const plannedId = await started.promise;
    await expireLease((await onlyRow()).id);

    const second = await runIdempotentWrite(ctxFor({ requestId: "req-2" }), {
      execute: sendReply,
      reconcile: reconcileCommentCall,
    });
    expect(second).toMatchObject({
      kind: "succeeded",
      replayed: false,
      sideEffectsUncertain: false,
      result: { commentId: plannedId },
    });
    expect(await counts()).toEqual(settled);

    gate.resolve();
    const firstOutcome = await first;
    // The original's insert hit the unique violation: done, nothing re-sent,
    // and its finalize (attempt 1) no longer applies to the row.
    expect(firstOutcome).toMatchObject({
      kind: "succeeded",
      result: { commentId: plannedId },
    });
    expect(await counts()).toEqual(settled);
    expect(await onlyRow()).toMatchObject({
      status: "succeeded",
      attempts: 2,
      sideEffectsUncertain: false,
    });
  });

  it("both executions in flight: whichever insert loses is 'already done' with no side effects", async () => {
    const gate1 = deferred();
    const gate2 = deferred();
    const started1 = deferred<string>();
    const started2 = deferred<string>();
    const first = runIdempotentWrite(ctxFor(), {
      execute: async (id) => {
        started1.resolve(id);
        await gate1.promise;
        return await sendReply(id);
      },
      reconcile: reconcileCommentCall,
    });
    const plannedId = await started1.promise;
    await expireLease((await onlyRow()).id);

    const second = runIdempotentWrite(ctxFor({ requestId: "req-2" }), {
      execute: async (id) => {
        started2.resolve(id);
        await gate2.promise;
        return await sendReply(id);
      },
      reconcile: reconcileCommentCall,
    });
    // Same planned id on the re-execution, never regenerated.
    expect(await started2.promise).toBe(plannedId);

    // The original finishes first and wins the insert; its finalize no longer
    // applies (the takeover bumped attempts), so it reports in_progress.
    gate1.resolve();
    const firstOutcome = await first;
    expect(await counts()).toEqual(settled);
    expect(firstOutcome).toMatchObject({
      kind: "failed",
      error: { code: "in_progress" },
    });

    // The takeover then loses its insert: already done, nothing re-sent.
    gate2.resolve();
    const secondOutcome = await second;
    expect(secondOutcome).toEqual({
      kind: "succeeded",
      result: { commentId: plannedId },
      replayed: false,
      sideEffectsUncertain: true,
      notificationErrors: [],
    });
    expect(await counts()).toEqual(settled);
    expect(await onlyRow()).toMatchObject({
      status: "succeeded",
      sideEffectsUncertain: true,
      attempts: 2,
    });
  });

  it("a raw unique violation from the write also counts as already done", async () => {
    const claim = claimedOrThrow(await claimWriteCall(ctxFor()));
    await sendReply(claim.plannedEntityId);
    await expireLease(claim.id);
    const before = await counts();
    const outcome = await runIdempotentWrite(ctxFor(), {
      execute: async (id) => {
        // What closeTicket does: a plain insert with the planned id.
        await db.insert(ticketComments).values({
          id,
          ticketId: tid(101),
          authorId: USERS.alice.id,
          authorName: "x",
          authorRole: "agent",
          content: "dup",
        });
        return { result: {} };
      },
      reconcile: () => Promise.resolve({ done: false }),
    });
    expect(outcome).toMatchObject({
      kind: "succeeded",
      sideEffectsUncertain: true,
    });
    expect(await counts()).toEqual(before);
    const [row] = await db
      .select()
      .from(mcpToolCalls)
      .where(and(eq(mcpToolCalls.id, claim.id)));
    expect(row.status).toBe("succeeded");
  });
});
