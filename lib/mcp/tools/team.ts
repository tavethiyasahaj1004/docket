import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { listActiveAgents } from "@/lib/agents";
import { searchCannedResponses } from "@/lib/canned-responses";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { MCP_RESULT_TARGET_CHARS } from "@/lib/mcp/limits";
import { toBodyDto } from "@/lib/mcp/read-dto";
import { safeHandler } from "@/lib/mcp/safe-handler";
import { jsonLength, largestFittingCount } from "@/lib/mcp/size";
import {
  bodyOutputShape,
  maxBodyCharsSchema,
  READ_ONLY_ANNOTATIONS,
} from "@/lib/mcp/tools/common";

export const MCP_AGENT_LIMIT = 200;

/* ------------------------------------------------------------- list_agents */

export const listAgentsInput = z.strictObject({
  query: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Only agents whose name or email contains this text (case-insensitive)."
    ),
});

const listAgentsOutput = z.object({
  agents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      role: z.string(),
    })
  ),
  truncated: z.boolean(),
  truncatedForSize: z.boolean().optional(),
});
type ListAgentsResult = z.infer<typeof listAgentsOutput>;

export function shrinkAgents(result: ListAgentsResult): ListAgentsResult {
  const fits = (n: number) =>
    jsonLength({
      ...result,
      agents: result.agents.slice(0, n),
      truncated: true,
      truncatedForSize: true,
    }) <= MCP_RESULT_TARGET_CHARS;
  const keep = largestFittingCount(result.agents.length, fits);
  return {
    ...result,
    agents: result.agents.slice(0, keep),
    truncated: true,
    truncatedForSize: true,
  };
}

/* ------------------------------------------------ search_canned_responses */

export const cannedInput = z.strictObject({
  query: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Text to find in response titles (case-insensitive). % and _ act as wildcards. Omit to list all."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe("Most responses to return, 1-20. Defaults to 10."),
  maxBodyChars: maxBodyCharsSchema,
});

const cannedOutput = z.object({
  responses: z.array(
    z.object({ id: z.string(), title: z.string(), ...bodyOutputShape })
  ),
  truncatedForSize: z.boolean().optional(),
});
type CannedResult = z.infer<typeof cannedOutput>;

export function shrinkCanned(result: CannedResult): CannedResult {
  const fits = (n: number) =>
    jsonLength({
      ...result,
      responses: result.responses.slice(0, n),
      truncatedForSize: true,
    }) <= MCP_RESULT_TARGET_CHARS;
  const keep = largestFittingCount(result.responses.length, fits);
  return {
    ...result,
    responses: result.responses.slice(0, keep),
    truncatedForSize: true,
  };
}

export function registerTeamTools(
  server: McpServer,
  principal: McpPrincipal,
  requestId: string,
  permitted: ReadonlySet<string>
) {
  if (permitted.has("list_agents")) {
    server.registerTool(
      "list_agents",
      {
        title: "List agents",
        description:
          "Lists the active agents and admins (id, name, email, role), optionally filtered by a name or email substring. At most 200 are returned; truncated says if more exist. Use the id as the assignee filter of list_tickets.",
        inputSchema: listAgentsInput,
        outputSchema: listAgentsOutput,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      (args) =>
        safeHandler<ListAgentsResult>(
          {
            tool: "list_agents",
            principal,
            requestId,
            args,
            shrink: shrinkAgents,
          },
          async () => {
            const needle = args.query?.toLowerCase();
            const matches = (await listActiveAgents())
              .filter(
                (a) =>
                  needle === undefined ||
                  a.name.toLowerCase().includes(needle) ||
                  a.email.toLowerCase().includes(needle)
              )
              .sort(
                (a, b) =>
                  a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
              );
            return {
              agents: matches.slice(0, MCP_AGENT_LIMIT).map((a) => ({
                id: a.id,
                name: a.name,
                email: a.email,
                role: a.role,
              })),
              truncated: matches.length > MCP_AGENT_LIMIT,
            };
          }
        )
    );
  }

  if (permitted.has("search_canned_responses")) {
    server.registerTool(
      "search_canned_responses",
      {
        title: "Search canned responses",
        description:
          "Finds saved reply templates by title (up to limit, default 10, max 20) and returns their text as plain text cut to maxBodyChars, with truncated and fullLength. Read-only: it never sends anything. Omit query to list templates alphabetically.",
        inputSchema: cannedInput,
        outputSchema: cannedOutput,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      (args) =>
        safeHandler<CannedResult>(
          {
            tool: "search_canned_responses",
            principal,
            requestId,
            args,
            shrink: shrinkCanned,
          },
          async () => {
            const rows = await searchCannedResponses(args.query);
            return {
              responses: rows.slice(0, args.limit).map((r) => ({
                id: r.id,
                title: r.title,
                ...toBodyDto(r.content, args.maxBodyChars),
              })),
            };
          }
        )
    );
  }
}
