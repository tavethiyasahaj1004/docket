import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  coerceCustomFieldValue,
  getCustomFieldValues,
} from "@/lib/custom-fields";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { invalidInput, notFound } from "@/lib/mcp/errors";
import { MCP_RESULT_TARGET_CHARS } from "@/lib/mcp/limits";
import {
  shrinkAttachments,
  toAttachmentDto,
  toBodyDto,
  toStatusDto,
  toTicketSummaryDto,
} from "@/lib/mcp/read-dto";
import {
  getAttachmentMetadata,
  getCommentCounts,
  getPendingRepliesByTicket,
  getTicketExtras,
  userExists,
} from "@/lib/mcp/read-queries";
import { safeHandler } from "@/lib/mcp/safe-handler";
import { jsonLength, largestFittingCount } from "@/lib/mcp/size";
import { resolveTicketRef } from "@/lib/mcp/ticket-ref";
import {
  appUrl,
  attachmentOutput,
  bodyOutputShape,
  loadTicketConfig,
  maxBodyCharsSchema,
  mergedFromOutput,
  READ_ONLY_ANNOTATIONS,
  resolveInternalAccess,
  statusOutput,
  ticketRefSchema,
  UNTRUSTED_TEXT_NOTE,
} from "@/lib/mcp/tools/common";
import { getTicketTagsForTickets, normalizeTagName } from "@/lib/tags";
import { getTicketLinks } from "@/lib/tickets/links";
import { getTicketDetail, listTicketsForAgent } from "@/lib/tickets/queries";
import type { TicketListSearchParams } from "@/lib/tickets-list-query";

const labelOutput = z.object({ slug: z.string(), label: z.string() });

const ticketSummaryShape = {
  id: z.string(),
  number: z.number(),
  subject: z.string(),
  status: statusOutput,
  priority: labelOutput,
  category: labelOutput,
  assignee: z.object({ id: z.string(), name: z.string() }).nullable(),
  awaitingReply: z.boolean(),
  pendingReplies: z.number(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  agentUrl: z.string(),
};

/* ------------------------------------------------------------ list_tickets */

const LIST_SORTS = {
  number: "id",
  updated: "updatedAt",
  waiting_time: "waitingTime",
} as const;

export const listTicketsInput = z.strictObject({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Search text (1-200 chars): matches ticket subject, customer name or email, or an exact #number. Not message bodies. % and _ act as wildcards."
    ),
  status: z
    .array(z.string().min(1).max(100))
    .min(1)
    .max(20)
    .optional()
    .describe(
      "One or more status slugs from get_ticket_config. A ticket matches any of them."
    ),
  view: z
    .enum(["open", "awaiting"])
    .optional()
    .describe(
      'Queue tab: "open" = any non-closed status; "awaiting" = open and awaiting an agent reply.'
    ),
  priority: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Priority slug from get_ticket_config."),
  category: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Category slug from get_ticket_config."),
  assignee: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      '"me" (the token owner), "unassigned", or an agent id from list_agents. An unknown id is an error.'
    ),
  tag: z
    .string()
    .min(1)
    .max(50)
    .optional()
    .describe("Tag name (matched case-insensitively)."),
  awaitingReply: z
    .boolean()
    .optional()
    .describe("When true, only tickets awaiting an agent reply."),
  createdAfter: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Only tickets created on or after this day (YYYY-MM-DD)."),
  createdBefore: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Only tickets created on or before this day (YYYY-MM-DD)."),
  sort: z
    .enum(["number", "updated", "waiting_time"])
    .default("updated")
    .describe('Sort key. Defaults to "updated".'),
  order: z
    .enum(["asc", "desc"])
    .default("desc")
    .describe('Sort direction. Defaults to "desc".'),
  page: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(1)
    .describe("Page number, 1-1000. Defaults to 1."),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe("Tickets per page, 1-50. Defaults to 20."),
});
export type ListTicketsArgs = z.infer<typeof listTicketsInput>;

const listTicketsOutput = z.object({
  tickets: z.array(
    z.object({
      ...ticketSummaryShape,
      customer: z.object({ id: z.string(), name: z.string() }),
    })
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
  truncatedForSize: z.boolean().optional(),
});
type ListTicketsResult = z.infer<typeof listTicketsOutput>;

const isRealDay = (value: string) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};

