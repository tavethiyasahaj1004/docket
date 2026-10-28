import type { McpServer } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { tickets } from "@/db/schema";
import { db } from "@/lib/db";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { McpToolError, notFound } from "@/lib/mcp/errors";
import type { McpNotificationError } from "@/lib/mcp/limits";
import {
  agentTicketUrl,
  toCategoryDto,
  toPriorityDto,
} from "@/lib/mcp/read-dto";
import { safeHandler } from "@/lib/mcp/safe-handler";
import {
  mergedDuringChangeError,
  resolveTicketRefForChange,
} from "@/lib/mcp/ticket-ref";
import {
  appUrl,
  clientRequestIdSchema,
  loadTicketConfig,
  ticketRefSchema,
  writeAnnotations,
  writeFlagsShape,
} from "@/lib/mcp/tools/common";
import {
  auditMcpWrite,
  mcpActivityMetadata,
  mcpServiceActor,
  runWriteTool,
} from "@/lib/mcp/write-call";
import { getTicketCategories, getTicketPriorities } from "@/lib/ticket-config";
import {
  type ConditionalFieldChangeResult,
  loadTicketForChange,
  setTicketCategory,
  setTicketPriority,
} from "@/lib/tickets/services/ticket-fields";

const FIELDS = ["priority", "category"] as const;
type Field = (typeof FIELDS)[number];

const MAX_ALLOWED_SLUGS = 50;

export const updateTicketFieldsInput = z.strictObject({
  ticket: ticketRefSchema,
  priority: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("New priority slug from get_ticket_config."),
  category: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("New category slug from get_ticket_config."),
  expectedUpdatedAt: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      "The ticket's updatedAt (ISO 8601) as you last read it. If the ticket changed since, nothing is written and the call returns conflict with the current updatedAt."
    ),
  clientRequestId: clientRequestIdSchema,
});

const labelOutput = z.object({ slug: z.string(), label: z.string() });

const updateTicketFieldsOutput = z.object({
  ticket: z.object({
    id: z.string(),
    number: z.number(),
    agentUrl: z.string(),
    priority: labelOutput,
    category: labelOutput,
    updatedAt: z.string(),
  }),
  changed: z.array(z.enum(FIELDS)),
  ...writeFlagsShape,
});
type UpdateTicketFieldsResult = z.infer<typeof updateTicketFieldsOutput>;

const TOOL = "update_ticket_fields";

async function currentUpdatedAtIso(ticketId: string): Promise<string | null> {
  const [row] = await db
    .select({ updatedAt: tickets.updatedAt })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  return row ? row.updatedAt.toISOString() : null;
}

async function loadUpdatedTicket(ticketId: string) {
  const [row] = await db
    .select({
      id: tickets.id,
      ticketNumber: tickets.ticketNumber,
      priority: tickets.priority,
      category: tickets.category,
      updatedAt: tickets.updatedAt,
    })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  return row ?? null;
}

function invalidSlug(field: Field, allowed: string[]): McpToolError {
  return new McpToolError(
    "invalid_input",
    `Unknown ${field} slug. Nothing was changed. Use one of the allowed values.`,
    { field, allowed: allowed.slice(0, MAX_ALLOWED_SLUGS) }
  );
}

