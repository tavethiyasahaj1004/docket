import { enqueueEmail, getQueuedOutboxId } from "@/lib/email";
import type { EmailOutcome, WebhookOutcome } from "./types";

/** Awaits a webhook dispatch exactly like the routes always did: a rejection is
 * logged under `label` and never fails the operation. */
export async function awaitWebhook(
  label: string,
  dispatch: Promise<unknown>
): Promise<WebhookOutcome> {
  try {
    await dispatch;
    return "dispatched";
  } catch (err) {
    console.error(label, err);
    return "failed";
  }
}

/** Renders and queues a ticket notification email without being awaited by the
 * caller. The returned promise NEVER rejects: failures are logged under `label`
 * (as the routes always did) and classified into an {@link EmailOutcome}. */
export function queueTicketEmail({
  label,
  render,
  to,
}: {
  label: string;
  render: () => Promise<{ subject: string; html: string; text?: string }>;
  to: string;
}): Promise<EmailOutcome> {
  // The executor runs `render` synchronously, like the old direct call, while
  // still turning a synchronous throw into a rejection.
  return new Promise<{ subject: string; html: string; text?: string }>(
    (resolve) => resolve(render())
  )
    .then(({ subject, html, text }) =>
      enqueueEmail({ to, subject, html, text, category: "ticket" })
    )
    .then(
      (queued): EmailOutcome =>
        queued
          ? { requested: true, outboxId: queued.outboxId }
          : { requested: false }
    )
    .catch((err): EmailOutcome => {
      console.error(label, err);
      const outboxId = getQueuedOutboxId(err);
      return outboxId
        ? { requested: true, error: "email_queued_without_job", outboxId }
        : { requested: false, error: "email_not_queued" };
    });
}
