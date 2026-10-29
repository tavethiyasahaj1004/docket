// Ticket-state tools (tickets:manage): assign, change status, reopen. Each runs
// the same service the Docket UI runs, as the token owner. Closing is NOT here:
// it reaches the customer, so close_ticket (approvals.ts) only creates a request
// the owner approves in Docket.
import type { McpServer } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { user } from "@/db/schema";
import { db } from "@/lib/db";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { McpToolError, notFound } from "@/lib/mcp/errors";
import type { McpNotificationError } from "@/lib/mcp/limits";
import { agentTicketUrl } from "@/lib/mcp/read-dto";
import { safeHandler } from "@/lib/mcp/safe-handler";
import {
  mergedDuringChangeError,
  type ResolvedTicket,
  resolveTicketRefForChange,
} from "@/lib/mcp/ticket-ref";
import {
  appUrl,
  clientRequestIdSchema,
  currentUpdatedAt,
  expectedUpdatedAtSchema,
  parseExpectedUpdatedAt,
  REQUIRES_USER_INTERACTION_META,
  staleTicketError,
  ticketRefSchema,
  writeAnnotations,
  writeFlagsShape,
  writtenTicketOutput,
} from "@/lib/mcp/tools/common";
import {
  auditMcpWrite,
  mcpActivityMetadata,
  mcpServiceActor,
  runWriteTool,
} from "@/lib/mcp/write-call";
import { isEligibleMcpRole } from "@/lib/mcp-tokens";
import { getTicketStatuses, isClosedStatusSlug } from "@/lib/ticket-config";
import { reopenTicket } from "@/lib/tickets/services/reopen";
import {
  assignTicket,
  changeTicketStatusGeneric,
  loadTicketForChange,
} from "@/lib/tickets/services/ticket-fields";

const MAX_ALLOWED_SLUGS = 50;

/** The ticket, loaded for a change: gone is `not_found`, merged (a merge raced
 * the call) names the ticket to use instead. */
async function loadChangeSnapshot(ref: ResolvedTicket) {
  const snapshot = await loadTicketForChange(ref.id);
  if (snapshot.status === "not_found") {
    throw notFound("ticket");
  }
  if (snapshot.status === "merged") {
    throw await mergedDuringChangeError(ref.id);
  }
  return snapshot;
}

async function staleError(ref: ResolvedTicket) {
  return staleTicketError(ref.ticketNumber, await currentUpdatedAt(ref.id));
}

function ticketOutput(ticketNumber: number) {
  return {
    number: ticketNumber,
    agentUrl: agentTicketUrl(appUrl(), ticketNumber),
  };
}

/* ----------------------------------------------------------- assign_ticket */

const agentOutput = z.object({ id: z.string(), name: z.string() }).nullable();

export const assignTicketInput = z.strictObject({
  ticket: ticketRefSchema,
  assignee: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe(
      '"me" (the token owner), "unassigned", or the id of an active agent or admin from list_agents.'
    ),
  expectedUpdatedAt: expectedUpdatedAtSchema,
  clientRequestId: clientRequestIdSchema,
});

const assignTicketOutput = z.object({
  ticket: writtenTicketOutput,
  assignee: agentOutput,
  previousAssignee: agentOutput,
  changed: z.boolean(),
  ...writeFlagsShape,
});
type AssignTicketResult = z.infer<typeof assignTicketOutput>;

const ASSIGN_TOOL = "assign_ticket";

/** The new assignee, with the bulk-assign route's rule: the user exists, is an
 * agent or admin, and is not banned. Null = unassigned. */
async function resolveAssignee(
  principal: McpPrincipal,
  assignee: string
): Promise<string | null> {
  if (assignee === "unassigned") {
    return null;
  }
  const id = assignee === "me" ? principal.userId : assignee;
  const [row] = await db
    .select({ id: user.id, role: user.role, banned: user.banned })
    .from(user)
    .where(eq(user.id, id))
    .limit(1);
  if (!row || !isEligibleMcpRole(row.role) || row.banned === true) {
    throw new McpToolError(
      "invalid_input",
      'assignee must be "me", "unassigned" or the id of an active agent or admin (see list_agents). Nothing was changed.',
      { field: "assignee" }
    );
  }
  return row.id;
}

async function loadAgent(id: unknown) {
  if (typeof id !== "string") {
    return null;
  }
  const [row] = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(eq(user.id, id))
    .limit(1);
  return row ?? null;
}

