"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { getPusherClientForCustomer } from "@/lib/pusher-browser";

/** Subscribes to `private-ticket-{ticketId}`, authorized by the customer's own
 * ticket token rather than a session, and soft-refreshes on `comment.created` so
 * agent replies appear live. Renders nothing; no-op when Channels is unset. */
export function TicketRealtime({
  ticketId,
  token,
}: {
  ticketId: string;
  token: string;
}) {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const channelName = `private-ticket-${ticketId}`;

    (async () => {
      const pusher = await getPusherClientForCustomer(token);
      if (!pusher || cancelled) {
        return;
      }
      const channel = pusher.subscribe(channelName);
      channel.bind("comment.created", () => router.refresh());
      unsubscribe = () => {
        channel.unbind_all();
        pusher.unsubscribe(channelName);
        pusher.disconnect();
      };
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [router, ticketId, token]);

  return null;
}
