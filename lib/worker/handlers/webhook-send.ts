import { and, eq, sql } from "drizzle-orm";
import type { Job } from "pg-boss";
import { webhookDeliveries, webhookEndpoints } from "@/db/schema";
import { decryptSecret, signWebhookPayload } from "@/lib/crypto";
import { db } from "@/lib/db";
import { enqueueJob } from "@/lib/worker/enqueue";
import { JOB_NAMES, type WebhookSendPayload } from "@/lib/worker/job-types";

// Longer than email's [60, 300, 900] — a third-party server outage plausibly
// outlasts an SMTP hiccup. 1m / 5m / 30m / 2h.
const RETRY_BACKOFF_SECONDS = [60, 300, 1800, 7200];
const REQUEST_TIMEOUT_MS = 10_000;

export async function handleWebhookSend(jobs: Job<WebhookSendPayload>[]) {
  for (const job of jobs) {
    await processWebhookSendJob(job);
  }
}

async function processWebhookSendJob(job: Job<WebhookSendPayload>) {
  const { deliveryId } = job.data;

  const [claimed] = await db
    .update(webhookDeliveries)
    .set({
      attemptCount: sql`${webhookDeliveries.attemptCount} + 1`,
      claimedAt: new Date(),
      status: "sending",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(webhookDeliveries.id, deliveryId),
        eq(webhookDeliveries.status, "queued")
      )
    )
    .returning();

  if (!claimed) {
    return;
  }

  const [endpoint] = await db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.id, claimed.webhookId))
    .limit(1);

  if (!endpoint) {
    // The endpoint was deleted between enqueue and delivery — nothing to send to.
    await db
      .update(webhookDeliveries)
      .set({
        lastError: "Webhook endpoint no longer exists.",
        status: "failed",
        updatedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, deliveryId));
    return;
  }

  const attempt = claimed.attemptCount;
  const remainingAttempts = claimed.maxAttempts - attempt;

  try {
    const responseStatus = await sendSignedWebhook(
      endpoint.url,
      decryptSecret(endpoint.secretEncrypted),
      claimed
    );

    await db
      .update(webhookDeliveries)
      .set({
        deliveredAt: new Date(),
        responseStatus,
        status: "sent",
        updatedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, deliveryId));

    await db
      .update(webhookEndpoints)
      .set({ lastDeliveryAt: new Date(), lastDeliveryStatus: "sent" })
      .where(eq(webhookEndpoints.id, endpoint.id));
  } catch (error) {
    const reason = describeWebhookError(error);

    await db
      .update(webhookEndpoints)
      .set({ lastDeliveryAt: new Date(), lastDeliveryStatus: "failed" })
      .where(eq(webhookEndpoints.id, endpoint.id));

    if (remainingAttempts > 0) {
      await db
        .update(webhookDeliveries)
        .set({
          claimedAt: null,
          lastError: reason,
          status: "queued",
          updatedAt: new Date(),
        })
        .where(eq(webhookDeliveries.id, deliveryId));

      await enqueueJob(
        JOB_NAMES.WEBHOOK_SEND,
        { deliveryId },
        {
          startAfter:
            RETRY_BACKOFF_SECONDS[
              Math.min(attempt - 1, RETRY_BACKOFF_SECONDS.length - 1)
            ],
        }
      );
      return;
    }

    await db
      .update(webhookDeliveries)
      .set({
        lastError: reason,
        status: "failed",
        updatedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, deliveryId));
  }
}

/** POSTs the frozen payload, signed the way docs/webhooks.md documents. Returns
 * the HTTP status on a 2xx response; throws on any non-2xx, timeout, or network error. */
async function sendSignedWebhook(
  url: string,
  secret: string,
  delivery: { id: string; event: string; payload: unknown }
): Promise<number> {
  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhookPayload(secret, timestamp, body);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Docket-Event": delivery.event,
        "X-Docket-Delivery": delivery.id,
        "X-Docket-Timestamp": String(timestamp),
        "X-Docket-Signature": `sha256=${signature}`,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Endpoint responded with HTTP ${response.status} ${response.statusText}`
      );
    }
    return response.status;
  } finally {
    clearTimeout(timeout);
  }
}

function describeWebhookError(error: unknown) {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`;
    }
    return error.message.slice(0, 500);
  }
  return String(error).slice(0, 500);
}
