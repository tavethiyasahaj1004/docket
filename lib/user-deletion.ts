import { eq } from "drizzle-orm";
import { apiKeys } from "@/db/schema/api-keys";
import { cannedResponses } from "@/db/schema/canned-responses";
import {
  ticketActivity,
  ticketAttachments,
  ticketComments,
} from "@/db/schema/tickets";
import { webhookEndpoints } from "@/db/schema/webhooks";
import type { db } from "@/lib/db";

/** `db` or a transaction handle from `db.transaction()`. */
export type DbOrTx =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Replaces a deleted user's name wherever it was snapshotted. */
export const DELETED_USER_LABEL = "Deleted user";

/** Scrubs a user's name from every denormalized snapshot — deactivating keeps it
 * for rendering, hard delete is erasure. MUST run inside the delete's transaction
 * and before it, since every statement keys on an `ON DELETE SET NULL` FK. */
export async function anonymizeUserContent(tx: DbOrTx, userId: string) {
  await tx
    .update(ticketComments)
    .set({ authorName: DELETED_USER_LABEL })
    .where(eq(ticketComments.authorId, userId));

  await tx
    .update(ticketActivity)
    .set({ actorName: DELETED_USER_LABEL })
    .where(eq(ticketActivity.actorId, userId));

  await tx
    .update(ticketAttachments)
    .set({ uploadedByName: DELETED_USER_LABEL })
    .where(eq(ticketAttachments.uploadedById, userId));

  await tx
    .update(cannedResponses)
    .set({ createdByName: DELETED_USER_LABEL })
    .where(eq(cannedResponses.createdById, userId));

  await tx
    .update(apiKeys)
    .set({ createdByName: DELETED_USER_LABEL })
    .where(eq(apiKeys.createdById, userId));

  await tx
    .update(webhookEndpoints)
    .set({ createdByName: DELETED_USER_LABEL })
    .where(eq(webhookEndpoints.createdById, userId));
}
