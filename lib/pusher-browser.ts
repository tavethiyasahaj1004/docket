"use client";

// Fetched from the server at runtime rather than read off
// `process.env.NEXT_PUBLIC_PUSHER_*`, which Next inlines at Docker *build* time
// — exactly the rebuild requirement this avoids. See /api/config/client.
let configPromise: Promise<{
  pusherKey: string | null;
  pusherCluster: string | null;
}> | null = null;

function getClientConfig() {
  configPromise ??= fetch("/api/config/client")
    .then((res) => res.json())
    .catch(() => ({ pusherKey: null, pusherCluster: null }));
  return configPromise;
}

let clientPromise: Promise<import("pusher-js").default | null> | null = null;

/** Lazily creates and reuses one Pusher Channels client per tab, dynamically
 * importing `pusher-js` so it stays out of the bundle for self-hosters who never
 * configure it. Null when Channels isn't configured. */
export function getPusherClient(): Promise<import("pusher-js").default | null> {
  clientPromise ??= (async () => {
    const { pusherKey, pusherCluster } = await getClientConfig();
    if (!(pusherKey && pusherCluster)) {
      return null;
    }
    const { default: Pusher } = await import("pusher-js");
    return new Pusher(pusherKey, {
      cluster: pusherCluster,
      channelAuthorization: {
        endpoint: "/api/pusher/auth",
        transport: "ajax",
      },
    });
  })();
  return clientPromise;
}

/** A fresh, never-shared Pusher client authorized as the customer of one ticket:
 * it sends `token` alongside the standard auth fields so the server can match it
 * to that ticket's customerToken. Uncached, because the portal lets a customer
 * move between sibling tickets, each with a different token. */
export async function getPusherClientForCustomer(
  token: string
): Promise<import("pusher-js").default | null> {
  const { pusherKey, pusherCluster } = await getClientConfig();
  if (!(pusherKey && pusherCluster)) {
    return null;
  }

  const { default: Pusher } = await import("pusher-js");
  return new Pusher(pusherKey, {
    cluster: pusherCluster,
    channelAuthorization: {
      endpoint: "/api/pusher/auth",
      transport: "ajax",
      params: { token },
    },
  });
}
