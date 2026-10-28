import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { McpToolError, notFound } from "@/lib/mcp/errors";
import { agentTicketUrl } from "@/lib/mcp/read-dto";
import { safeHandler } from "@/lib/mcp/safe-handler";
import { resolveTicketRefForChange } from "@/lib/mcp/ticket-ref";
import {
  appUrl,
  clientRequestIdSchema,
  ticketRefSchema,
  writeAnnotations,
  writeFlagsShape,
  writtenTicketOutput,
} from "@/lib/mcp/tools/common";
import { auditMcpWrite, runWriteTool } from "@/lib/mcp/write-call";
import {
  htmlToRichTextJson,
  isRichTextEmpty,
  textToRichTextJson,
} from "@/lib/rich-text";
import { MAX_DRAFT_LENGTH, saveReplyDraft } from "@/lib/tickets/reply-drafts";

export const saveReplyDraftInput = z.strictObject({
  ticket: ticketRefSchema,
  body: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      "The proposed reply, 1-20000 characters. Plain text by default; set format to html for HTML."
    ),
  format: z
    .enum(["text", "html"])
    .default("text")
    .describe(
      '"text" (default) or "html". HTML is reduced to supported formatting.'
    ),
  visibility: z
    .enum(["public", "internal"])
    .default("public")
    .describe(
      '"public" (default) drafts a reply to the customer; "internal" drafts an internal note. Either way nothing is sent.'
    ),
  clientRequestId: clientRequestIdSchema,
});

const saveReplyDraftOutput = z.object({
  ticket: writtenTicketOutput,
  draft: z.object({
    visibility: z.enum(["public", "internal"]),
    updatedAt: z.string(),
  }),
  unchanged: z.boolean(),
  ...writeFlagsShape,
});
type SaveReplyDraftResult = z.infer<typeof saveReplyDraftOutput>;

const TOOL = "save_reply_draft";

export function registerDraftTools(
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
      title: "Save a reply draft",
      description:
        "Puts a proposed reply into the token owner's own reply composer on a ticket, for a human to review and send from the Docket UI. Nothing is sent to the customer. If the owner already has an identical draft the call succeeds with unchanged true; if they have a different draft it is NOT overwritten and the call returns draft_exists. Rejects merged tickets (use the ticket named in the error). Drafts on closed tickets are allowed. Safe to repeat; reuse the same clientRequestId when retrying.",
      inputSchema: saveReplyDraftInput,
      outputSchema: saveReplyDraftOutput,
      annotations: writeAnnotations({ idempotent: true }),
    },
    (args) =>
      safeHandler<SaveReplyDraftResult>(
        { tool: TOOL, principal, requestId, args },
        async (call) => {
          const ref = await resolveTicketRefForChange(args.ticket);
          call.setTarget({ ticketId: ref.id });

          const content =
            args.format === "html"
              ? htmlToRichTextJson(args.body)
              : textToRichTextJson(args.body);
          if (isRichTextEmpty(content)) {
            throw new McpToolError(
              "invalid_input",
              "The body has no visible text, so nothing was saved. Your existing draft was not changed.",
              { field: "body" }
            );
          }
          if (content.length > MAX_DRAFT_LENGTH) {
            throw new McpToolError(
              "invalid_input",
              "The body is too long to store as a draft, so nothing was saved. Shorten it.",
              { field: "body" }
            );
          }
          const isInternal = args.visibility === "internal";

          const { stored, flags } = await runWriteTool({
            tool: TOOL,
            principal,
            requestId,
            call,
            args,
            clientRequestId: args.clientRequestId,
            targetTicketId: ref.id,
            execute: async () => {
              const saved = await saveReplyDraft({
                ticketId: ref.id,
                userId: principal.userId,
                content,
                isInternal,
                ifNoDifferentDraft: true,
              });
              switch (saved.status) {
                case "not_found":
                  throw notFound("ticket");
                case "rejected_empty":
                  // Checked above; kept as a guard so a draft is never cleared.
                  throw new McpToolError(
                    "invalid_input",
                    "The body has no visible text, so nothing was saved.",
                    { field: "body" }
                  );
                case "conflict":
                  throw new McpToolError(
                    "draft_exists",
                    `You already have a different reply draft on ticket #${ref.ticketNumber}. It was not changed and nothing was saved.`,
                    {
                      currentUpdatedAt: saved.updatedAt.toISOString(),
                      ticketNumber: ref.ticketNumber,
                    }
                  );
                default:
                  break;
              }
              if (saved.status === "saved") {
                await auditMcpWrite({
                  principal,
                  tool: TOOL,
                  ticketId: ref.id,
                  ticketNumber: ref.ticketNumber,
                  description: `Saved a reply draft on ticket #${ref.ticketNumber} via MCP`,
                  metadata: { visibility: args.visibility },
                });
              }
              return {
                result: {
                  ticketId: ref.id,
                  visibility: args.visibility,
                  updatedAt: saved.updatedAt.toISOString(),
                  unchanged: saved.status === "unchanged",
                },
              };
            },
          });

          return {
            ticket: {
              number: ref.ticketNumber,
              agentUrl: agentTicketUrl(appUrl(), ref.ticketNumber),
            },
            draft: {
              visibility:
                stored.visibility === "internal" ? "internal" : "public",
              updatedAt: String(stored.updatedAt),
            },
            unchanged: stored.unchanged === true,
            ...flags,
          };
        }
      )
  );
}
