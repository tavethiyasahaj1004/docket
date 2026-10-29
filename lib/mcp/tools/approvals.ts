// Tools that reach the customer (close_ticket, reply_to_customer) and the one
// that reports on them (get_action_status). A token can only ASK: these create a
// request in mcp_pending_actions, and only the token owner can approve it, in
// Docket. Nothing here closes a ticket, writes a comment, sends an email or
// fires a webhook; approving runs the same service the UI runs, as the owner.
import type { McpServer } from "@modelcontextprotocol/server";
import { and, desc, eq, gte, ne } from "drizzle-orm";
import { z } from "zod";
import { mcpPendingActions, mcpToolCalls, tickets } from "@/db/schema";
import { db } from "@/lib/db";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { McpToolError, notFound } from "@/lib/mcp/errors";
import { secondsUntilWindowEnds } from "@/lib/mcp/http";
import { MCP_RATE_LIMITS } from "@/lib/mcp/limits";
import {
  type CreatePendingActionResult,
  createPendingAction,
  type PendingActionKind,
} from "@/lib/mcp/pending-actions";
import { agentTicketUrl } from "@/lib/mcp/read-dto";
import { reconcilePendingActionCall } from "@/lib/mcp/reconcile";
import { isCustomerRepliesEnabled } from "@/lib/mcp/reply-gate";
import { hmacToolArgs, safeHandler } from "@/lib/mcp/safe-handler";
import {
  mergedDuringChangeError,
  type ResolvedTicket,
  resolveTicketRef,
  resolveTicketRefForChange,
} from "@/lib/mcp/ticket-ref";
import {
  appUrl,
  expectedUpdatedAtSchema,
  mergedFromOutput,
  parseExpectedUpdatedAt,
  READ_ONLY_ANNOTATIONS,
  REQUIRES_USER_INTERACTION_META,
  requiredClientRequestIdSchema,
  staleTicketError,
  ticketRefSchema,
  writeAnnotations,
  writeFlagsShape,
  writtenTicketOutput,
} from "@/lib/mcp/tools/common";
import { type ExecuteResult, runWriteTool } from "@/lib/mcp/write-call";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  htmlToRichTextJson,
  isRichTextEmpty,
  richTextToPlainText,
  textToRichTextJson,
} from "@/lib/rich-text";
import { isClosedStatusSlug } from "@/lib/ticket-config";
import { loadTicketForChange } from "@/lib/tickets/services/ticket-fields";

/** A new reply with the same text as one requested this recently (under another
 * key) is probably a duplicate (D3). */
const DUPLICATE_REPLY_WINDOW_MS = 10 * 60 * 1000;

const APPROVAL_NOTE =
  "The ticket owner must approve this in Docket (ticket page).";
const EXISTING_REPLY_NOTE =
  "A reply request for this ticket was already waiting for approval, so this call created no new request and its text did not replace the earlier one. The ticket owner must approve or dismiss it in Docket (ticket page).";

const awaitingApprovalShape = {
  requestId: z.string().optional(),
  expiresAt: z.string().optional(),
  existingRequest: z.boolean().optional(),
  approvalNote: z.string().optional(),
};

function ticketOutput(ticketNumber: number) {
  return {
    number: ticketNumber,
    agentUrl: agentTicketUrl(appUrl(), ticketNumber),
  };
}

/* ------------------------------------------------------------- shared steps */

/** A request already stored under the call's planned id: a previous attempt of
 * this very call created it. Checked first so a retry returns it before any
 * state check (a close that was approved and reopened since must not turn the
 * retry into a second request). */
async function requestUnderPlannedId(plannedEntityId: string) {
  const [row] = await db
    .select({ id: mcpPendingActions.id })
    .from(mcpPendingActions)
    .where(eq(mcpPendingActions.id, plannedEntityId))
    .limit(1);
  return row?.id ?? null;
}

/** The ledger row of this call, for the request's trace field. The row is
 * committed before `execute` runs and the executor only receives the planned
 * id, so it is found by that id (never an unrelated row: the planned id is a
 * fresh cuid2 and the lookup is scoped to the caller and the tool). */
