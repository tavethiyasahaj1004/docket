import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { findCustomerByEmail, getCustomerProfile } from "@/lib/customers";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { invalidInput, notFound } from "@/lib/mcp/errors";
import { MCP_RESULT_TARGET_CHARS } from "@/lib/mcp/limits";
import { agentTicketUrl, toStatusDto } from "@/lib/mcp/read-dto";
import { getTicketCustomerId } from "@/lib/mcp/read-queries";
import { safeHandler } from "@/lib/mcp/safe-handler";
import { jsonLength } from "@/lib/mcp/size";
import { resolveTicketRef } from "@/lib/mcp/ticket-ref";
import {
  appUrl,
  loadTicketConfig,
  READ_ONLY_ANNOTATIONS,
  statusOutput,
  ticketRefSchema,
  UNTRUSTED_TEXT_NOTE,
} from "@/lib/mcp/tools/common";

export const getCustomerInput = z.strictObject({
  customerId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("A customer id (from a ticket's customer.id)."),
  email: z
    .string()
    .trim()
    .max(320)
    .email()
    .optional()
    .describe("The customer's email address (looked up, never created)."),
  ticket: ticketRefSchema
    .optional()
    .describe("A ticket number or id: returns that ticket's customer."),
  ticketLimit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe(
      "Most recent open and closed tickets to list, each, 1-50. Defaults to 10."
    ),
  includeNote: z
    .boolean()
    .default(false)
    .describe(
      "Include the agent-written customer note. Off by default because it can hold sensitive remarks."
    ),
});

const customerTicket = z.object({
  id: z.string(),
  number: z.number(),
  subject: z.string(),
  status: statusOutput,
  createdAt: z.string(),
  agentUrl: z.string(),
});

const getCustomerOutput = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  note: z.string().nullable(),
  openTickets: z.array(customerTicket),
  closedTickets: z.array(customerTicket),
  openTotal: z.number(),
  closedTotal: z.number(),
  frequency: z.array(z.object({ month: z.string(), count: z.number() })),
  truncatedForSize: z.boolean().optional(),
});
type GetCustomerResult = z.infer<typeof getCustomerOutput>;

const SHRUNK_TICKETS = 15;

/** Over the size cap: keep fewer tickets per list (the totals still say how
 * many exist). */
export function shrinkCustomer(result: GetCustomerResult): GetCustomerResult {
  const shrunk = {
    ...result,
    openTickets: result.openTickets.slice(0, SHRUNK_TICKETS),
    closedTickets: result.closedTickets.slice(0, SHRUNK_TICKETS),
    truncatedForSize: true,
  };
  if (jsonLength(shrunk) <= MCP_RESULT_TARGET_CHARS) {
    return shrunk;
  }
  return {
    ...shrunk,
    note: shrunk.note === null ? null : shrunk.note.slice(0, 1000),
    openTickets: shrunk.openTickets.slice(0, 5),
    closedTickets: shrunk.closedTickets.slice(0, 5),
  };
}

export function registerCustomerTools(
  server: McpServer,
  principal: McpPrincipal,
  requestId: string,
  permitted: ReadonlySet<string>
) {
  if (!permitted.has("get_customer")) {
    return;
  }
  server.registerTool(
    "get_customer",
    {
      title: "Get a customer",
      description: `Returns one customer's profile and ticket history. Provide exactly one of customerId, email or ticket (the ticket's customer). Includes name, email, open and closed tickets (newest first, up to ticketLimit each, with openTotal and closedTotal giving the real counts) and monthly ticket frequency. The agent-written note is returned only with includeNote true. An unknown customer is reported as not_found. ${UNTRUSTED_TEXT_NOTE}`,
      inputSchema: getCustomerInput,
      outputSchema: getCustomerOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) =>
      safeHandler<GetCustomerResult>(
        {
          tool: "get_customer",
          principal,
          requestId,
          args,
          shrink: shrinkCustomer,
        },
        async (call) => {
          const given = [args.customerId, args.email, args.ticket].filter(
            (v) => v !== undefined
          );
          if (given.length !== 1) {
            throw invalidInput(
              "Provide exactly one of customerId, email or ticket."
            );
          }

          let customerId: string | null = null;
          if (args.customerId !== undefined) {
            customerId = args.customerId;
          } else if (args.email !== undefined) {
            customerId = (await findCustomerByEmail(args.email))?.id ?? null;
          } else if (args.ticket !== undefined) {
            const ticket = await resolveTicketRef(args.ticket);
            call.setTarget({ ticketId: ticket.id });
            customerId = await getTicketCustomerId(ticket.id);
          }
          if (customerId === null) {
            throw notFound("customer");
          }

          const [profile, config] = await Promise.all([
            getCustomerProfile(customerId),
            loadTicketConfig(),
          ]);
          if (!profile) {
            throw notFound("customer");
          }
          call.setTarget({ customerId: profile.id });

          const base = appUrl();
          const toTicket = (t: (typeof profile.openTickets)[number]) => ({
            id: t.id,
            number: t.ticketNumber,
            subject: t.subject,
            status: toStatusDto(config.labels, t.status),
            createdAt: t.createdAt.toISOString(),
            agentUrl: agentTicketUrl(base, t.ticketNumber),
          });

          return {
            id: profile.id,
            name: profile.name,
            email: profile.email,
            note: args.includeNote ? profile.note : null,
            openTickets: profile.openTickets
              .slice(0, args.ticketLimit)
              .map(toTicket),
            closedTickets: profile.closedTickets
              .slice(0, args.ticketLimit)
              .map(toTicket),
            openTotal: profile.openTickets.length,
            closedTotal: profile.closedTickets.length,
            frequency: profile.frequency.map((f) => ({
              month: f.month,
              count: f.count,
            })),
          };
        }
      )
  );
}
