import { randomUUID } from "node:crypto";
import { emailOutbox } from "@/db/schema";
import { db } from "@/lib/db";
import { getPlatformSettings } from "@/lib/settings";
import { enqueueJob } from "@/lib/worker/enqueue";
import { JOB_NAMES } from "@/lib/worker/job-types";

export interface SendEmailOptions {
  /** "ticket" = a lifecycle notification mirroring an outbound webhook event, so
   * it's skipped when ticketEmailNotificationsEnabled is off. "account" (the
   * default) = an agent auth or invite email, always sent. */
  category?: "account" | "ticket";
  html: string;
  subject: string;
  text?: string;
  to: string;
}

export interface EnqueuedEmail {
  outboxId: string;
}

/** Queues an email. Resolves `{ outboxId }` once queued, or `null` when ticket
 * notifications are switched off (nothing was written). If the queue send
 * fails AFTER the outbox row exists, the same error is rethrown with the row's
 * id attached — read it back with `getQueuedOutboxId`. */
export async function enqueueEmail({
  category,
  ...payload
}: SendEmailOptions): Promise<EnqueuedEmail | null> {
  if (category === "ticket") {
    const settings = await getPlatformSettings();
    if (!settings.ticketEmailNotificationsEnabled) {
      return null;
    }
  }

  // Dev convenience: surface any links inside the email in the server console
  // so you can click them without opening your inbox. Never runs in production.
  if (process.env.NODE_ENV !== "production") {
    logEmailLinks(payload);
  }

  const [row] = await db
    .insert(emailOutbox)
    .values({
      idempotencyKey: randomUUID(),
      payload,
      status: "queued",
    })
    .returning({ id: emailOutbox.id });

  try {
    await enqueueJob(JOB_NAMES.EMAIL_SEND, { outboxId: row.id });
  } catch (err) {
    throw attachOutboxId(err, row.id);
  }
  return { outboxId: row.id };
}

function tagWithOutboxId<T extends object>(target: T, outboxId: string): T {
  // Non-enumerable, so logging the error looks exactly as it did before.
  Object.defineProperty(target, "outboxId", {
    configurable: true,
    enumerable: false,
    value: outboxId,
  });
  return target;
}

/** Tags a queue-send failure with the outbox row that was already written. The
 * original error object is rethrown (same identity) whenever it can carry the
 * property; a non-object throw is wrapped in an Error with `cause`. */
function attachOutboxId(err: unknown, outboxId: string): unknown {
  if (err !== null && typeof err === "object") {
    try {
      return tagWithOutboxId(err, outboxId);
    } catch {
      // Frozen/sealed object: wrap it so the id is not lost.
    }
  }
  return tagWithOutboxId(new Error(String(err), { cause: err }), outboxId);
}

/** The outbox row id attached to a failed `enqueueEmail`, or null when the
 * failure happened before any row was written. */
export function getQueuedOutboxId(err: unknown): string | null {
  if (err === null || typeof err !== "object") {
    return null;
  }
  const id = (err as { outboxId?: unknown }).outboxId;
  return typeof id === "string" ? id : null;
}

function logEmailLinks({ to, subject, html, text }: SendEmailOptions) {
  const links = new Set<string>();

  // Bare URLs in the plain-text part (templates put the actionable link here).
  for (const m of (text ?? "").matchAll(/https?:\/\/[^\s<>"')]+/g)) {
    links.add(m[0]);
  }
  // href="..." targets in the HTML part (fallback / extra coverage).
  for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
    links.add(m[1]);
  }

  if (links.size === 0) {
    return;
  }

  console.log(
    `\n📧 [email] "${subject}" → ${to}\n` +
      [...links].map((l) => `   🔗 ${l}`).join("\n") +
      "\n"
  );
}