async function ledgerRowId(
  principal: McpPrincipal,
  tool: string,
  plannedEntityId: string
) {
  const [row] = await db
    .select({ id: mcpToolCalls.id })
    .from(mcpToolCalls)
    .where(
      and(
        eq(mcpToolCalls.userId, principal.userId),
        eq(mcpToolCalls.tool, tool),
        eq(mcpToolCalls.plannedEntityId, plannedEntityId)
      )
    )
    .limit(1);
  return row?.id ?? null;
}

type Created = Extract<
  CreatePendingActionResult,
  { status: "created" | "existing" }
>;

/** Creates the request under the call's planned id and maps the refusals that
 * are the same for both kinds. `ticket_closed` is left to the caller. */
async function createRequest(input: {
  principal: McpPrincipal;
  tool: string;
  ref: ResolvedTicket;
  kind: PendingActionKind;
  payload: unknown;
  plannedEntityId: string;
}): Promise<Created | "ticket_closed"> {
  const created = await createPendingAction({
    id: input.plannedEntityId,
    userId: input.principal.userId,
    credentialId: input.principal.credentialId,
    ticketId: input.ref.id,
    kind: input.kind,
    payload: input.payload,
    toolCallId: await ledgerRowId(
      input.principal,
      input.tool,
      input.plannedEntityId
    ),
  });
  switch (created.status) {
    case "created":
    case "existing":
      return created;
    case "ticket_closed":
      return "ticket_closed";
    case "ticket_merged":
      throw await mergedDuringChangeError(input.ref.id);
    case "ticket_not_found":
      throw notFound("ticket");
    default:
      // not_permitted: the principal was live when the call started, so only a
      // revoke or ban in between gets here. invalid_content: the payload was
      // validated before. Neither is an answer for the model.
      throw new Error(`Could not record the ${input.kind} request.`);
  }
}

/** What a stored request looks like to the model: the call's outcome, never the
 * live status (that is get_action_status). */
function requestResult(created: Created, plannedEntityId: string) {
  return {
    requestId: created.action.id,
    // The request was already pending from an earlier call with another key.
    // A re-run of THIS call (same planned id) is not "existing".
    ...(created.action.id === plannedEntityId ? {} : { existing: true }),
  };
}

async function loadRequestExpiry(requestId: unknown) {
  if (typeof requestId !== "string") {
    return null;
  }
  const [row] = await db
    .select({
      id: mcpPendingActions.id,
      expiresAt: mcpPendingActions.expiresAt,
    })
    .from(mcpPendingActions)
    .where(eq(mcpPendingActions.id, requestId))
    .limit(1);
  return row ?? null;
}

/* ------------------------------------------------------------ close_ticket */

export const closeTicketInput = z.strictObject({
  ticket: ticketRefSchema,
  expectedUpdatedAt: expectedUpdatedAtSchema,
  clientRequestId: requiredClientRequestIdSchema,
});

const closeTicketOutput = z.object({
  status: z.enum(["awaiting_approval", "already_closed"]),
  alreadyClosed: z.boolean().optional(),
  ticket: writtenTicketOutput,
  ...awaitingApprovalShape,
  ...writeFlagsShape,
});
type CloseTicketResult = z.infer<typeof closeTicketOutput>;

const CLOSE_TOOL = "close_ticket";

