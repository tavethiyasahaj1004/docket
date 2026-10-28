# Real-Time Ticket Updates

The agent ticket list, an open agent ticket detail page, **and** an open
customer ticket page can all update **live** — no manual refresh — when
configured. This is powered by **Pusher Channels**, a different Pusher
product from the one used for OS push notifications (Pusher Beams — see
[docs/in-app-notifications.md](./in-app-notifications.md)).

**Optional, like every other Pusher integration in this app.** Without it
configured, all three pages behave exactly as they always have — refresh
the page to see new data.

## What updates live

| Page | Event | Trigger |
|------|-------|---------|
| `/tickets` (agent list) | `ticket.created` | A customer submits a new ticket |
| `/tickets/{ticketNumber}` (agent detail) | `comment.created` | Anyone posts a new comment on that ticket — customer reply, agent reply, or internal note |
| `/ticket/{id}` (customer detail) | `comment.created` | Anyone posts a new **public** comment on that ticket (internal notes are still delivered — see Security below — but the page only re-fetches comments the customer API already excludes internal notes from) |

All are soft `router.refresh()` calls (a Next.js RSC refetch, not a hard
page reload) — the relevant server components re-run and the page updates
in place. This means an agent and a customer replying back and forth on the
same ticket see each other's messages appear live — a real two-way live
chat, not just an agent-side convenience.

## Why not Pusher Beams for this?

Beams delivers OS-level push notifications to a device via the browser
Push API — it's built for the app being **closed**. It has no mechanism to
push live data into a page that's already open in a tab. Making an open
page update itself needs a pub/sub product: Pusher **Channels**.

## Enabling it

1. In the [Pusher dashboard](https://dashboard.pusher.com), create a new
   **Channels** app (separate from any Beams instance you may already
   have — same account, different product).
2. Set App ID, Key, Secret, and Cluster (e.g. `us2`, `eu`) from
   **Admin → Integrations** (or the setup wizard's Integrations step) —
   takes effect immediately, no restart or rebuild. The four matching env
   vars (`PUSHER_APP_ID`, `NEXT_PUBLIC_PUSHER_KEY`, `PUSHER_SECRET`,
   `NEXT_PUBLIC_PUSHER_CLUSTER`) are still supported as a fallback for
   anyone who prefers env-based config; a DB-saved value always wins over
   its env var (see `lib/integration-settings.ts`).

The two `NEXT_PUBLIC_*` values used to require baking into the browser
bundle at Docker build time. They no longer do: the browser fetches them at
runtime from `GET /api/config/client` instead of reading
`process.env.NEXT_PUBLIC_*` directly (see `lib/pusher-browser.ts`) — so the
plain published image works fine, and `docker-compose.build.yml` is no
longer needed just for Pusher. Setting these two vars via `.env` still goes
through the old build-arg path if you build from source, though — see
`.env.docker.example`.

That's it — no schema change beyond `integration_settings`, no migration
needed for existing installs.

## How it works

| Piece | File |
|-------|------|
| Server publish helpers | `lib/realtime.ts` (`publishTicketCreated`, `publishTicketCommentCreated`, `isRealtimeConfigured`, `authorizeChannel`) |
| Channel auth endpoint | `app/api/pusher/auth/route.ts` — **not** covered by the middleware matcher (`proxy.ts`), because it must serve both agent/admin (session) and customer (token, no session) callers. Does its own branching auth check — see Security below. |
| Agent client | `lib/pusher-browser.ts`'s `getPusherClient()` — session-authenticated, cached singleton per tab |
| Customer client | `lib/pusher-browser.ts`'s `getPusherClientForCustomer(token)` — token-authenticated, a fresh (uncached) client per mount, since a customer can navigate between sibling tickets each with a different token |
| Agent list subscriber | `components/agent/tickets-list-realtime.tsx`, mounted in `app/(agent)/tickets/page.tsx` |
| Agent detail subscriber | `components/agent/ticket-detail-realtime.tsx`, mounted in `app/(agent)/tickets/[ticketNumber]/page.tsx` |
| Customer detail subscriber | `app/(customer)/ticket/[ticketId]/ticket-realtime.tsx`, mounted in the customer ticket page |
| Publish call sites | `POST /api/tickets` (ticket creation) and `POST /api/tickets/[id]/comments` (any comment) |

**Channels used:**

- `private-tickets` — one global channel, agent/admin only, subscribed to
  while viewing the ticket list.
- `private-ticket-{ticketId}` — one channel per ticket, subscribed to by
  whoever (agent or customer) is viewing that ticket's detail page.

Both are **private channels** (require the auth endpoint) rather than
public ones — ticket data shouldn't be broadcastable to anyone who knows
the app key.

**Payloads are deliberately empty.** The server doesn't push ticket/comment
content through Pusher directly — it just signals "something changed," and
the client responds with `router.refresh()`, which re-runs the exact same
server-side query + auth check that already backs the page (including the
existing internal-note-stripping for the customer-facing API). This avoids
a second code path for serialization and access rules, at the cost of a
small round-trip versus rendering pushed data directly.

Publishing is **best-effort and never blocks the request** — every call is
wrapped in `.catch(console.error)`, same convention as every other
notification in this codebase (`lib/push.ts`, `lib/notifications.ts`).

## Security: who can subscribe to what

`app/api/pusher/auth/route.ts` branches on the requested channel:

- `private-tickets` (the list) — **agent/admin session required.** A
  customer request (no session) is always rejected, regardless of any
  token.
- `private-ticket-{id}` — agent/admin session **or** a `token` (sent as an
  extra `channelAuthorization` param by `getPusherClientForCustomer`) that
  matches that exact ticket's `customerToken` in the database. A customer
  can only ever subscribe to their own ticket's channel — the token is
  checked against that specific `{id}`, not accepted for any ticket.

This mirrors the same "check the explicit customer token, don't just trust
whatever session cookie happens to be on the request" principle used by
`POST /api/tickets/[id]/comments` (see the note in that file about why
token presence must be checked before/instead of falling back to a session
lookup — the same class of bug is possible here if it were done the other
way around).

## Scope

Both agent and customer sides. Not covered: typing indicators / presence
("agent is replying…") — a further live-chat enhancement, not requested,
would reuse the same channels.
