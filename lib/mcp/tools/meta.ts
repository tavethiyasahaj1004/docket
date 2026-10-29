import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { permittedToolNames } from "@/lib/mcp/authorize";
import {
  type TicketConfigDto,
  toTicketConfigDto,
  toWhoamiDto,
} from "@/lib/mcp/dto";
import { safeHandler } from "@/lib/mcp/safe-handler";
import { getPublicTicketConfig } from "@/lib/ticket-config";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const whoamiOutput = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    role: z.string(),
  }),
  scopes: z.array(z.string()),
  authMethod: z.enum(["pat", "oauth"]),
  credential: z.object({
    id: z.string(),
    name: z.string(),
    expiresAt: z.string(),
  }),
  tools: z.array(z.string()),
});

const ticketConfigOutput = z.object({
  statuses: z.array(
    z.object({
      slug: z.string(),
      label: z.string(),
      isDefault: z.boolean(),
      isClosedState: z.boolean(),
    })
  ),
  priorities: z.array(
    z.object({ slug: z.string(), label: z.string(), isDefault: z.boolean() })
  ),
  categories: z.array(z.object({ slug: z.string(), label: z.string() })),
  customFields: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.string(),
      options: z.array(z.string()).optional(),
      required: z.boolean(),
    })
  ),
  tags: z.array(z.object({ id: z.string(), name: z.string() })),
  tagsTruncated: z.boolean(),
});

/** Registers `whoami` and `get_ticket_config`, each only if `permitted` lists
 * it (so a token never even sees a tool it can't use). */
export function registerMetaTools(
  server: McpServer,
  principal: McpPrincipal,
  requestId: string,
  permitted: ReadonlySet<string>
) {
  if (permitted.has("whoami")) {
    server.registerTool(
      "whoami",
      {
        title: "Who am I",
        description:
          "Returns the Docket agent this token acts as: user (id, name, email, role), granted scopes, the token's name and expiry, and the tools available to it. Call this first to see what you can do. Takes no arguments.",
        inputSchema: z.strictObject({}),
        outputSchema: whoamiOutput,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      (args) =>
        safeHandler({ tool: "whoami", principal, requestId, args }, async () =>
          // The tools this request actually registered (an admin setting can
          // hide one the scopes would allow), in registry order.
          toWhoamiDto(
            principal,
            permittedToolNames(principal).filter((name) => permitted.has(name))
          )
        )
    );
  }

  if (permitted.has("get_ticket_config")) {
    server.registerTool(
      "get_ticket_config",
      {
        title: "Get ticket configuration",
        description:
          "Returns the valid ticket statuses, priorities and categories (by slug), the custom fields, and the shared tag list. Use these slugs rather than guessing. Set includeTags to false to omit tags. At most 200 tags are returned; tagsTruncated says if more exist.",
        inputSchema: z.strictObject({
          includeTags: z
            .boolean()
            .default(true)
            .describe("Include the shared tag list. Defaults to true."),
        }),
        outputSchema: ticketConfigOutput,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      (args) =>
        safeHandler<TicketConfigDto>(
          {
            tool: "get_ticket_config",
            principal,
            requestId,
            args,
            // Tags are the only unbounded part; drop them if the result is huge.
            shrink: (result) => ({
              ...result,
              tags: [],
              tagsTruncated: true,
            }),
          },
          async () =>
            toTicketConfigDto(await getPublicTicketConfig(), {
              includeTags: args.includeTags,
            })
        )
    );
  }
}