export function registerCloseTool(
  server: McpServer,
  principal: McpPrincipal,
  requestId: string,
  permitted: ReadonlySet<string>
) {
  if (!permitted.has(CLOSE_TOOL)) {
    return;
  }
  server.registerTool(
    CLOSE_TOOL,
    {
      title: "Request to close a ticket",
      description:
        "Only REQUESTS a close; it never closes the ticket. The token owner approves or dismisses the request on the ticket page in Docket. Approving runs the normal close, which emails the customer. Tell the user to approve it there, and check the outcome with get_action_status (requestId). Confirm with the user first. clientRequestId is required: reuse the SAME key when retrying (a repeat returns the same request), use a NEW key for a new request. While a close request for the ticket is still pending, a call returns that same request (existingRequest: true). An already closed ticket creates no request (already_closed). Pass expectedUpdatedAt (the ticket's updatedAt as you read it): on a mismatch no request is created and the call returns conflict. Merged tickets return merged.",
      inputSchema: closeTicketInput,
      outputSchema: closeTicketOutput,
      // A repeat with the same key returns the stored request; a new key while
      // one is pending returns that request too, so repeating creates nothing
      // new.
      annotations: writeAnnotations({ idempotent: true, openWorld: true }),
      _meta: REQUIRES_USER_INTERACTION_META,
    },
    (args) =>
      safeHandler<CloseTicketResult>(
        { tool: CLOSE_TOOL, principal, requestId, args },
        async (call) => {
          const ref = await resolveTicketRefForChange(args.ticket);
          call.setTarget({ ticketId: ref.id });
          const expectedUpdatedAt = parseExpectedUpdatedAt(
            args.expectedUpdatedAt
          );

          const { stored, flags } = await runWriteTool({
            tool: CLOSE_TOOL,
            principal,
            requestId,
            call,
            args,
            clientRequestId: args.clientRequestId,
            targetTicketId: ref.id,
            reconcile: reconcilePendingActionCall,
            execute: async (plannedEntityId): Promise<ExecuteResult> => {
              const earlier = await requestUnderPlannedId(plannedEntityId);
              if (earlier) {
                return { result: { requestId: earlier } };
              }

              const snapshot = await loadTicketForChange(ref.id);
              if (snapshot.status === "not_found") {
                throw notFound("ticket");
              }
              if (snapshot.status === "merged") {
                throw await mergedDuringChangeError(ref.id);
              }
              if (await isClosedStatusSlug(snapshot.ticket.status)) {
                return { result: { alreadyClosed: true } };
              }
              if (
                expectedUpdatedAt &&
                snapshot.ticket.updatedAt.getTime() !==
                  expectedUpdatedAt.getTime()
              ) {
                throw staleTicketError(
                  ref.ticketNumber,
                  snapshot.ticket.updatedAt,
                  "The ticket changed since expectedUpdatedAt. No close was requested. Read the ticket again and retry with its current updatedAt."
                );
              }

              const created = await createRequest({
                principal,
                tool: CLOSE_TOOL,
                ref,
                kind: "close",
                payload: {},
                plannedEntityId,
              });
              if (created === "ticket_closed") {
                return { result: { alreadyClosed: true } };
              }
              return { result: requestResult(created, plannedEntityId) };
            },
          });

          if (stored.alreadyClosed === true) {
            return {
              status: "already_closed" as const,
              alreadyClosed: true,
              ticket: ticketOutput(ref.ticketNumber),
              ...flags,
            };
          }
          const request = await loadRequestExpiry(stored.requestId);
          if (!request) {
            throw notFound("ticket");
          }
          return {
            status: "awaiting_approval" as const,
            requestId: request.id,
            expiresAt: request.expiresAt.toISOString(),
            ...(stored.existing === true ? { existingRequest: true } : {}),
            ticket: ticketOutput(ref.ticketNumber),
            approvalNote: APPROVAL_NOTE,
            ...flags,
          };
        }
      )
  );
}

/*------------------------------------------------------- reply_to_customer */

export const replyToCustomerInput = z.strictObject({
  ticket: ticketRefSchema,
  body: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      "The reply, 1-20000 characters, exactly as the user approved it. Plain text by default; set format to html for HTML."
    ),
  format: z
    .enum(["text", "html"])
    .default("text")
    .describe(
      '"text" (default) or "html". HTML is reduced to supported formatting.'
    ),
  expectedUpdatedAt: expectedUpdatedAtSchema,
  clientRequestId: requiredClientRequestIdSchema,
});

const replyToCustomerOutput = z.object({
  status: z.literal("awaiting_approval"),
  ticket: writtenTicketOutput,
  mergedFrom: mergedFromOutput,
  requestId: z.string(),
  expiresAt: z.string(),
  existingRequest: z.boolean().optional(),
  approvalNote: z.string(),
  ...writeFlagsShape,
});
type ReplyToCustomerResult = z.infer<typeof replyToCustomerOutput>;

const REPLY_TOOL = "reply_to_customer";

function repliesDisabledError(): McpToolError {
  return new McpToolError(
    "disabled",
    "Customer replies via MCP are turned off by an admin. Nothing was requested. Use save_reply_draft to leave a draft for the agent instead."
  );
}

