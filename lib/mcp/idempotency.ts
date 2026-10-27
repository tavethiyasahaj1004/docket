// Idempotency and recovery for MCP write tools (MCP_SECURITY.md 7.2-7.4), on
// the mcp_tool_calls ledger. A write call first CLAIMS a pending row in its own
// committed statement, runs the domain write, then FINALIZES the row in one
// conditional UPDATE. A crash in between leaves a pending row whose lease
// expires; the next call with the same key reconciles it instead of repeating
// the write, and the daily sweeper settles what nobody retried.
import { createId } from "@paralleldrive/cuid2";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { mcpToolCalls } from "@/db/schema";
import { db } from "@/lib/db";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { type McpErrorDetails, McpToolError } from "@/lib/mcp/errors";
import {
  MCP_ERROR_CODES,
  MCP_WRITE_LEASE_MS,
  type McpErrorCode,
  type McpNotificationError,
} from "@/lib/mcp/limits";
import type { McpToolCallRow, ReconcileOutcome } from "@/lib/mcp/reconcile";
import { sanitizeResultJson } from "@/lib/mcp/result-json";
import {
  describeErrorForLog,
  hmacToolArgs,
  isSafeDetailString,
  sanitizeErrorDetails,
} from "@/lib/mcp/safe-handler";
import { isUniqueViolation } from "@/lib/tickets/route-input";

export const IDEMPOTENCY_INDEX = "mcp_tool_calls_idempotency_idx";
export const TICKET_LOCK_INDEX = "mcp_tool_calls_ticket_lock_idx";

/** Failed rows with these codes may be retried with the same key; every other
 * failure is replayed as it was. */
const RETRYABLE_CODES: readonly McpErrorCode[] = ["internal", "interrupted"];

/** Rounds spent re-reading state after losing a race before answering
 * `in_progress`. */
const MAX_CLAIM_ROUNDS = 3;

export type WriteCallContext = {
  principal: McpPrincipal;
  requestId: string;
  tool: string;
  /** The validated arguments. Only a keyed hash of them is stored. */
  args: unknown;
  clientRequestId?: string;
  /** Calls in one lock group may not overlap on the same ticket. */
  lockGroup?: "ticket_state";
  targetTicketId?: string;
  /** HMAC of the normalized reply body (reply_to_customer content dedupe). */
  bodyHmac?: string;
  /** Test seam: the app clock. */
  now?: Date;
};

/** Ownership of one attempt at a pending row. */
export type WriteClaim = {
  id: string;
  /** Generated before the write and reused by every re-execution. */
  plannedEntityId: string;
  attempts: number;
  startedAt: number;
};

/** A structured error as stored and replayed. The message is limited to text
 * that passes the same safety check as error details. */
