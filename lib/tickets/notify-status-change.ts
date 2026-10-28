import {
  dispatchWebhookEvent,
  type TicketEventTicket,
  ticketPayloadData,
} from "@/lib/webhooks/dispatch";

/** Dispatches the right webhook event for a status transition. Used by the
 * dedicated /close and /reopen routes *and* the generic PATCH, so either path
 * emits the same `ticket.closed` — they already diverge on email and SLA side
 * effects, and webhooks shouldn't add a third inconsistency. */
export async function notifyTicketStatusChange(
  ticket: TicketEventTicket,
  wasClosedState: boolean,
  isClosedState: boolean
): Promise<void> {
  const event =
    !wasClosedState && isClosedState
      ? "ticket.closed"
      : wasClosedState && !isClosedState
        ? "ticket.reopened"
        : "ticket.status_changed";

  await dispatchWebhookEvent(event, "ticket", ticket.id, {
    ticket: ticketPayloadData(ticket),
  });
}