/** The per-minute and per-day reply budget of this user. */
async function enforceReplyRateLimits(userId: string): Promise<void> {
  const windows = [
    {
      action: "mcp_replies_minute",
      limit: MCP_RATE_LIMITS.repliesPerMinute,
      windowMinutes: 1,
      label: "minute",
    },
    {
      action: "mcp_replies_day",
      limit: MCP_RATE_LIMITS.repliesPerDay,
      windowMinutes: 24 * 60,
      label: "day",
    },
  ];
  for (const window of windows) {
    const { allowed } = await checkRateLimit({
      action: window.action,
      key: userId,
      limit: window.limit,
      windowMinutes: window.windowMinutes,
    });
    if (!allowed) {
      const retryAfterSeconds = secondsUntilWindowEnds(
        window.windowMinutes * 60_000
      );
      throw new McpToolError(
        "rate_limited",
        `Too many reply requests (limit ${window.limit} per ${window.label}). Retry in ${retryAfterSeconds} seconds.`,
        { retryAfterSeconds }
      );
    }
  }
}

/** Keyed hash of the reply text with whitespace collapsed, so a re-sent reply
 * that differs only in spacing is still recognised. Never the text itself. */
function replyBodyHmac(content: string): string {
  const normalized = richTextToPlainText(content).replace(/\s+/g, " ").trim();
  return hmacToolArgs({ replyBody: normalized });
}

/** An earlier call by this user for this ticket with the same text but another
 * key, which succeeded recently. Its request id (when stored) is returned. */
async function findDuplicateReply(input: {
  userId: string;
  ticketId: string;
  bodyHmac: string;
  clientRequestId: string;
}): Promise<{ requestId: string | null } | null> {
  const [row] = await db
    .select({ resultJson: mcpToolCalls.resultJson })
    .from(mcpToolCalls)
    .where(
      and(
        eq(mcpToolCalls.userId, input.userId),
        eq(mcpToolCalls.tool, REPLY_TOOL),
        eq(mcpToolCalls.targetTicketId, input.ticketId),
        eq(mcpToolCalls.bodyHmac, input.bodyHmac),
        ne(mcpToolCalls.clientRequestId, input.clientRequestId),
        eq(mcpToolCalls.status, "succeeded"),
        gte(
          mcpToolCalls.createdAt,
          new Date(Date.now() - DUPLICATE_REPLY_WINDOW_MS)
        )
      )
    )
    .orderBy(desc(mcpToolCalls.createdAt))
    .limit(1);
  if (!row) {
    return null;
  }
  const id = (row.resultJson as { requestId?: unknown } | null)?.requestId;
  return { requestId: typeof id === "string" ? id : null };
}