export type StoredError = {
  code: McpErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type ClaimResult =
  | { kind: "claimed"; claim: WriteClaim }
  | {
      kind: "replay";
      result: Record<string, unknown>;
      sideEffectsUncertain: boolean;
      notificationErrors: string[];
    }
  | { kind: "error"; error: StoredError }
  | { kind: "in_progress"; retryAfterSeconds: number }
  | { kind: "reconcile"; row: McpToolCallRow };

export type FinalizeOutcome =
  | {
      status: "succeeded";
      result: Record<string, unknown>;
      sideEffectsUncertain?: boolean;
      notificationErrors?: readonly string[];
    }
  | {
      status: "failed";
      errorCode: McpErrorCode;
      /** Stored as the replayable structured error; omitted for `internal`. */
      error?: StoredError;
      sideEffectsUncertain?: boolean;
      notificationErrors?: readonly string[];
    };

/** What a tool's write step reports back. */
export type ExecuteResult = {
  /** Ids, numbers, booleans, slugs and ISO timestamps (sanitized on store). */
  result: Record<string, unknown>;
  sideEffectsUncertain?: boolean;
  notificationErrors?: readonly McpNotificationError[];
};

export type WriteHooks = {
  /** The domain write. Must use `plannedEntityId` as the id of the entity it
   * creates, and throw {@link PlannedEntityExistsError} (or let the unique
   * violation through) when that id already exists. */
  execute(plannedEntityId: string): Promise<ExecuteResult>;
  /** Did a previous attempt already do the write? Absent = never. */
  reconcile?(row: McpToolCallRow): Promise<ReconcileOutcome>;
};

export type WriteOutcome =
  | {
      kind: "succeeded";
      result: Record<string, unknown>;
      replayed: boolean;
      sideEffectsUncertain: boolean;
      notificationErrors: string[];
    }
  | { kind: "failed"; error: StoredError; replayed: boolean };

/** Raised by a write step when the service reports that the planned id already
 * exists: a slow duplicate lost the insert race, so the work is already done
 * and no side effect may run again. */
export class PlannedEntityExistsError extends Error {
  constructor() {
    super("The planned entity already exists.");
    this.name = "PlannedEntityExistsError";
  }
}

/** Turns a failed outcome's error into the error a tool throws through the
 * safe handler. */
export function toToolError(error: StoredError): McpToolError {
  return new McpToolError(
    error.code,
    error.message,
    error.details as McpErrorDetails | undefined
  );
}

/* ----------------------------------------------------------- unique index */

type PgErrorLike = {
  code?: string;
  constraint_name?: string;
  message?: string;
  cause?: PgErrorLike;
};

/** Which unique index a 23505 violated, or null when it is not a unique
 * violation. Drizzle wraps the postgres-js error in `cause`; the driver puts
 * the index name in `constraint_name`. The message is only a last resort. */
export function violatedIndex(
  err: unknown
): "idempotency" | "ticket_lock" | "other" | null {
  if (!isUniqueViolation(err)) {
    return null;
  }
  const outer = err as PgErrorLike;
  const inner = outer.cause ?? outer;
  const text =
    inner.constraint_name ??
    outer.constraint_name ??
    `${inner.message ?? ""} ${outer.message ?? ""}`;
  if (text.includes(IDEMPOTENCY_INDEX)) {
    return "idempotency";
  }
  return text.includes(TICKET_LOCK_INDEX) ? "ticket_lock" : "other";
}

/* ----------------------------------------------------------- stored error */

function fallbackMessage(code: McpErrorCode): string {
  return `The request failed (${code}).`;
}

export function toStoredError(
  code: McpErrorCode,
  message: string,
  details: McpErrorDetails | undefined,
  requestId: string
): StoredError {
  const safeDetails = sanitizeErrorDetails(details, requestId);
  return {
    code,
    message: isSafeDetailString(message) ? message : fallbackMessage(code),
    ...(safeDetails ? { details: safeDetails } : {}),
  };
}

function readStoredError(row: McpToolCallRow): StoredError {
  const raw = (row.resultJson as { error?: Partial<StoredError> } | null)
    ?.error;
  const known = (MCP_ERROR_CODES as readonly string[]).includes(
    raw?.code ?? ""
  );
  const code = known
    ? (raw?.code as McpErrorCode)
    : ((row.errorCode as McpErrorCode | null) ?? "internal");
  const message =
    typeof raw?.message === "string" && isSafeDetailString(raw.message)
      ? raw.message
      : fallbackMessage(code);
  const details =
    raw?.details && typeof raw.details === "object"
      ? sanitizeErrorDetails(raw.details as McpErrorDetails, row.requestId)
      : undefined;
  return { code, message, ...(details ? { details } : {}) };
}

function inProgressError(retryAfterSeconds: number): StoredError {
  return {
    code: "in_progress",
    message: `Another request for this call or ticket is still running. Retry in ${retryAfterSeconds} seconds.`,
    details: { retryAfterSeconds },
  };
}

function keyReusedError(): StoredError {
  return {
    code: "idempotency_key_reused",
    message:
      "This clientRequestId was already used with different arguments. Use a new one for a new request.",
  };
}

function internalError(requestId: string): StoredError {
  return { code: "internal", message: `Internal error (ref: ${requestId})` };
}

/* ------------------------------------------------------------------ claim */

function retryAfterSeconds(lease: Date | null, now: Date): number {
  if (!lease) {
    return 1;
  }
  return Math.max(1, Math.ceil((lease.getTime() - now.getTime()) / 1000));
}

function leaseFrom(now: Date): Date {
  return new Date(now.getTime() + MCP_WRITE_LEASE_MS);
}

function toClaim(row: {
  id: string;
  plannedEntityId: string | null;
  attempts: number;
}): WriteClaim {
  if (!row.plannedEntityId) {
    // Every row this module claims carries one; without it a re-execution
    // could not be told apart from a first run.
    throw new Error("Pending write call has no planned entity id.");
  }
  return {
    id: row.id,
    plannedEntityId: row.plannedEntityId,
    attempts: row.attempts,
    startedAt: Date.now(),
  };
}

async function loadKeyedRow(
  ctx: WriteCallContext
): Promise<McpToolCallRow | undefined> {
  if (ctx.clientRequestId === undefined) {
    return;
  }
  const [row] = await db
    .select()
    .from(mcpToolCalls)
    .where(
      and(
        eq(mcpToolCalls.userId, ctx.principal.userId),
        eq(mcpToolCalls.tool, ctx.tool),
        eq(mcpToolCalls.clientRequestId, ctx.clientRequestId)
      )
    )
    .limit(1);
  return row;
}

async function loadLockHolder(
  ctx: WriteCallContext
): Promise<McpToolCallRow | undefined> {
  if (!(ctx.lockGroup && ctx.targetTicketId)) {
    return;
  }
  const [row] = await db
    .select()
    .from(mcpToolCalls)
    .where(
      and(
        eq(mcpToolCalls.lockGroup, ctx.lockGroup),
        eq(mcpToolCalls.targetTicketId, ctx.targetTicketId),
        eq(mcpToolCalls.status, "pending")
      )
    )
    .limit(1);
  return row;
}

async function loadRow(id: string): Promise<McpToolCallRow | undefined> {
  const [row] = await db
    .select()
    .from(mcpToolCalls)
    .where(eq(mcpToolCalls.id, id))
    .limit(1);
  return row;
}

/** Compare-and-set a retryable failed row back to pending. */
async function retryFailedRow(
  ctx: WriteCallContext,
  row: McpToolCallRow,
  now: Date
): Promise<ClaimResult> {
  try {
    const [updated] = await db
      .update(mcpToolCalls)
      .set({
        status: "pending",
        errorCode: null,
        resultJson: null,
        notificationErrors: null,
        durationMs: null,
        attempts: row.attempts + 1,
        leaseExpiresAt: leaseFrom(now),
        requestId: ctx.requestId,
        updatedAt: now,
      })
      .where(
        and(
          eq(mcpToolCalls.id, row.id),
          eq(mcpToolCalls.status, "failed"),
          eq(mcpToolCalls.attempts, row.attempts),
          inArray(mcpToolCalls.errorCode, [...RETRYABLE_CODES])
        )
      )
      .returning({
        id: mcpToolCalls.id,
        plannedEntityId: mcpToolCalls.plannedEntityId,
        attempts: mcpToolCalls.attempts,
      });
    if (!updated) {
      return { kind: "in_progress", retryAfterSeconds: 1 };
    }
    return { kind: "claimed", claim: toClaim(updated) };
  } catch (err) {
    // Going back to pending re-enters the per-ticket lock: another pending
    // call on the same ticket may hold it.
    if (violatedIndex(err) !== "ticket_lock") {
      throw err;
    }
    const holder = await loadLockHolder(ctx);
    return {
      kind: "in_progress",
      retryAfterSeconds: retryAfterSeconds(holder?.leaseExpiresAt ?? null, now),
    };
  }
}

/** The 7.3 table: what to do with the row already stored for this key. */
async function applyExistingRow(
  ctx: WriteCallContext,
  row: McpToolCallRow,
  now: Date
): Promise<ClaimResult> {
  if (row.argsHmac !== hmacToolArgs(ctx.args)) {
    return { kind: "error", error: keyReusedError() };
  }
  if (row.status === "succeeded") {
    return {
      kind: "replay",
      result: {
        ...((row.resultJson as Record<string, unknown> | null) ?? {}),
        replayed: true,
      },
      sideEffectsUncertain: row.sideEffectsUncertain,
      notificationErrors: row.notificationErrors ?? [],
    };
  }
  if (row.status === "failed") {
    if (RETRYABLE_CODES.includes(row.errorCode as McpErrorCode)) {
      return await retryFailedRow(ctx, row, now);
    }
    return { kind: "error", error: readStoredError(row) };
  }
  if (row.leaseExpiresAt && row.leaseExpiresAt.getTime() > now.getTime()) {
    return {
      kind: "in_progress",
      retryAfterSeconds: retryAfterSeconds(row.leaseExpiresAt, now),
    };
  }
  return { kind: "reconcile", row };
}

/** Step 1 of 7.4: INSERT a pending row as its own statement (autocommit), so it
 * is visible to a concurrent retry before the write starts. A conflict on the
 * per-ticket lock index answers `in_progress` whatever the key; a conflict on
 * the idempotency index applies the 7.3 table to the row already there. */
export async function claimWriteCall(
  ctx: WriteCallContext
): Promise<ClaimResult> {
  if ((ctx.lockGroup === undefined) !== (ctx.targetTicketId === undefined)) {
    throw new Error("lockGroup and targetTicketId go together.");
  }
  const now = ctx.now ?? new Date();
  const argsHmac = hmacToolArgs(ctx.args);

  for (let round = 0; round < MAX_CLAIM_ROUNDS; round++) {
    const id = createId();
    const plannedEntityId = createId();
    try {
      await db.insert(mcpToolCalls).values({
        id,
        requestId: ctx.requestId,
        userId: ctx.principal.userId,
        authMethod: ctx.principal.authMethod,
        credentialId: ctx.principal.credentialId,
        tool: ctx.tool,
        clientRequestId: ctx.clientRequestId ?? null,
        status: "pending",
        argsHmac,
        plannedEntityId,
        lockGroup: ctx.lockGroup ?? null,
        targetTicketId: ctx.targetTicketId ?? null,
        bodyHmac: ctx.bodyHmac ?? null,
        leaseExpiresAt: leaseFrom(now),
        attempts: 1,
        // The app clock, not the database's: the close reconciler compares
        // this with timestamps the app wrote.
        createdAt: now,
        updatedAt: now,
      });
      return {
        kind: "claimed",
        claim: { id, plannedEntityId, attempts: 1, startedAt: Date.now() },
      };
    } catch (err) {
      const which = violatedIndex(err);
      if (which !== "idempotency" && which !== "ticket_lock") {
        throw err;
      }
      // Postgres reports whichever index it checks first when both are
      // violated, so look for the keyed row first: it decides what a repeat of
      // this call gets.
      const existing = await loadKeyedRow(ctx);
      if (existing) {
        return await applyExistingRow(ctx, existing, now);
      }
      const holder = await loadLockHolder(ctx);
      if (holder) {
        return {
          kind: "in_progress",
          retryAfterSeconds: retryAfterSeconds(holder.leaseExpiresAt, now),
        };
      }
      // The blocking row settled between the INSERT and the look-up: go again.
    }
  }
  return { kind: "in_progress", retryAfterSeconds: 1 };
}

/** Compare-and-set a pending row whose lease expired: new lease, `attempts+1`,
 * the SAME planned entity id. Null when another worker got there first. */
export async function takeOverExpiredCall(
  row: McpToolCallRow,
  now: Date = new Date(),
  requestId?: string
): Promise<WriteClaim | null> {
  const [updated] = await db
    .update(mcpToolCalls)
    .set({
      attempts: row.attempts + 1,
      leaseExpiresAt: leaseFrom(now),
      updatedAt: now,
      ...(requestId ? { requestId } : {}),
    })
    .where(
      and(
        eq(mcpToolCalls.id, row.id),
        eq(mcpToolCalls.status, "pending"),
        eq(mcpToolCalls.attempts, row.attempts),
        or(
          isNull(mcpToolCalls.leaseExpiresAt),
          lte(mcpToolCalls.leaseExpiresAt, now)
        )
      )
    )
    .returning({
      id: mcpToolCalls.id,
      plannedEntityId: mcpToolCalls.plannedEntityId,
      attempts: mcpToolCalls.attempts,
    });
  return updated ? toClaim(updated) : null;
}

/* --------------------------------------------------------------- finalize */

/** Step 6 of 7.4: ONE conditional UPDATE. It applies only while the row is
 * still pending under this claim's attempt, so a slow earlier attempt can never
 * overwrite what a later one recorded. Returns whether it applied. */
export async function finalizeWriteCall(
  claim: WriteClaim,
  outcome: FinalizeOutcome
): Promise<boolean> {
  const notificationErrors =
    outcome.notificationErrors && outcome.notificationErrors.length > 0
      ? [...outcome.notificationErrors]
      : null;
  let resultJson: unknown = null;
  if (outcome.status === "succeeded") {
    resultJson = sanitizeResultJson(outcome.result);
  } else if (outcome.error) {
    resultJson = { error: outcome.error };
  }
  const uncertain = outcome.sideEffectsUncertain ?? false;
  const updated = await db
    .update(mcpToolCalls)
    .set({
      status: outcome.status,
      errorCode: outcome.status === "failed" ? outcome.errorCode : null,
      resultJson,
      // Uncertainty is never cleared by a later attempt.
      sideEffectsUncertain: sql`${mcpToolCalls.sideEffectsUncertain} OR ${uncertain}::boolean`,
      notificationErrors,
      durationMs: Math.max(0, Date.now() - claim.startedAt),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mcpToolCalls.id, claim.id),
        eq(mcpToolCalls.status, "pending"),
        eq(mcpToolCalls.attempts, claim.attempts)
      )
    )
    .returning({ id: mcpToolCalls.id });
  return updated.length > 0;
}

