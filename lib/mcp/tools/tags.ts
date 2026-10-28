import type { McpServer } from "@modelcontextprotocol/server";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { tags } from "@/db/schema";
import { db } from "@/lib/db";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { McpToolError, notFound } from "@/lib/mcp/errors";
import { agentTicketUrl } from "@/lib/mcp/read-dto";
import { safeHandler } from "@/lib/mcp/safe-handler";
import { resolveTicketRef } from "@/lib/mcp/ticket-ref";
import {
  appUrl,
  clientRequestIdSchema,
  mergedFromOutput,
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
import { getTicketTags, MAX_TAG_LENGTH, normalizeTagName } from "@/lib/tags";
import {
  addTagToTicket,
  removeTagFromTicket,
} from "@/lib/tickets/services/tags";

const MAX_TAGS_PER_CALL = 10;

const tagListSchema = (what: string) =>
  z
    .array(z.string().max(500))
    .max(MAX_TAGS_PER_CALL)
    .optional()
    .describe(
      `Tag names to ${what} (up to ${MAX_TAGS_PER_CALL}, each up to ${MAX_TAG_LENGTH} characters). Names are lower-cased and whitespace-collapsed.`
    );

export const updateTicketTagsInput = z.strictObject({
  ticket: ticketRefSchema,
  add: tagListSchema("add"),
  remove: tagListSchema("remove"),
  clientRequestId: clientRequestIdSchema,
});

const updateTicketTagsOutput = z.object({
  ticket: writtenTicketOutput,
  tags: z.array(z.string()),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  mergedFrom: mergedFromOutput,
  ...writeFlagsShape,
});
type UpdateTicketTagsResult = z.infer<typeof updateTicketTagsOutput>;

const TOOL = "update_ticket_tags";

type TagField = "add" | "remove";

/** Normalizes one list; any bad name is an invalid_input naming the list. */
function normalizeList(raw: string[] | undefined, field: TagField): string[] {
  const names: string[] = [];
  for (const value of raw ?? []) {
    const name = normalizeTagName(value);
    if (name.length === 0) {
      throw new McpToolError(
        "invalid_input",
        `A tag name in ${field} is empty.`,
        { field }
      );
    }
    if (name.length > MAX_TAG_LENGTH) {
      throw new McpToolError(
        "invalid_input",
        `A tag name in ${field} is longer than ${MAX_TAG_LENGTH} characters.`,
        { field }
      );
    }
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/** The normalized, de-duplicated, validated lists. */
export function parseTagChanges(input: { add?: string[]; remove?: string[] }): {
  add: string[];
  remove: string[];
} {
  if ((input.add?.length ?? 0) + (input.remove?.length ?? 0) === 0) {
    throw new McpToolError(
      "invalid_input",
      "Provide at least one tag in add or remove.",
      { field: "add" }
    );
  }
  const add = normalizeList(input.add, "add");
  const remove = normalizeList(input.remove, "remove");
  if (add.some((name) => remove.includes(name))) {
    throw new McpToolError(
      "invalid_input",
      "A tag name appears in both add and remove.",
      { field: "remove" }
    );
  }
  return { add, remove };
}

/** Tag names for ids, in the order given; ids that no longer exist are
 * skipped. */
async function namesForIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) {
    return [];
  }
  const rows = await db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(inArray(tags.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return ids.flatMap((id) => {
    const name = byId.get(id);
    return name === undefined ? [] : [name];
  });
}

const idList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

export function registerTagTools(
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
      title: "Update ticket tags",
      description: `Adds and/or removes tags on a ticket (at least one list, up to ${MAX_TAGS_PER_CALL} names each, names up to ${MAX_TAG_LENGTH} characters). Adding a tag that is already on the ticket, or removing one that is not, changes nothing, so repeating a call is safe. New tag names are created in the shared tag pool. Returns the ticket's tags after the change, plus which tags this call actually added and removed. A merged ticket forwards to the ticket it was merged into. clientRequestId is optional: reuse the same key when retrying.`,
      inputSchema: updateTicketTagsInput,
      outputSchema: updateTicketTagsOutput,
      annotations: writeAnnotations({ idempotent: true }),
    },
    (args) =>
      safeHandler<UpdateTicketTagsResult>(
        { tool: TOOL, principal, requestId, args },
        async (call) => {
          const ref = await resolveTicketRef(args.ticket);
          call.setTarget({ ticketId: ref.id });
          const changes = parseTagChanges(args);

          const { stored, flags } = await runWriteTool({
            tool: TOOL,
            principal,
            requestId,
            call,
            // The normalized request, so the same change spelled differently
            // is still the same call.
            args: {
              ticket: args.ticket,
              add: changes.add,
              remove: changes.remove,
              clientRequestId: args.clientRequestId,
            },
            clientRequestId: args.clientRequestId,
            targetTicketId: ref.id,
            execute: async () => {
              const actor = mcpServiceActor(principal);
              const activityMetadata = mcpActivityMetadata(principal);
              const addedIds: string[] = [];
              const removedIds: string[] = [];

              for (const name of changes.add) {
                const added = await addTagToTicket({
                  ticketId: ref.id,
                  actor,
                  name,
                  activityMetadata,
                });
                if (added.status === "not_found") {
                  throw notFound("ticket");
                }
                const linked = added.tags.find((t) => t.name === name);
                if (added.status === "added" && linked) {
                  addedIds.push(linked.id);
                }
              }

              for (const name of changes.remove) {
                const [tag] = await db
                  .select({ id: tags.id })
                  .from(tags)
                  .where(eq(tags.name, name))
                  .limit(1);
                if (!tag) {
                  continue;
                }
                const removed = await removeTagFromTicket({
                  ticketId: ref.id,
                  actor,
                  tagId: tag.id,
                  activityMetadata,
                });
                if (removed.status === "removed") {
                  removedIds.push(tag.id);
                }
              }

              if (addedIds.length > 0 || removedIds.length > 0) {
                await auditMcpWrite({
                  principal,
                  tool: TOOL,
                  ticketId: ref.id,
                  ticketNumber: ref.ticketNumber,
                  description: `Updated tags on ticket #${ref.ticketNumber} via MCP`,
                  metadata: {
                    addedTagIds: addedIds,
                    removedTagIds: removedIds,
                  },
                });
              }
              return {
                result: { addedTagIds: addedIds, removedTagIds: removedIds },
              };
            },
          });

          const [current, added, removed] = await Promise.all([
            getTicketTags(ref.id),
            namesForIds(idList(stored.addedTagIds)),
            namesForIds(idList(stored.removedTagIds)),
          ]);
          return {
            ticket: {
              number: ref.ticketNumber,
              agentUrl: agentTicketUrl(appUrl(), ref.ticketNumber),
            },
            tags: current.map((t) => t.name),
            added,
            removed,
            ...(ref.mergedFrom ? { mergedFrom: ref.mergedFrom } : {}),
            ...flags,
          };
        }
      )
  );
}