export function registerReplyTool(
  server: McpServer,
  principal: McpPrincipal,
  requestId: string,
  permitted: ReadonlySet<string>
) {
  if (!permitted.has(REPLY_TOOL)) {
    return;
  }
  server.registerTool(
    REPLY_TOOL,
    {
      title: "Request a reply to the customer",
      description:
        "Only REQUESTS a reply to the customer; it never sends one. Show the user the exact text and get their approval first. The token owner then approves or dismisses the request on the ticket page in Docket, and approving sends it (it emails the customer). Prefer save_reply_draft, which a human reviews and sends. Check the outcome with get_action_status (requestId). clientRequestId is required: reuse the SAME key when retrying (a repeat returns the same request), use a NEW key for a new reply. Only one reply request per ticket can be pending: while one is, a call returns it (existingRequest: true) and its text is NOT replaced. The same text sent again under a new key within 10 minutes returns duplicate_suspected. Limits: 10 per minute, 100 per day. Closed tickets return ticket_closed; a merged ticket forwards to the ticket it was merged into. Does not touch the owner's reply draft.",
      inputSchema: replyToCustomerInput,
      outputSchema: replyToCustomerOutput,
      // Two keys can request two different replies, so repeating is not free.
      annotations: writeAnnotations({ idempotent: false, openWorld: true }),
      _meta: REQUIRES_USER_INTERACTION_META,
    },
    (args) =>
      safeHandler<ReplyToCustomerResult>(
        { tool: REPLY_TOOL, principal, requestId, args },
        async (call) => {
          // Registered only while the admin setting is on, but it can be turned
          // off while a request is in flight.
          if (!(await isCustomerRepliesEnabled())) {
            throw repliesDisabledError();
          }
          const ref = await resolveTicketRef(args.ticket);
          call.setTarget({ ticketId: ref.id });
          const expectedUpdatedAt = parseExpectedUpdatedAt(
            args.expectedUpdatedAt
          );

          const content =
            args.format === "html"
              ? htmlToRichTextJson(args.body)
              : textToRichTextJson(args.body);
          if (isRichTextEmpty(content)) {
            throw new McpToolError(
              "invalid_input",
              "The body has no visible text, so no reply was requested.",
              { field: "body" }
            );
          }

          await enforceReplyRateLimits(principal.userId);

          const bodyHmac = replyBodyHmac(content);
          const duplicate = await findDuplicateReply({
            userId: principal.userId,
            ticketId: ref.id,
            bodyHmac,
            clientRequestId: args.clientRequestId,
          });
          if (duplicate) {
            throw new McpToolError(
              "duplicate_suspected",
              "A reply with the same text was already requested for this ticket in the last 10 minutes. Nothing new was requested. If you really mean to send it again, change the text or wait.",
              {
                ticketNumber: ref.ticketNumber,
                ...(duplicate.requestId
                  ? { requestId: duplicate.requestId }
                  : {}),
              }
            );
          }

          const { stored, flags } = await runWriteTool({
            tool: REPLY_TOOL,
            principal,
            requestId,
            call,
            args,
            clientRequestId: args.clientRequestId,
            targetTicketId: ref.id,
            bodyHmac,
            reconcile: reconcilePendingActionCall,
            execute: async (plannedEntityId): Promise<ExecuteResult> => {
              const earlier = await requestUnderPlannedId(plannedEntityId);
              if (earlier) {
                return { result: { requestId: earlier } };
              }

              const [ticket] = await db
                .select({
                  status: tickets.status,
                  updatedAt: tickets.updatedAt,
                })
                .from(tickets)
                .where(eq(tickets.id, ref.id))
                .limit(1);
              if (!ticket) {
                throw notFound("ticket");
              }
              if (await isClosedStatusSlug(ticket.status)) {
                throw new McpToolError(
                  "ticket_closed",
                  `Ticket #${ref.ticketNumber} is closed. Replies can't be requested on a closed ticket.`,
                  {
                    ticketNumber: ref.ticketNumber,
                    currentStatus: ticket.status,
                  }
                );
              }
              if (
                expectedUpdatedAt &&
                ticket.updatedAt.getTime() !== expectedUpdatedAt.getTime()
              ) {
                throw staleTicketError(
                  ref.ticketNumber,
                  ticket.updatedAt,
                  "The ticket changed since expectedUpdatedAt. No reply was requested. Read the ticket again and retry with its current updatedAt."
                );
              }
              // Last check before the request exists. (Approving is also
              // refused while the setting is off, so a request that slips in
              // right after an admin turns it off still cannot be sent.)
              if (!(await isCustomerRepliesEnabled())) {
                throw repliesDisabledError();
              }

              const created = await createRequest({
                principal,
                tool: REPLY_TOOL,
                ref,
                kind: "reply",
                payload: { content },
                plannedEntityId,
              });
              if (created === "ticket_closed") {
                throw new McpToolError(
                  "ticket_closed",
                  `Ticket #${ref.ticketNumber} is closed. Replies can't be requested on a closed ticket.`,
                  { ticketNumber: ref.ticketNumber }
                );
              }
              return { result: requestResult(created, plannedEntityId) };
            },
          });

          const request = await loadRequestExpiry(stored.requestId);
          if (!request) {
            throw notFound("ticket");
          }
          const existingRequest = stored.existing === true;
          return {
            status: "awaiting_approval" as const,
            requestId: request.id,
            expiresAt: request.expiresAt.toISOString(),
            ...(existingRequest ? { existingRequest: true } : {}),
            ticket: ticketOutput(ref.ticketNumber),
            ...(ref.mergedFrom ? { mergedFrom: ref.mergedFrom } : {}),
            approvalNote: existingRequest ? EXISTING_REPLY_NOTE : APPROVAL_NOTE,
            ...flags,
          };
        }
      )
  );
}

/* -------------------------------------------------------- get_action_status */

export const getActionStatusInput = z.strictObject({
  requestId: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe(
      "The requestId returned by close_ticket or reply_to_customer. Only your own requests can be read."
    ),
});