/** Validates the filters against live config and maps them 1:1 onto the agent
 * list page's search params. Throws `invalid_input` on any unknown value. */
export function buildTicketListParams(
  args: ListTicketsArgs,
  config: {
    statusSlugs: ReadonlySet<string>;
    prioritySlugs: ReadonlySet<string>;
    categorySlugs: ReadonlySet<string>;
  }
): TicketListSearchParams {
  const params: TicketListSearchParams = {
    sort: LIST_SORTS[args.sort],
    order: args.order,
    page: String(args.page),
  };

  if (args.query !== undefined) {
    params.q = args.query;
  }
  if (args.status !== undefined) {
    const slugs = [...new Set(args.status)];
    if (slugs.some((s) => !config.statusSlugs.has(s))) {
      throw invalidInput(
        "Unknown status slug. Use get_ticket_config for the valid slugs."
      );
    }
    params.status = slugs.join(",");
  }
  if (args.view !== undefined) {
    params.view = args.view;
  }
  if (args.priority !== undefined) {
    if (!config.prioritySlugs.has(args.priority)) {
      throw invalidInput(
        "Unknown priority slug. Use get_ticket_config for the valid slugs."
      );
    }
    params.priority = args.priority;
  }
  if (args.category !== undefined) {
    if (!config.categorySlugs.has(args.category)) {
      throw invalidInput(
        "Unknown category slug. Use get_ticket_config for the valid slugs."
      );
    }
    params.category = args.category;
  }
  if (args.assignee !== undefined) {
    if (args.assignee === "me") {
      params.mine = "1";
    } else {
      params.assignee = args.assignee;
    }
  }
  if (args.tag !== undefined) {
    const tag = normalizeTagName(args.tag);
    if (tag.length === 0) {
      throw invalidInput("tag must not be blank.");
    }
    params.tag = tag;
  }
  if (args.awaitingReply === true) {
    params.awaiting = "1";
  }
  for (const [name, value] of [
    ["createdAfter", args.createdAfter],
    ["createdBefore", args.createdBefore],
  ] as const) {
    if (value !== undefined && !isRealDay(value)) {
      throw invalidInput(`${name} must be a real date in YYYY-MM-DD form.`);
    }
  }
  if (args.createdAfter !== undefined || args.createdBefore !== undefined) {
    params.range = "custom";
    params.from = args.createdAfter;
    params.to = args.createdBefore;
  }
  return params;
}

/** Over the size cap: keep the longest prefix of tickets that fits the target. */
export function shrinkTicketList(result: ListTicketsResult): ListTicketsResult {
  const fits = (n: number) =>
    jsonLength({
      ...result,
      tickets: result.tickets.slice(0, n),
      hasMore: true,
      truncatedForSize: true,
    }) <= MCP_RESULT_TARGET_CHARS;
  const keep = largestFittingCount(result.tickets.length, fits);
  return {
    ...result,
    tickets: result.tickets.slice(0, keep),
    hasMore: true,
    truncatedForSize: true,
  };
}

/* -------------------------------------------------------------- get_ticket */

export const getTicketInput = z.strictObject({
  ticket: ticketRefSchema,
  includeInternal: z
    .boolean()
    .default(false)
    .describe(
      "Include internal notes' attachments and the internal comment count. Needs the tickets:read_internal scope on the token; without it, true is an error."
    ),
  maxBodyChars: maxBodyCharsSchema,
});

const getTicketOutput = z.object({
  ...ticketSummaryShape,
  customer: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  description: z.object(bodyOutputShape),
  source: z.string(),
  customFields: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    })
  ),
  links: z.array(
    z.object({
      type: z.string(),
      direction: z.enum(["outgoing", "incoming"]),
      ticket: z.object({
        number: z.number(),
        subject: z.string(),
        status: statusOutput,
      }),
    })
  ),
  attachments: z.array(attachmentOutput),
  sla: z.object({
    waitingSince: z.string().nullable(),
    firstRespondedAt: z.string().nullable(),
  }),
  commentCounts: z.object({
    public: z.number(),
    internal: z.number().optional(),
  }),
  mergedFrom: mergedFromOutput,
  truncatedForSize: z.boolean().optional(),
});
type GetTicketResult = z.infer<typeof getTicketOutput>;

