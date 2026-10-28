"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { getPusherClient } from "@/lib/pusher-browser";

/** Subscribes to `private-tickets` while mounted and soft-refreshes the route on
 * `ticket.created`. Renders nothing; subscribes to nothing when unconfigured. */
export function TicketsListRealtime() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    (async () => {
      const pusher = await getPusherClient();
      if (!pusher || cancelled) {
        return;
      }
      const channel = pusher.subscribe("private-tickets");
      channel.bind("ticket.created", () => router.refresh());
      unsubscribe = () => {
        channel.unbind_all();
        pusher.unsubscribe("private-tickets");
      };
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [router]);

  return null;
}