export function registerAssignTool(
  server: McpServer,
  principal: McpPrincipal,
  requestId: string,
  permitted: ReadonlySet<string>
) {
  if (!permitted.has(ASSIGN_TOOL)) {
    return;
  }
  server.registerTool(
    ASSIGN_TOOL,
    {
      title: "Assign a ticket",
      description:
        'Assigns a ticket to "me" (the token owner), to another active agent or admin by id (see list_agents), or to "unassigned". Confirm with the user first. Assigning to the current assignee changes nothing, so repeating a call is safe. The new assignee is NOT notified; the Docket UI and the outbound webhooks (ticket.assigned / ticket.unassigned) behave as for a manual assignment. Pass expectedUpdatedAt (the ticket\'s updatedAt as you read it) to avoid overwriting a concurrent change: on a mismatch nothing is written and the call returns conflict. Merged tickets return merged. clientRequestId is optional: reuse the same key when retrying.',
      inputSchema: assignTicketInput,
      outputSchema: assignTicketOutput,
      annotations: writeAnnotations({ idempotent: true, openWorld: true }),
      _meta: REQUIRES_USER_INTERACTION_META,
    },
    (args) =>
      safeHandler<AssignTicketResult>(
        { tool: ASSIGN_TOOL, principal, requestId, args },
        async (call) => {
          const ref = await resolveTicketRefForChange(args.ticket);
          call.setTarget({ ticketId: ref.id });
          const expectedUpdatedAt = parseExpectedUpdatedAt(
            args.expectedUpdatedAt
          );

          const { stored, flags } = await runWriteTool({
            tool: ASSIGN_TOOL,
            principal,
            requestId,
            call,
            args,
            clientRequestId: args.clientRequestId,
            targetTicketId: ref.id,
            execute: async () => {
              const snapshot = await loadChangeSnapshot(ref);
              // Validated before anything is written.
              const target = await resolveAssignee(principal, args.assignee);
              const previous = snapshot.ticket.assignedAgentId;

              if (
                expectedUpdatedAt &&
                snapshot.ticket.updatedAt.getTime() !==
                  expectedUpdatedAt.getTime()
              ) {
                throw await staleError(ref);
              }
              if (target === previous) {
                return {
                  result: {
                    changed: false,
                    assigneeId: target,
                    previousAssigneeId: previous,
                  },
                };
              }

              // Activity row and webhook only, as in the UI: no in-app
              // notification or push reaches the new assignee (D5).
              const result = await assignTicket({
                snapshot,
                actor: mcpServiceActor(principal),
                value: target,
                now: new Date(),
                activityMetadata: mcpActivityMetadata(principal),
                expectedUpdatedAt,
              });
              if (result.status === "conflict") {
                throw await staleError(ref);
              }
              if (result.status === "invalid") {
                // assignTicket validates nothing; unreachable.
                throw new Error("Unexpected assignment result.");
              }
              if (result.status === "unchanged") {
                // A concurrent assignment won between the read and the write.
                return {
                  result: {
                    changed: false,
                    assigneeId: target,
                    previousAssigneeId: previous,
                  },
                };
              }

              await auditMcpWrite({
                principal,
                tool: ASSIGN_TOOL,
                ticketId: ref.id,
                ticketNumber: ref.ticketNumber,
                description: target
                  ? `Assigned ticket #${ref.ticketNumber} via MCP`
                  : `Unassigned ticket #${ref.ticketNumber} via MCP`,
                metadata: { assigneeId: target, previousAssigneeId: previous },
              });
              const notificationErrors: McpNotificationError[] =
                result.webhook === "failed" ? ["webhook_dispatch_failed"] : [];
              return {
                result: {
                  changed: true,
                  assigneeId: target,
                  previousAssigneeId: previous,
                },
                notificationErrors,
              };
            },
          });

          const [assignee, previousAssignee] = await Promise.all([
            loadAgent(stored.assigneeId),
            loadAgent(stored.previousAssigneeId),
          ]);
          return {
            ticket: ticketOutput(ref.ticketNumber),
            assignee,
            previousAssignee,
            changed: stored.changed === true,
            ...flags,
          };
        }
      )
  );
}

/* -------------------------------------------------------- set_ticket_status */

export const setTicketStatusInput = z.strictObject({
  ticket: ticketRefSchema,
  status: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe(
      "New status slug from get_ticket_config. Closed statuses are refused: use close_ticket."
    ),
  expectedUpdatedAt: expectedUpdatedAtSchema,
  clientRequestId: clientRequestIdSchema,
});