const SHRUNK_BODY_CHARS = 1000;

/** Over the size cap: shorten the description, then cap the unbounded lists. */
export function shrinkTicketDetail(result: GetTicketResult): GetTicketResult {
  const stages: ((r: GetTicketResult) => GetTicketResult)[] = [
    (r) => ({
      ...r,
      description: {
        ...r.description,
        body: r.description.body.slice(0, SHRUNK_BODY_CHARS),
        truncated:
          r.description.truncated ||
          r.description.body.length > SHRUNK_BODY_CHARS,
      },
    }),
    (r) => ({
      ...r,
      attachments: shrinkAttachments(r.attachments),
      links: r.links.slice(0, 20),
      customFields: r.customFields.slice(0, 50),
      tags: r.tags.slice(0, 50),
    }),
    (r) => ({
      ...r,
      description: { ...r.description, body: "", truncated: true },
    }),
  ];
  let current: GetTicketResult = { ...result, truncatedForSize: true };
  for (const stage of stages) {
    if (jsonLength(current) <= MCP_RESULT_TARGET_CHARS) {
      break;
    }
    current = stage(current);
  }
  return current;
}

const toFieldValue = (type: string, value: string | null) => {
  const coerced = coerceCustomFieldValue(type, value);
  return typeof coerced === "number" && Number.isNaN(coerced) ? null : coerced;
};

