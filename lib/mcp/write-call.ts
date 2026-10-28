// Shared plumbing of the write tools (MCP_TOOLS_SPEC.md 0.9, MCP_SECURITY.md
// 7 and 9): the idempotent claim/execute/finalize run, attribution to the token
// owner, and the audit row. A tool validates its input and resolves its ticket
// first (those failures keep the safe handler's trace row), then hands the
// state-dependent work to {@link runWriteTool}.
import { audit } from "@/lib/audit";
import type { McpPrincipal } from "@/lib/mcp/auth";
import {
  type ExecuteResult,
  runIdempotentWrite,
  toToolError,
  type WriteHooks,
} from "@/lib/mcp/idempotency";
import type { ToolCallInfo } from "@/lib/mcp/safe-handler";
import type {
  ActivityMetadataExtra,
  ServiceActor,
} from "@/lib/tickets/services/types";

export type { ExecuteResult };

/** The token owner acts, exactly as the same person in the UI would. */
export function mcpServiceActor(principal: McpPrincipal): ServiceActor {
  return {
    id: principal.userId,
    name: principal.name || principal.email,
    // canUseTool has already limited principals to these two roles.
    role: principal.role as ServiceActor["role"],
  };
}

/** Added to the metadata of every activity row an MCP write produces. The
 * action names and the rest of the row stay as the UI writes them. */
export function mcpActivityMetadata(
  principal: McpPrincipal
): ActivityMetadataExtra {
  return { via: "mcp", credentialId: principal.credentialId };
}

/** One audit row per write that changed something (fail-open, like every other
 * audit call). Call it inside `execute`, after the service succeeded, so a
 * replay never audits twice. */
export async function auditMcpWrite(input: {
  principal: McpPrincipal;
  tool: string;
  ticketId: string;
  ticketNumber: number;
  description: string;
  /** Ids only (comment id, tag ids, field names). */
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { principal } = input;
  await audit({
    action: `mcp.${input.tool}`,
    entityType: "ticket",
    entityId: input.ticketId,
    actorId: principal.userId,
    actorEmail: principal.email,
    description: input.description,
    metadata: {
      via: "mcp",
      credentialId: principal.credentialId,
      // A personal access token is its own client; no other client id exists.
      clientId: null,
      ticketNumber: input.ticketNumber,
      ...input.metadata,
    },
  });
}

/** What a result says about how it came to be. Absent when not applicable. */
export type WriteFlags = {
  replayed?: true;
  sideEffectsUncertain?: true;
  notificationErrors?: string[];
};

export type RunWriteToolInput = {
  tool: string;
  principal: McpPrincipal;
  requestId: string;
  call: ToolCallInfo;
  /** The validated input; only a keyed hash of it is stored. */
  args: unknown;
  clientRequestId?: string;
  targetTicketId: string;
  execute: WriteHooks["execute"];
  reconcile?: WriteHooks["reconcile"];
};

/** claim -> execute -> finalize for one write call. Returns the stored-safe
 * result (ids, slugs, numbers, booleans, ISO timestamps: the tool renders its
 * output from it, identically for a fresh call and a replay) with the flags to
 * attach. A failed outcome throws the matching tool error.
 *
 * The call leaves exactly one `mcp_tool_calls` row: when this call owned the
 * ledger row, the row is the record and the handler adds none; a replay, a
 * key mismatch or an in-progress answer keeps the handler's trace row. */
export async function runWriteTool(
  input: RunWriteToolInput
): Promise<{ stored: Record<string, unknown>; flags: WriteFlags }> {
  const outcome = await runIdempotentWrite(
    {
      principal: input.principal,
      requestId: input.requestId,
      tool: input.tool,
      args: input.args,
      clientRequestId: input.clientRequestId,
      targetTicketId: input.targetTicketId,
    },
    { execute: input.execute, reconcile: input.reconcile }
  );

  const ownedLedgerRow =
    !outcome.replayed &&
    !(outcome.kind === "failed" && outcome.error.code === "in_progress");
  if (ownedLedgerRow) {
    input.call.markLedgered();
  }
  if (outcome.kind === "failed") {
    throw toToolError(outcome.error);
  }

  const { replayed: _replayed, ...stored } = outcome.result;
  const flags: WriteFlags = {};
  if (outcome.replayed) {
    flags.replayed = true;
  }
  if (outcome.sideEffectsUncertain) {
    flags.sideEffectsUncertain = true;
  }
  if (outcome.notificationErrors.length > 0) {
    flags.notificationErrors = outcome.notificationErrors;
  }
  return { stored, flags };
}