/* ------------------------------------------------------------ orchestrator */

function succeededOutcome(
  result: Record<string, unknown>,
  replayed: boolean,
  sideEffectsUncertain: boolean,
  notificationErrors: readonly string[] = []
): WriteOutcome {
  return {
    kind: "succeeded",
    result: replayed ? { ...result, replayed: true } : result,
    replayed,
    sideEffectsUncertain,
    notificationErrors: [...notificationErrors],
  };
}

function outcomeFromRow(row: McpToolCallRow, now: Date): WriteOutcome {
  if (row.status === "succeeded") {
    return succeededOutcome(
      (row.resultJson as Record<string, unknown> | null) ?? {},
      true,
      row.sideEffectsUncertain,
      row.notificationErrors ?? []
    );
  }
  if (row.status === "failed") {
    return { kind: "failed", error: readStoredError(row), replayed: true };
  }
  return {
    kind: "failed",
    error: inProgressError(retryAfterSeconds(row.leaseExpiresAt, now)),
    replayed: false,
  };
}

/** Finalizes and maps to the outcome the tool returns. A finalize that did not
 * apply means a later attempt owns the row, so that attempt's recorded outcome
 * is returned instead. A finalize that throws leaves the row pending (the next
 * retry or the sweeper reconciles it) and still returns the real outcome: the
 * write happened. */