const getActionStatusOutput = z.object({
  requestId: z.string(),
  kind: z.enum(["close", "reply"]),
  status: z.enum([
    "pending",
    "approved",
    "dismissed",
    "expired",
    "cancelled",
    "failed",
  ]),
  ticket: writtenTicketOutput,
  createdAt: z.string(),
  expiresAt: z.string(),
  decidedAt: z.string().optional(),
  outcome: z.enum(["closed", "already_closed", "replied"]).optional(),
  commentId: z.string().optional(),
  reason: z.string().optional(),
  sideEffectsUncertain: z.boolean().optional(),
});
type GetActionStatusResult = z.infer<typeof getActionStatusOutput>;

const STATUS_TOOL = "get_action_status";

/** What an approved request did, from its stored result. */
function outcomeOf(result: unknown): {
  outcome?: "closed" | "already_closed" | "replied";
  commentId?: string;
} {
  if (result === null || typeof result !== "object") {
    return {};
  }
  const r = result as Record<string, unknown>;
  if (typeof r.commentId === "string") {
    return { outcome: "replied", commentId: r.commentId };
  }
  if (typeof r.activityId === "string") {
    return { outcome: "closed" };
  }
  if (r.alreadyClosed === true) {
    return { outcome: "already_closed" };
  }
  return {};
}

export function registerActionStatusTool(
  server: McpServer,
  principal: McpPrincipal,
  requestId: string,
  permitted: ReadonlySet<string>
) {
  if (!permitted.has(STATUS_TOOL)) {
    return;
  }
  server.registerTool(
    STATUS_TOOL,
    {
      title: "Check a close or reply request",
      description:
        "Reports where a request made with close_ticket or reply_to_customer stands: pending (waiting for the token owner), approved (with the outcome: closed, already_closed or replied), dismissed, expired (not decided within 24 hours), cancelled (reason says why) or failed. Only your own requests can be read; any other id returns not_found. Never returns the reply text. Read-only.",
      inputSchema: getActionStatusInput,
      outputSchema: getActionStatusOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) =>
      safeHandler<GetActionStatusResult>(
        { tool: STATUS_TOOL, principal, requestId, args },
        async (call) => {
          // Scoped to the caller in the query, so someone else's request and an
          // unknown id are indistinguishable.
          const [row] = await db
            .select({
              id: mcpPendingActions.id,
              kind: mcpPendingActions.kind,
              status: mcpPendingActions.status,
              statusReason: mcpPendingActions.statusReason,
              result: mcpPendingActions.result,
              sideEffectsUncertain: mcpPendingActions.sideEffectsUncertain,
              decidedAt: mcpPendingActions.decidedAt,
              createdAt: mcpPendingActions.createdAt,
              expiresAt: mcpPendingActions.expiresAt,
              ticketId: mcpPendingActions.ticketId,
              ticketNumber: tickets.ticketNumber,
            })
            .from(mcpPendingActions)
            .innerJoin(tickets, eq(tickets.id, mcpPendingActions.ticketId))
            .where(
              and(
                eq(mcpPendingActions.id, args.requestId),
                eq(mcpPendingActions.requestedById, principal.userId)
              )
            )
            .limit(1);
          if (!row) {
            throw new McpToolError("not_found", "No such request.");
          }
          call.setTarget({ ticketId: row.ticketId });

          // A pending row past its expiry reads as expired even before the
          // daily sweep settles it.
          const status =
            row.status === "pending" && row.expiresAt.getTime() <= Date.now()
              ? ("expired" as const)
              : row.status;
          const { outcome, commentId } =
            status === "approved" ? outcomeOf(row.result) : {};
          return {
            requestId: row.id,
            kind: row.kind,
            status,
            ticket: ticketOutput(row.ticketNumber),
            createdAt: row.createdAt.toISOString(),
            expiresAt: row.expiresAt.toISOString(),
            ...(row.decidedAt
              ? { decidedAt: row.decidedAt.toISOString() }
              : {}),
            ...(outcome ? { outcome } : {}),
            ...(commentId ? { commentId } : {}),
            ...(row.statusReason ? { reason: row.statusReason } : {}),
            ...(row.sideEffectsUncertain ? { sideEffectsUncertain: true } : {}),
          };
        }
      )
  );
}