const setTicketStatusOutput = z.object({
  ticket: writtenTicketOutput,
  status: z.string(),
  previousStatus: z.string(),
  changed: z.boolean(),
  ...writeFlagsShape,
});
type SetTicketStatusResult = z.infer<typeof setTicketStatusOutput>;

const STATUS_TOOL = "set_ticket_status";

export function registerStatusTool(
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
      title: "Change a ticket's status",
      description:
        "Moves an open ticket to another OPEN status, using a slug from get_ticket_config. A closed status is refused (conflict): use close_ticket. A closed ticket is refused (conflict): use reopen_ticket. Setting the status the ticket already has changes nothing, so repeating a call is safe. Fires the same outbound webhook as the Docket UI and sends no customer email. Pass expectedUpdatedAt (the ticket's updatedAt as you read it) to avoid overwriting a concurrent change: on a mismatch nothing is written and the call returns conflict. While another status or reopen call on the same ticket is running the call returns in_progress. Merged tickets return merged. clientRequestId is optional: reuse the same key when retrying.",
      inputSchema: setTicketStatusInput,
      outputSchema: setTicketStatusOutput,
      annotations: writeAnnotations({ idempotent: true, openWorld: true }),
    },
    (args) =>
      safeHandler<SetTicketStatusResult>(
        { tool: STATUS_TOOL, principal, requestId, args },
        async (call) => {
          const ref = await resolveTicketRefForChange(args.ticket);
          call.setTarget({ ticketId: ref.id });
          const expectedUpdatedAt = parseExpectedUpdatedAt(
            args.expectedUpdatedAt
          );

          const { stored, flags } = await runWriteTool({
            tool: STATUS_TOOL,
            principal,
            requestId,
            call,
            args,
            clientRequestId: args.clientRequestId,
            targetTicketId: ref.id,
            lockGroup: "ticket_state",
            execute: async () => {
              const snapshot = await loadChangeSnapshot(ref);
              const statuses = await getTicketStatuses();
              const target = statuses.find((s) => s.slug === args.status);
              if (!target) {
                throw new McpToolError(
                  "invalid_input",
                  "Unknown status slug. Nothing was changed. Use one of the allowed values.",
                  {
                    field: "status",
                    allowed: statuses
                      .map((s) => s.slug)
                      .slice(0, MAX_ALLOWED_SLUGS),
                  }
                );
              }
              const current = snapshot.ticket.status;
              if (target.isClosedState) {
                throw new McpToolError(
                  "conflict",
                  "Closing goes through close_ticket, which asks the ticket owner to approve it. Nothing was changed.",
                  { field: "status", ticketNumber: ref.ticketNumber }
                );
              }
              if (statuses.find((s) => s.slug === current)?.isClosedState) {
                throw new McpToolError(
                  "conflict",
                  `Ticket #${ref.ticketNumber} is closed. Reopening goes through reopen_ticket. Nothing was changed.`,
                  { currentStatus: current, ticketNumber: ref.ticketNumber }
                );
              }
              if (
                expectedUpdatedAt &&
                snapshot.ticket.updatedAt.getTime() !==
                  expectedUpdatedAt.getTime()
              ) {
                throw await staleError(ref);
              }
              if (target.slug === current) {
                return {
                  result: {
                    changed: false,
                    status: current,
                    previousStatus: current,
                  },
                };
              }

              const result = await changeTicketStatusGeneric({
                snapshot,
                actor: mcpServiceActor(principal),
                value: target.slug,
                now: new Date(),
                activityMetadata: mcpActivityMetadata(principal),
                expectedUpdatedAt,
              });
              if (result.status === "conflict") {
                throw await staleError(ref);
              }
              if (result.status === "invalid") {
                // Validated above; only a config change in between gets here.
                throw new McpToolError(
                  "invalid_input",
                  "Unknown status slug. Nothing was changed. Use one of the allowed values.",
                  { field: "status" }
                );
              }
              if (result.status === "unchanged") {
                return {
                  result: {
                    changed: false,
                    status: current,
                    previousStatus: current,
                  },
                };
              }

              await auditMcpWrite({
                principal,
                tool: STATUS_TOOL,
                ticketId: ref.id,
                ticketNumber: ref.ticketNumber,
                description: `Changed the status of ticket #${ref.ticketNumber} via MCP`,
                metadata: { from: current, to: target.slug },
              });
              const notificationErrors: McpNotificationError[] =
                result.webhook === "failed" ? ["webhook_dispatch_failed"] : [];
              return {
                result: {
                  changed: true,
                  status: target.slug,
                  previousStatus: current,
                },
                notificationErrors,
              };
            },
          });

          return {
            ticket: ticketOutput(ref.ticketNumber),
            status: String(stored.status),
            previousStatus: String(stored.previousStatus),
            changed: stored.changed === true,
            ...flags,
          };
        }
      )
  );
}