async function settle(
  ctx: WriteCallContext,
  claim: WriteClaim,
  finalize: FinalizeOutcome,
  outcome: WriteOutcome
): Promise<WriteOutcome> {
  try {
    if (await finalizeWriteCall(claim, finalize)) {
      return outcome;
    }
    const row = await loadRow(claim.id);
    return row
      ? outcomeFromRow(row, ctx.now ?? new Date())
      : { kind: "failed", error: inProgressError(1), replayed: false };
  } catch (err) {
    console.error(
      `[mcp] finalize_failed ref=${ctx.requestId}`,
      describeErrorForLog(err)
    );
    return outcome;
  }
}

function settleInternal(
  ctx: WriteCallContext,
  claim: WriteClaim
): Promise<WriteOutcome> {
  return settle(
    ctx,
    claim,
    { status: "failed", errorCode: "internal" },
    { kind: "failed", error: internalError(ctx.requestId), replayed: false }
  );
}

/** The write already exists under its planned id: record success, uncertain
 * because the notifications of whichever attempt wrote it may not have run.
 * Nothing is executed here. */
async function settleAlreadyDone(
  ctx: WriteCallContext,
  hooks: WriteHooks,
  claim: WriteClaim
): Promise<WriteOutcome> {
  let result: Record<string, unknown> = {};
  if (hooks.reconcile) {
    try {
      const row = await loadRow(claim.id);
      const found = row ? await hooks.reconcile(row) : null;
      if (found?.done) {
        result = sanitizeResultJson(found.result);
      }
    } catch (err) {
      console.error(
        `[mcp] reconcile_failed ref=${ctx.requestId}`,
        describeErrorForLog(err)
      );
    }
  }
  return await settle(
    ctx,
    claim,
    { status: "succeeded", result, sideEffectsUncertain: true },
    succeededOutcome(result, false, true)
  );
}