export function registerTicketTools(
  server: McpServer,
  principal: McpPrincipal,
  requestId: string,
  permitted: ReadonlySet<string>
) {
  if (permitted.has("list_tickets")) {
    server.registerTool(
      "list_tickets",
      {
        title: "List tickets",
        description: `Lists ticket summaries (no message bodies, no customer email), filtered and paginated like the agent ticket list. Search matches subject, customer name/email and #number only, not message bodies or descriptions, and % and _ act as wildcards. Filter by status, view (open|awaiting), priority, category (slugs from get_ticket_config), assignee (me|unassigned|agent id; an unknown id is invalid_input), tag, awaitingReply and created date range. Paginate with page (1-1000) and pageSize (1-50, default 20); hasMore says if more pages exist. If truncatedForSize is true, repeat with a smaller pageSize. ${UNTRUSTED_TEXT_NOTE}`,
        inputSchema: listTicketsInput,
        outputSchema: listTicketsOutput,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      (args) =>
        safeHandler<ListTicketsResult>(
          {
            tool: "list_tickets",
            principal,
            requestId,
            args,
            shrink: shrinkTicketList,
          },
          async () => {
            const config = await loadTicketConfig();
            const params = buildTicketListParams(args, {
              statusSlugs: new Set(config.statuses.map((s) => s.slug)),
              prioritySlugs: new Set(config.priorities.map((p) => p.slug)),
              categorySlugs: new Set(config.categories.map((c) => c.slug)),
            });
            // An id that names no user would silently match nothing, which a
            // model could read as "no tickets" (e.g. after passing a name).
            if (
              params.assignee !== undefined &&
              params.assignee !== "unassigned" &&
              !(await userExists(params.assignee))
            ) {
              throw invalidInput(
                'Unknown assignee. Use "me", "unassigned" or an agent id from list_agents.'
              );
            }
            const list = await listTicketsForAgent({
              params,
              agentId: principal.userId,
              openStatusSlugs: config.statuses
                .filter((s) => !s.isClosedState)
                .map((s) => s.slug),
              pageSizeOverride: args.pageSize,
            });
            const ids = list.rows.map((r) => r.id);
            const [tagsById, pendingById] = await Promise.all([
              getTicketTagsForTickets(ids),
              getPendingRepliesByTicket(ids),
            ]);
            return {
              tickets: list.rows.map((r) =>
                toTicketSummaryDto(
                  {
                    id: r.id,
                    ticketNumber: r.ticketNumber,
                    subject: r.subject,
                    status: r.status,
                    priority: r.priority,
                    category: r.category,
                    customerId: r.customerId,
                    customerName: r.customerName,
                    assignedAgentId: r.assignedAgentId,
                    assigneeName: r.assignedAgentName,
                    awaitingReply: r.awaitingReply,
                    pendingReplies: pendingById.get(r.id) ?? 0,
                    tags: tagsById[r.id] ?? [],
                    createdAt: r.createdAt,
                    updatedAt: r.updatedAt,
                    closedAt: r.closedAt,
                  },
                  config.labels,
                  appUrl()
                )
              ),
              page: list.page,
              pageSize: list.pageSize,
              total: list.total,
              hasMore: list.page * list.pageSize < list.total,
            };
          }
        )
    );
  }

  if (permitted.has("get_ticket")) {
    server.registerTool(
      "get_ticket",
      {
        title: "Get a ticket",
        description: `Returns one ticket by number or id: status, priority, category, assignee, tags, the customer (with email), the description, custom fields, linked tickets, attachment metadata (no file content), SLA timestamps and comment counts. Internal notes are never included unless the token has the tickets:read_internal scope and includeInternal is true. A merged ticket resolves to its target, reported in mergedFrom. Descriptions are cut to maxBodyChars. ${UNTRUSTED_TEXT_NOTE}`,
        inputSchema: getTicketInput,
        outputSchema: getTicketOutput,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      (args) =>
        safeHandler<GetTicketResult>(
          {
            tool: "get_ticket",
            principal,
            requestId,
            args,
            shrink: shrinkTicketDetail,
          },
          async (call) => {
            const includeInternal = resolveInternalAccess(
              principal,
              args.includeInternal
            );
            const resolved = await resolveTicketRef(args.ticket);
            call.setTarget({ ticketId: resolved.id });

            const [
              detail,
              extras,
              config,
              fieldValues,
              links,
              attachments,
              counts,
            ] = await Promise.all([
              getTicketDetail(resolved.id),
              getTicketExtras(resolved.id),
              loadTicketConfig(),
              getCustomFieldValues(resolved.id),
              getTicketLinks(resolved.id),
              getAttachmentMetadata(resolved.id),
              getCommentCounts(resolved.id),
            ]);
            if (!(detail && extras)) {
              throw notFound("ticket");
            }

            const summary = toTicketSummaryDto(
              {
                id: detail.id,
                ticketNumber: detail.ticketNumber,
                subject: detail.subject,
                status: detail.status,
                priority: detail.priority,
                category: detail.category,
                customerId: detail.customerId,
                customerName: detail.customerName,
                assignedAgentId: detail.assignedAgentId,
                assigneeName: extras.assigneeName,
                awaitingReply: extras.awaitingReply,
                pendingReplies: extras.pendingReplies,
                tags: detail.tags.map((t) => t.name),
                createdAt: detail.createdAt,
                updatedAt: detail.updatedAt,
                closedAt: detail.closedAt,
              },
              config.labels,
              appUrl()
            );

            return {
              ...summary,
              customer: { ...summary.customer, email: detail.customerEmail },
              description: toBodyDto(detail.description, args.maxBodyChars),
              source: extras.source,
              customFields: fieldValues.map((f) => ({
                key: f.key,
                label: f.label,
                value: toFieldValue(f.type, f.value),
              })),
              links: links.map((l) => ({
                type: l.type,
                direction: l.direction,
                ticket: {
                  number: l.ticket.ticketNumber,
                  subject: l.ticket.subject,
                  status: toStatusDto(config.labels, l.ticket.status),
                },
              })),
              attachments: attachments
                .filter((a) => includeInternal || a.onInternalNote !== true)
                .map(toAttachmentDto),
              sla: {
                waitingSince: extras.waitingSince
                  ? extras.waitingSince.toISOString()
                  : null,
                firstRespondedAt: extras.firstRespondedAt
                  ? extras.firstRespondedAt.toISOString()
                  : null,
              },
              commentCounts: includeInternal
                ? { public: counts.public, internal: counts.internal }
                : { public: counts.public },
              ...(resolved.mergedFrom
                ? { mergedFrom: resolved.mergedFrom }
                : {}),
            };
          }
        )
    );
  }
}
