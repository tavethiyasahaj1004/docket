import { auditLogs } from "@/db/schema";
import { db } from "@/lib/db";
import type { DbOrTx } from "@/lib/user-deletion";

export interface AuditInput {
  action: string;
  actorEmail?: string | null;
  actorId?: string | null;
  description: string;
  entityId?: string | null;
  entityType: string;
  metadata?: Record<string, unknown>;
}

export async function audit(input: AuditInput) {
  try {
    await db.insert(auditLogs).values({
      action: input.action,
      actorEmail: input.actorEmail ?? null,
      actorId: input.actorId ?? null,
      description: input.description,
      entityId: input.entityId ?? null,
      entityType: input.entityType,
      metadata: input.metadata,
    });
  } catch (error) {
    console.error("[audit] failed to write audit log", error);
  }
}

/** Like audit(), but on the caller's db/transaction handle and NOT fail-open:
 * it throws, so the surrounding transaction rolls back with it. Used only where
 * an action must never commit without its audit row (MCP token revocation on ban). */
export async function auditOrThrow(
  tx: DbOrTx,
  input: AuditInput
): Promise<void> {
  await tx.insert(auditLogs).values({
    action: input.action,
    actorEmail: input.actorEmail ?? null,
    actorId: input.actorId ?? null,
    description: input.description,
    entityId: input.entityId ?? null,
    entityType: input.entityType,
    metadata: input.metadata,
  });
}
