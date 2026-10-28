import { createId } from "@paralleldrive/cuid2";
import { desc, eq } from "drizzle-orm";
import { webhookDeliveries, webhookEndpoints } from "@/db/schema";
import { encryptSecret, generateWebhookSecret } from "@/lib/crypto";
import { db } from "@/lib/db";
import { isValidWebhookEvent } from "@/lib/webhooks/events";
import { enqueueJob } from "@/lib/worker/enqueue";
import { JOB_NAMES } from "@/lib/worker/job-types";

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;

/** Never returned to the client — the encrypted secret is server-only. */
export type PublicWebhookEndpoint = Omit<WebhookEndpoint, "secretEncrypted">;

function toPublic(endpoint: WebhookEndpoint): PublicWebhookEndpoint {
  const { secretEncrypted: _secretEncrypted, ...rest } = endpoint;
  return rest;
}

function sanitizeEvents(events: unknown): string[] {
  if (!Array.isArray(events)) {
    return [];
  }
  return [
    ...new Set(
      events.filter(
        (e): e is string => typeof e === "string" && isValidWebhookEvent(e)
      )
    ),
  ];
}

export async function listWebhookEndpoints(): Promise<PublicWebhookEndpoint[]> {
  const rows = await db
    .select()
    .from(webhookEndpoints)
    .orderBy(desc(webhookEndpoints.createdAt));
  return rows.map(toPublic);
}

export async function createWebhookEndpoint(input: {
  name: string;
  url: string;
  events: unknown;
  createdById: string;
  createdByName: string;
}): Promise<{ endpoint: PublicWebhookEndpoint; rawSecret: string }> {
  const rawSecret = generateWebhookSecret();
  const [record] = await db
    .insert(webhookEndpoints)
    .values({
      name: input.name,
      url: input.url,
      secretEncrypted: encryptSecret(rawSecret),
      events: sanitizeEvents(input.events),
      createdById: input.createdById,
      createdByName: input.createdByName,
    })
    .returning();
  return { endpoint: toPublic(record), rawSecret };
}

/** Partial update — only fields present in `updates` are changed. Never touches the secret. */
export async function updateWebhookEndpoint(
  id: string,
  updates: { name?: string; url?: string; events?: unknown; isActive?: boolean }
): Promise<PublicWebhookEndpoint | undefined> {
  const values: Partial<typeof webhookEndpoints.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (updates.name !== undefined) {
    values.name = updates.name;
  }
  if (updates.url !== undefined) {
    values.url = updates.url;
  }
  if (updates.events !== undefined) {
    values.events = sanitizeEvents(updates.events);
  }
  if (updates.isActive !== undefined) {
    values.isActive = updates.isActive;
  }

  const [row] = await db
    .update(webhookEndpoints)
    .set(values)
    .where(eq(webhookEndpoints.id, id))
    .returning();
  return row ? toPublic(row) : undefined;
}

export async function rotateWebhookSecret(
  id: string
): Promise<{ endpoint: PublicWebhookEndpoint; rawSecret: string } | undefined> {
  const rawSecret = generateWebhookSecret();
  const [row] = await db
    .update(webhookEndpoints)
    .set({ secretEncrypted: encryptSecret(rawSecret), updatedAt: new Date() })
    .where(eq(webhookEndpoints.id, id))
    .returning();
  return row ? { endpoint: toPublic(row), rawSecret } : undefined;
}

/** Hard delete — cascades to that endpoint's delivery history. */
export async function deleteWebhookEndpoint(id: string): Promise<boolean> {
  const [row] = await db
    .delete(webhookEndpoints)
    .where(eq(webhookEndpoints.id, id))
    .returning({ id: webhookEndpoints.id });
  return Boolean(row);
}

const DELIVERY_HISTORY_LIMIT = 50;

export async function listWebhookDeliveries(
  webhookId: string
): Promise<WebhookDelivery[]> {
  return db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, webhookId))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(DELIVERY_HISTORY_LIMIT);
}

/** Re-enqueues a failed delivery from scratch (fresh attempt count). */
export async function redeliverWebhookDelivery(
  deliveryId: string
): Promise<boolean> {
  const [row] = await db
    .update(webhookDeliveries)
    .set({
      attemptCount: 0,
      claimedAt: null,
      lastError: null,
      status: "queued",
      updatedAt: new Date(),
    })
    .where(eq(webhookDeliveries.id, deliveryId))
    .returning({ id: webhookDeliveries.id });
  if (!row) {
    return false;
  }
  await enqueueJob(JOB_NAMES.WEBHOOK_SEND, { deliveryId });
  return true;
}

/** Dispatches a synthetic ticket.created-shaped payload to one endpoint so an
 * admin can verify their receiving server before relying on real traffic. */
export async function sendTestWebhookEvent(
  webhookId: string
): Promise<boolean> {
  const [endpoint] = await db
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.id, webhookId))
    .limit(1);
  if (!endpoint) {
    return false;
  }

  const payload = {
    id: `evt_${createId()}`,
    event: "ticket.created",
    createdAt: new Date().toISOString(),
    data: {
      ticket: {
        id: "test_ticket",
        ticketNumber: 0,
        subject: "Test webhook event",
        status: "open",
        priority: "normal",
        category: "general",
        customerName: "Test Customer",
        customerEmail: "test@example.com",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  };

  const [row] = await db
    .insert(webhookDeliveries)
    .values({
      webhookId,
      event: "ticket.created",
      entityType: "test",
      entityId: "test",
      payload,
      status: "queued",
    })
    .returning({ id: webhookDeliveries.id });

  await enqueueJob(JOB_NAMES.WEBHOOK_SEND, { deliveryId: row.id });
  return true;
}
