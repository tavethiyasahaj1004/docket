import type { McpServer } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { tickets } from "@/db/schema/tickets";
import { db } from "@/lib/db";
import type { McpPrincipal } from "@/lib/mcp/auth";
import {
  compareThreadPosition,
  decodeThreadCursor,
  encodeThreadCursor,
} from "@/lib/mcp/cursor";
import { invalidInput, notFound } from "@/lib/mcp/errors";
import { MCP_RESULT_TARGET_CHARS } from "@/lib/mcp/limits";
import {
  type ActivityItemDto,
  type AttachmentSource,
  type MessageItemDto,
  shrinkAttachments,
  toActivityItemDto,
  toMessageItemDto,
  toStatusDto,
} from "@/lib/mcp/read-dto";
import { safeHandler } from "@/lib/mcp/safe-handler";
import { jsonLength, largestFittingCount } from "@/lib/mcp/size";
import { resolveTicketRef } from "@/lib/mcp/ticket-ref";
import {
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
import { getTicketThread } from "@/lib/tickets/queries";

export const getThreadInput = z.strictObject({
  ticket: ticketRefSchema,
  includeInternal: z
    .boolean()
    .default(false)
    .describe(
      "Include internal notes (labelled visibility internal). Needs the tickets:read_internal scope on the token; without it, true is an error."
    ),
  includeActivity: z
    .boolean()
    .default(false)
    .describe(
      "Also include activity entries (status changes, assignments, tags)."
    ),
  order: z
    .enum(["oldest_first", "newest_first"])
    .default("oldest_first")
    .describe('Sort order. Defaults to "oldest_first".'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(30)
    .describe("Items per page, 1-100. Defaults to 30."),
  cursor: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("The nextCursor from the previous page."),
  maxBodyChars: maxBodyCharsSchema,
});

const messageItem = z.object({
  kind: z.literal("message"),
  id: z.string(),
  visibility: z.enum(["public", "internal"]),
  authorRole: z.string(),
  authorName: z.string(),
  ...bodyOutputShape,
  createdAt: z.string(),
  attachments: z.array(attachmentOutput),
});

const activityItem = z.object({
  kind: z.literal("activity"),
  id: z.string(),
  action: z.string(),
  actorName: z.string(),
  metadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .nullable(),
  createdAt: z.string(),
});

const getThreadOutput = z.object({
  ticket: z.object({
    id: z.string(),
    number: z.number(),
    subject: z.string(),
    status: statusOutput,
  }),
  items: z.array(z.discriminatedUnion("kind", [messageItem, activityItem])),
  nextCursor: z.string().nullable(),
  truncatedForSize: z.boolean().optional(),
  mergedFrom: mergedFromOutput,
});
type GetThreadResult = z.infer<typeof getThreadOutput>;

const SHRUNK_BODY_CHARS = 500;

/** Over the size cap: keep the longest prefix of items that fits the target and
 * point `nextCursor` at the last one kept, so the rest can still be fetched. */
export function shrinkThread(result: GetThreadResult): GetThreadResult {
  const withItems = (n: number): GetThreadResult => {
    const items = result.items.slice(0, n);
    const last = items.at(-1);
    return {
      ...result,
      items,
      nextCursor:
        n < result.items.length && last
          ? encodeThreadCursor(last.createdAt, last.id)
          : result.nextCursor,
      truncatedForSize: true,
    };
  };
  const keep = largestFittingCount(
    result.items.length,
    (n) => jsonLength(withItems(n)) <= MCP_RESULT_TARGET_CHARS
  );
  const shrunk = withItems(
    keep === 0 ? Math.min(1, result.items.length) : keep
  );
  if (keep > 0 || jsonLength(shrunk) <= MCP_RESULT_TARGET_CHARS) {
    return shrunk;
  }
  // A single item is still too big: shorten its body and attachment list.
  return {
    ...shrunk,
    items: shrunk.items.map((item) =>
      item.kind === "message"
        ? {
            ...item,
            body: item.body.slice(0, SHRUNK_BODY_CHARS),
            truncated: true,
            attachments: shrinkAttachments(item.attachments),
          }
        : item
    ),
  };
}

type Entry = {
  createdAt: Date;
  id: string;
  build: () => MessageItemDto | ActivityItemDto;
};

export function registerThreadTools(
  server: McpServer,
  principal: McpPrincipal,
  requestId: string,
  permitted: ReadonlySet<string>
) {
  if (!permitted.has("get_ticket_thread")) {
    return;
  }
  server.registerTool(
    "get_ticket_thread",
    {
      title: "Get a ticket thread",
      description: `Returns a ticket's messages in pages of up to 100 (default 30), oldest first by default; follow nextCursor until it is null. Internal notes are never included unless the token has the tickets:read_internal scope and includeInternal is true. Activity entries appear only with includeActivity. Message bodies are plain text cut to maxBodyChars; attachments are metadata only. A merged ticket resolves to its target (mergedFrom). ${UNTRUSTED_TEXT_NOTE} Messages with authorRole customer are written by outsiders.`,
      inputSchema: getThreadInput,
      outputSchema: getThreadOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) =>
      safeHandler<GetThreadResult>(
        {
          tool: "get_ticket_thread",
          principal,
          requestId,
          args,
          shrink: shrinkThread,
        },
        async (call) => {
          const includeInternal = resolveInternalAccess(
            principal,
            args.includeInternal
          );
          const cursor =
            args.cursor === undefined ? null : decodeThreadCursor(args.cursor);
          if (args.cursor !== undefined && cursor === null) {
            throw invalidInput("Invalid cursor.");
          }

          const resolved = await resolveTicketRef(args.ticket);
          call.setTarget({ ticketId: resolved.id });

          const [header, thread, config] = await Promise.all([
            db
              .select({
                subject: tickets.subject,
                status: tickets.status,
              })
              .from(tickets)
              .where(eq(tickets.id, resolved.id))
              .limit(1),
            getTicketThread(resolved.id),
            loadTicketConfig(),
          ]);
          const ticket = header[0];
          if (!ticket) {
            throw notFound("ticket");
          }

          const attachmentsByComment = new Map<string, AttachmentSource[]>();
          for (const a of thread.attachments) {
            if (a.commentId === null) {
              continue;
            }
            const list = attachmentsByComment.get(a.commentId) ?? [];
            list.push(a);
            attachmentsByComment.set(a.commentId, list);
          }
          for (const list of attachmentsByComment.values()) {
            list.sort((x, y) => compareThreadPosition(x, y));
          }

          // Internal items are filtered out BEFORE paging, so a page never
          // shrinks (or reveals the existence of hidden items) after the fact.
          const entries: Entry[] = [];
          for (const c of thread.comments) {
            if (c.isInternal && !includeInternal) {
              continue;
            }
            entries.push({
              createdAt: c.createdAt,
              id: c.id,
              build: () =>
                toMessageItemDto(
                  c,
                  attachmentsByComment.get(c.id) ?? [],
                  args.maxBodyChars
                ),
            });
          }
          if (args.includeActivity) {
            for (const a of thread.activity) {
              if (a.action === "internal_note_added" && !includeInternal) {
                continue;
              }
              // The row does not say whether the deleted file was on an
              // internal note, so its name needs the internal opt-in too.
              const hideMetadata =
                a.action === "attachment_deleted" && !includeInternal;
              entries.push({
                createdAt: a.createdAt,
                id: a.id,
                build: () =>
                  hideMetadata
                    ? { ...toActivityItemDto(a), metadata: null }
                    : toActivityItemDto(a),
              });
            }
          }

          const newestFirst = args.order === "newest_first";
          entries.sort((x, y) =>
            newestFirst
              ? compareThreadPosition(y, x)
              : compareThreadPosition(x, y)
          );
          const remaining = cursor
            ? entries.filter((e) => {
                const cmp = compareThreadPosition(e, cursor);
                return newestFirst ? cmp < 0 : cmp > 0;
              })
            : entries;
          const page = remaining.slice(0, args.limit);
          const last = page.at(-1);

          return {
            ticket: {
              id: resolved.id,
              number: resolved.ticketNumber,
              subject: ticket.subject,
              status: toStatusDto(config.labels, ticket.status),
            },
            items: page.map((e) => e.build()),
            nextCursor:
              remaining.length > page.length && last
                ? encodeThreadCursor(last.createdAt.toISOString(), last.id)
                : null,
            ...(resolved.mergedFrom ? { mergedFrom: resolved.mergedFrom } : {}),
          };
        }
      )
  );
}