async function runClaimed(
  ctx: WriteCallContext,
  hooks: WriteHooks,
  claim: WriteClaim
): Promise<WriteOutcome> {
  let executed: ExecuteResult;
  try {
    executed = await hooks.execute(claim.plannedEntityId);
  } catch (failure) {
    if (
      failure instanceof PlannedEntityExistsError ||
      isUniqueViolation(failure)
    ) {
      // A slow duplicate lost the insert race: the other attempt did the write
      // and its side effects, so run none here.
      return await settleAlreadyDone(ctx, hooks, claim);
    }
    if (failure instanceof McpToolError) {
      const error = toStoredError(
        failure.code,
        failure.message,
        failure.details,
        ctx.requestId
      );
      return await settle(
        ctx,
        claim,
        { status: "failed", errorCode: failure.code, error },
        { kind: "failed", error, replayed: false }
      );
    }
    // Anything else is opaque: its shape goes to the log, and no message or
    // cause is stored or returned.
    console.error(
      `[mcp] write_failed tool=${ctx.tool} ref=${ctx.requestId}`,
      describeErrorForLog(failure)
    );
    return await settleInternal(ctx, claim);
  }

  const result = sanitizeResultJson(executed.result);
  const uncertain = executed.sideEffectsUncertain ?? false;
  const notificationErrors = executed.notificationErrors ?? [];
  return await settle(
    ctx,
    claim,
    {
      status: "succeeded",
      result,
      sideEffectsUncertain: uncertain,
      notificationErrors,
    },
    succeededOutcome(result, false, uncertain, notificationErrors)
  );
}