export function registerFieldTools(
  server: McpServer,
  principal: McpPrincipal,
  requestId: string,
  permitted: ReadonlySet<string>
) {
  if (!permitted.has(TOOL)) {
    return;
  }
  server.registerTool(
    TOOL,
    {
      title: "Update ticket priority and category",
      description:
        "Changes a ticket's priority and/or category (at least one), using slugs from get_ticket_config. Setting a value the ticket already has changes nothing, so repeating a call is safe. Fires the same outbound webhooks as the Docket UI. Pass expectedUpdatedAt (the ticket's updatedAt as you read it) to avoid overwriting a concurrent change: on a mismatch nothing is written and the call returns conflict with the current updatedAt. When both fields change and the ticket changes in between, the second may conflict after the first was applied; the error says which. Merged tickets return merged. clientRequestId is optional: reuse the same key when retrying.",
      inputSchema: updateTicketFieldsInput,
      outputSchema: updateTicketFieldsOutput,
      annotations: writeAnnotations({ idempotent: true, openWorld: true }),
    },
    (args) =>
      safeHandler<UpdateTicketFieldsResult>(
        { tool: TOOL, principal, requestId, args },
        async (call) => {
          const ref = await resolveTicketRefForChange(args.ticket);
          call.setTarget({ ticketId: ref.id });

          if (args.priority === undefined && args.category === undefined) {
            throw new McpToolError(
              "invalid_input",
              "Provide priority, category or both.",
              { field: "priority" }
            );
          }
          const expectedUpdatedAt =
            args.expectedUpdatedAt === undefined
              ? undefined
              : new Date(args.expectedUpdatedAt);
          if (expectedUpdatedAt && Number.isNaN(expectedUpdatedAt.getTime())) {
            throw new McpToolError(
              "invalid_input",
              "expectedUpdatedAt is not a valid date.",
              { field: "expectedUpdatedAt" }
            );
          }

          const { stored, flags } = await runWriteTool({
            tool: TOOL,
            principal,
            requestId,
            call,
            args,
            clientRequestId: args.clientRequestId,
            targetTicketId: ref.id,
            execute: async () => {
              const snapshot = await loadTicketForChange(ref.id);
              if (snapshot.status === "not_found") {
                throw notFound("ticket");
              }
              if (snapshot.status === "merged") {
                throw await mergedDuringChangeError(ref.id);
              }

              // Validate everything before the first write.
              const [priorities, categories] = await Promise.all([
                getTicketPriorities(),
                getTicketCategories(),
              ]);
              if (
                args.category !== undefined &&
                !categories.some((c) => c.slug === args.category)
              ) {
                throw invalidSlug(
                  "category",
                  categories.map((c) => c.slug)
                );
              }
              if (
                args.priority !== undefined &&
                !priorities.some((p) => p.slug === args.priority)
              ) {
                throw invalidSlug(
                  "priority",
                  priorities.map((p) => p.slug)
                );
              }

              if (
                expectedUpdatedAt &&
                snapshot.ticket.updatedAt.getTime() !==
                  expectedUpdatedAt.getTime()
              ) {
                throw new McpToolError(
                  "conflict",
                  "The ticket changed since expectedUpdatedAt. Nothing was applied. Read the ticket again and retry with its current updatedAt.",
                  {
                    currentUpdatedAt: snapshot.ticket.updatedAt.toISOString(),
                    ticketNumber: ref.ticketNumber,
                  }
                );
              }

              const actor = mcpServiceActor(principal);
              const activityMetadata = mcpActivityMetadata(principal);
              const now = new Date();
              const changed: Field[] = [];
              const notificationErrors: McpNotificationError[] = [];
              // Optimistic-concurrency chain: the first field that actually
              // changes carries the caller's expectedUpdatedAt; each later one
              // must find the exact `now` the previous change wrote, so a
              // concurrent edit between two of them is detected too.
              let expected = expectedUpdatedAt;

              // The generic PATCH route's order: category, then priority.
              const steps: Array<{
                field: Field;
                value: string | undefined;
                apply: typeof setTicketCategory;
              }> = [
                {
                  field: "category",
                  value: args.category,
                  apply: setTicketCategory,
                },
                {
                  field: "priority",
                  value: args.priority,
                  apply: setTicketPriority,
                },
              ];

              for (const step of steps) {
                if (step.value === undefined) {
                  continue;
                }
                const result: ConditionalFieldChangeResult = await step.apply({
                  snapshot,
                  actor,
                  value: step.value,
                  now,
                  activityMetadata,
                  expectedUpdatedAt: expected,
                });
                if (result.status === "invalid") {
                  // Validated above; only a config change in between gets here.
                  throw invalidSlug(
                    step.field,
                    (step.field === "category" ? categories : priorities).map(
                      (o) => o.slug
                    )
                  );
                }
                if (result.status === "conflict") {
                  const currentUpdatedAt = await currentUpdatedAtIso(ref.id);
                  const details = {
                    ...(currentUpdatedAt ? { currentUpdatedAt } : {}),
                    ticketNumber: ref.ticketNumber,
                  };
                  if (changed.length === 0) {
                    throw new McpToolError(
                      "conflict",
                      "The ticket changed since expectedUpdatedAt. Nothing was applied. Read the ticket again and retry with its current updatedAt.",
                      details
                    );
                  }
                  // A partial apply is still a write: audit what happened.
                  await auditMcpWrite({
                    principal,
                    tool: TOOL,
                    ticketId: ref.id,
                    ticketNumber: ref.ticketNumber,
                    description: `Updated ${changed.join(" and ")} on ticket #${ref.ticketNumber} via MCP (partial)`,
                    metadata: { changed, partial: true },
                  });
                  throw new McpToolError(
                    "conflict",
                    `Applied: ${changed.join(", ")}. Not applied: ${step.field}, because the ticket changed in between. Read the ticket again and retry the rest.`,
                    { ...details, field: step.field }
                  );
                }
                if (result.status === "changed") {
                  changed.push(step.field);
                  if (expected) {
                    expected = now;
                  }
                  if (
                    result.webhook === "failed" &&
                    !notificationErrors.includes("webhook_dispatch_failed")
                  ) {
                    notificationErrors.push("webhook_dispatch_failed");
                  }
                }
              }

              if (changed.length > 0) {
                await auditMcpWrite({
                  principal,
                  tool: TOOL,
                  ticketId: ref.id,
                  ticketNumber: ref.ticketNumber,
                  description: `Updated ${changed.join(" and ")} on ticket #${ref.ticketNumber} via MCP`,
                  metadata: { changed },
                });
              }
              return {
                result: { ticketId: ref.id, changed },
                notificationErrors,
              };
            },
          });

          const [ticket, config] = await Promise.all([
            loadUpdatedTicket(ref.id),
            loadTicketConfig(),
          ]);
          if (!ticket) {
            throw notFound("ticket");
          }
          const changedFields = Array.isArray(stored.changed)
            ? FIELDS.filter((f) => (stored.changed as unknown[]).includes(f))
            : [];
          return {
            ticket: {
              id: ticket.id,
              number: ticket.ticketNumber,
              agentUrl: agentTicketUrl(appUrl(), ticket.ticketNumber),
              priority: toPriorityDto(config.labels, ticket.priority),
              category: toCategoryDto(config.labels, ticket.category),
              updatedAt: ticket.updatedAt.toISOString(),
            },
            changed: changedFields,
            ...flags,
          };
        }
      )
  );
}