/* ------------------------------------------------------------ reopen_ticket */

export const reopenTicketInput = z.strictObject({
  ticket: ticketRefSchema,
  expectedUpdatedAt: expectedUpdatedAtSchema,
  clientRequestId: clientRequestIdSchema,
});

const reopenTicketOutput = z.object({
  ticket: writtenTicketOutput,
  status: z.string(),
  alreadyOpen: z.boolean(),
  ...writeFlagsShape,
});
type ReopenTicketResult = z.infer<typeof reopenTicketOutput>;

const REOPEN_TOOL = "reopen_ticket";

export function registerReopenTool(
  server: McpServer,
  principal: McpPrincipal,
  requestId: string,
  permitted: ReadonlySet<string>
) {
  if (!permitted.has(REOPEN_TOOL)) {
    return;
  }
  server.registerTool(
    REOPEN_TOOL,
    {
      title: "Reopen a closed ticket",
      description:
        "Reopens a closed ticket to the default open status, exactly as an agent reopening it in Docket (the SLA clock restarts; the ticket.reopened webhook fires; no email is sent to the customer). Confirm with the user first. A ticket that is not closed changes nothing and returns alreadyOpen: true, so repeating a call is safe. Pass expectedUpdatedAt (the ticket's updatedAt as you read it) to avoid overwriting a concurrent change: on a mismatch nothing is written and the call returns conflict. While another status or reopen call on the same ticket is running the call returns in_progress. Merged tickets return merged. clientRequestId is optional: reuse the same key when retrying.",
      inputSchema: reopenTicketInput,
      outputSchema: reopenTicketOutput,
      annotations: writeAnnotations({ idempotent: true, openWorld: true }),
    },
    (args) =>
      safeHandler<ReopenTicketResult>(
        { tool: REOPEN_TOOL, principal, requestId, args },
        async (call) => {
          const ref = await resolveTicketRefForChange(args.ticket);
          call.setTarget({ ticketId: ref.id });
          const expectedUpdatedAt = parseExpectedUpdatedAt(
            args.expectedUpdatedAt
          );

          const { stored, flags } = await runWriteTool({
            tool: REOPEN_TOOL,
            principal,
            requestId,
            call,
            args,
            clientRequestId: args.clientRequestId,
            targetTicketId: ref.id,
            lockGroup: "ticket_state",
            execute: async () => {
              const snapshot = await loadChangeSnapshot(ref);
              const current = snapshot.ticket.status;
              if (
                expectedUpdatedAt &&
                snapshot.ticket.updatedAt.getTime() !==
                  expectedUpdatedAt.getTime()
              ) {
                throw await staleError(ref);
              }
              if (!(await isClosedStatusSlug(current))) {
                return { result: { alreadyOpen: true, status: current } };
              }

              const result = await reopenTicket({
                ticketId: ref.id,
                actor: mcpServiceActor(principal),
                activityMetadata: mcpActivityMetadata(principal),
                expectedUpdatedAt,
              });
              switch (result.status) {
                case "not_found":
                  throw notFound("ticket");
                case "merged":
                  throw await mergedDuringChangeError(ref.id);
                case "conflict":
                  throw await staleError(ref);
                case "not_closed":
                  // Reopened by someone else between the read and the write.
                  return { result: { alreadyOpen: true, status: current } };
                case "no_default_status":
                  throw new McpToolError(
                    "conflict",
                    `Ticket #${ref.ticketNumber} was not reopened: no default status is configured in Docket. An admin must set one.`,
                    { ticketNumber: ref.ticketNumber }
                  );
                default:
                  break;
              }

              await auditMcpWrite({
                principal,
                tool: REOPEN_TOOL,
                ticketId: ref.id,
                ticketNumber: ref.ticketNumber,
                description: `Reopened ticket #${ref.ticketNumber} via MCP`,
                metadata: { from: result.previousStatus, to: result.slug },
              });
              const notificationErrors: McpNotificationError[] =
                result.webhook === "failed" ? ["webhook_dispatch_failed"] : [];
              return {
                result: { alreadyOpen: false, status: result.slug },
                notificationErrors,
              };
            },
          });

          return {
            ticket: ticketOutput(ref.ticketNumber),
            status: String(stored.status),
            alreadyOpen: stored.alreadyOpen === true,
            ...flags,
          };
        }
      )
  );
}
