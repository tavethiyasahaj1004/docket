import type { McpServer } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ticketComments, tickets } from "@/db/schema";
import { db } from "@/lib/db";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { McpToolError, notFound } from "@/lib/mcp/errors";
import { PlannedEntityExistsError } from "@/lib/mcp/idempotency";
import { agentTicketUrl } from "@/lib/mcp/read-dto";
import { reconcileCommentCall } from "@/lib/mcp/reconcile";
import { safeHandler } from "@/lib/mcp/safe-handler";
import {
  mergedDuringChangeError,
  resolveTicketRef,
} from "@/lib/mcp/ticket-ref";
import {
  appUrl,
  mergedFromOutput,
  requiredClientRequestIdSchema,
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
import {
  htmlToRichTextJson,
  isRichTextEmpty,
  richTextToPlainText,
  textToRichTextJson,
} from "@/lib/rich-text";
import { getAttachmentLimits } from "@/lib/settings";
import { isClosedStatusSlug } from "@/lib/ticket-config";
import {
  addTicketComment,
  loadCommentTarget,
} from "@/lib/tickets/services/comments";

export const addInternalNoteInput = z.strictObject({
  ticket: ticketRefSchema,
  body: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      "The note, 1-20000 characters. Plain text by default; set format to html for HTML."
    ),
  format: z
    .enum(["text", "html"])
    .default("text")
    .describe(
      '"text" (default) or "html". HTML is reduced to supported formatting.'
    ),
  clientRequestId: requiredClientRequestIdSchema,
});

const addInternalNoteOutput = z.object({
  commentId: z.string(),
  ticket: writtenTicketOutput,
  visibility: z.literal("internal"),
  createdAt: z.string(),
  mergedFrom: mergedFromOutput,
  ...writeFlagsShape,
});
type AddInternalNoteResult = z.infer<typeof addInternalNoteOutput>;

const TOOL = "add_internal_note";

/** The note as it is stored, for the output of a fresh call and a replay alike. */
async function loadNote(commentId: string) {
  const [row] = await db
    .select({
      id: ticketComments.id,
      createdAt: ticketComments.createdAt,
      ticketNumber: tickets.ticketNumber,
    })
    .from(ticketComments)
    .innerJoin(tickets, eq(ticketComments.ticketId, tickets.id))
    .where(eq(ticketComments.id, commentId))
    .limit(1);
  return row ?? null;
}

export function registerNoteTools(
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
      title: "Add an internal note",
      description:
        "Adds an internal note (visible to agents only, never to the customer) to a ticket, as the token owner. clientRequestId is required: reuse the SAME key when retrying the same note (a repeat returns the stored result and adds nothing), use a NEW key for a new note. Sends no email or webhook and does not delete the owner's reply draft. A merged ticket forwards to the ticket it was merged into. A closed ticket returns ticket_closed.",
      inputSchema: addInternalNoteInput,
      outputSchema: addInternalNoteOutput,
      // Two calls with different keys add two notes, so repeating is not free.
      annotations: writeAnnotations({ idempotent: false }),
    },
    (args) =>
      safeHandler<AddInternalNoteResult>(
        { tool: TOOL, principal, requestId, args },
        async (call) => {
          const ref = await resolveTicketRef(args.ticket);
          call.setTarget({ ticketId: ref.id });

          const content =
            args.format === "html"
              ? htmlToRichTextJson(args.body)
              : textToRichTextJson(args.body);
          if (isRichTextEmpty(content)) {
            throw new McpToolError(
              "invalid_input",
              "The body has no visible text, so no note was added.",
              { field: "body" }
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
            reconcile: reconcileCommentCall,
            execute: async (plannedEntityId) => {
              const target = await loadCommentTarget(ref.id);
              if (!target) {
                throw notFound("ticket");
              }
              if (await isClosedStatusSlug(target.status)) {
                throw new McpToolError(
                  "ticket_closed",
                  `Ticket #${ref.ticketNumber} is closed. Notes can't be added to a closed ticket.`,
                  {
                    ticketNumber: ref.ticketNumber,
                    currentStatus: target.status,
                  }
                );
              }
              const limits = await getAttachmentLimits();
              const added = await addTicketComment({
                ticketId: ref.id,
                target,
                actor: mcpServiceActor(principal),
                content,
                contentText: richTextToPlainText(content),
                isInternal: true,
                attachments: [],
                commentId: plannedEntityId,
                // An assistant's note is not the reply the agent is drafting.
                keepReplyDraft: true,
                maxPerTicketSizeBytes: limits.maxPerTicketSizeBytes,
                activityMetadata: mcpActivityMetadata(principal),
              });
              if (added.status === "exists") {
                throw new PlannedEntityExistsError();
              }
              if (added.status === "merged") {
                throw await mergedDuringChangeError(ref.id);
              }
              if (added.status !== "ok") {
                // No attachments are sent, so a storage check cannot fail.
                throw new Error("Unexpected internal note result.");
              }
              await auditMcpWrite({
                principal,
                tool: TOOL,
                ticketId: ref.id,
                ticketNumber: ref.ticketNumber,
                description: `Added an internal note to ticket #${ref.ticketNumber} via MCP`,
                metadata: { commentId: added.commentId },
              });
              return { result: { commentId: added.commentId } };
            },
          });

          const note = await loadNote(String(stored.commentId));
          if (!note) {
            throw notFound("ticket");
          }
          return {
            commentId: note.id,
            ticket: {
              number: note.ticketNumber,
              agentUrl: agentTicketUrl(appUrl(), note.ticketNumber),
            },
            visibility: "internal" as const,
            createdAt: note.createdAt.toISOString(),
            ...(ref.mergedFrom ? { mergedFrom: ref.mergedFrom } : {}),
            ...flags,
          };
        }
      )
  );
}