async function runReconciled(
  ctx: WriteCallContext,
  hooks: WriteHooks,
  row: McpToolCallRow,
  claim: WriteClaim
): Promise<WriteOutcome> {
  let found: ReconcileOutcome = { done: false };
  try {
    if (hooks.reconcile) {
      found = await hooks.reconcile(row);
    }
  } catch (err) {
    console.error(
      `[mcp] reconcile_failed ref=${ctx.requestId}`,
      describeErrorForLog(err)
    );
    return await settleInternal(ctx, claim);
  }
  if (found.done) {
    const result = sanitizeResultJson(found.result);
    return await settle(
      ctx,
      claim,
      {
        status: "succeeded",
        result,
        sideEffectsUncertain: found.sideEffectsUncertain,
      },
      succeededOutcome(result, false, found.sideEffectsUncertain)
    );
  }
  // Nothing happened yet: run it again with the same planned id.
  return await runClaimed(ctx, hooks, claim);
}

/** claim -> (replay | error | in_progress | reconcile) -> execute -> finalize.
 * Returns a plain outcome; the tool turns it into a result through the safe
 * handler (`toToolError` for a failed one). */
export async function runIdempotentWrite(
  ctx: WriteCallContext,
  hooks: WriteHooks
): Promise<WriteOutcome> {
  for (let round = 0; round < MAX_CLAIM_ROUNDS; round++) {
    const claimed = await claimWriteCall(ctx);
    switch (claimed.kind) {
      case "claimed":
        return await runClaimed(ctx, hooks, claimed.claim);
      case "replay":
        return succeededOutcome(
          claimed.result,
          true,
          claimed.sideEffectsUncertain,
          claimed.notificationErrors
        );
      case "error":
        return { kind: "failed", error: claimed.error, replayed: true };
      case "in_progress":
        return {
          kind: "failed",
          error: inProgressError(claimed.retryAfterSeconds),
          replayed: false,
        };
      case "reconcile": {
        const claim = await takeOverExpiredCall(
          claimed.row,
          ctx.now ?? new Date(),
          ctx.requestId
        );
        if (claim) {
          return await runReconciled(ctx, hooks, claimed.row, claim);
        }
        // Another worker took the row over (or finished it): look again.
        break;
      }
      default:
        break;
    }
  }
  return { kind: "failed", error: inProgressError(1), replayed: false };
}
