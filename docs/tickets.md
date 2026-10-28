# Tickets

## Overview

A ticket is the core entity of the support tool. It represents a support request submitted by a customer and worked on by agents.

---

## Ticket Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | cuid2 | Internal unique ID |
| `ticketNumber` | serial integer | Human-readable ID (#1001, #1002…) |
| `subject` | text | Short summary of the issue |
| `description` | text | Tiptap JSON (rich text), same as reply `content`. Legacy rows may be plain text — readers tolerate both. Flatten with `richTextToPlainText()` for previews/emails |
| `category` | text (slug) | References `ticket_categories.slug` — admin-configurable |
| `status` | text (slug) | References `ticket_statuses.slug` — admin-configurable |
| `customerName` | text | Name provided by the customer |
| `customerEmail` | text | Email provided by the customer |
| `customerToken` | text (cuid2) | Secret token for customer access — never exposed to agents via API |
| `assignedAgentId` | text (FK) | Agent assigned to this ticket (nullable) |
| `closedAt` | timestamp | When the ticket was closed (nullable) |
| `createdAt` | timestamp | When the ticket was created |
| `updatedAt` | timestamp | When the ticket was last updated |
| `waitingSince` | timestamp | SLA: when the current wait state began; null once closed. See § SLA |
| `firstRespondedAt` | timestamp | SLA: frozen at the first non-internal agent/admin reply |
| `slaActiveSeconds` | integer | SLA: accumulated "waiting for agent" seconds (Resolution clock) |

---

## Categories

Categories are **admin-configurable** — managed at `/admin/ticket-config`. They are stored in the `ticket_categories` table. The `category` field on a ticket stores the category's **slug** (stable identifier, never changes after creation).

Default seeded categories (installed on first `pnpm seed`):

| Slug | Label | Color |
|------|-------|-------|
| `bug` | Bug | Red |
| `issue` | Issue | Orange |
| `feature_request` | Feature Request | Purple |
| `billing` | Billing | Green |
| `general_query` | General Query | Slate |

Admins can add, rename, recolor, reorder, and delete categories. A category cannot be deleted if any tickets currently use it.

---

## Statuses

Statuses are **admin-configurable** — managed at `/admin/ticket-config`. They are stored in the `ticket_statuses` table. The `status` field on a ticket stores the status's **slug**.

Each status has two special flags:
- **`isDefault`** — exactly one status must be default. Applied automatically to new tickets.
- **`isClosedState`** — setting a ticket to this status sets `closedAt` and triggers the "closed" email notification.

Default seeded statuses (installed on first `pnpm seed`):

| Slug | Label | Color | Default | Closed State |
|------|-------|-------|---------|--------------|
| `open` | Open | Blue | Yes | No |
| `in_progress` | In Progress | Amber | No | No |
| `closed` | Closed | Slate | No | Yes |

### Status Transitions

```
open ──────────────────► in_progress ──► closed
 ▲                                          │
 └──────────────────────────────────────────┘ (reopen)
```

- **Customer** can: close their own ticket (any non-closed-state → any closed-state), reopen their own ticket (any closed-state → the default status).
- **Agent/Admin** can: change status to any value.

### Business Rules

- There must always be at least one status with `isDefault = true`. Setting a new default automatically unsets the previous one.
- There must always be at least one status with `isClosedState = true`.
- A status cannot be deleted if any tickets currently use it.
- Admin-added statuses are treated the same as built-in ones for all workflow logic.

---

## Tags

Tags are **freeform** — any agent can type a new tag on a ticket; it's created in a shared pool (`tags` table) on first use and then autocompleted for everyone (unlike Statuses/Categories/Priorities, there is no admin management screen). A ticket can have any number of tags, via the `ticket_tags` join table (many-to-many).

- Tag names are normalized (trimmed, collapsed whitespace, lowercased) so `"Billing"` and `"billing "` share one row.
- Managed from the ticket detail page's "Tags" sidebar card — add via the "+ Add tag" popover (search existing or create new), remove via the `×` on a tag chip.
- `POST /api/tickets/{id}/tags` (body `{ name }`) and `DELETE /api/tickets/{id}/tags/{tagId}` — both agent/admin only.
- `GET /api/tags?q=…` — autocomplete search across the shared pool.
- Adding/removing a tag logs a `tag_added`/`tag_removed` row in `ticket_activity`.
- Also shown as a (customizable, non-filterable) column on the ticket list — see [Ticket List Columns](#ticket-list-columns).

---

## Custom Fields

Admin-defined extra structured fields — text, number, date, checkbox, or select — for data the built-in fields don't cover (order ID, account plan, etc.). Unlike Tags, these are admin-managed (like Statuses/Categories/Priorities): agents can't create one on the fly.

- Defined at `/admin/custom-fields` (`ticket_custom_fields` table) — admin-only to add/edit/delete. Each field has a `label`, a `type`, an immutable machine `key` (auto-slugified from the label), and an optional `required` flag; `select` fields also have a fixed `options` list.
- Values are per-ticket (`ticket_custom_field_values`, one row per ticket/field pair) and shown/edited in the ticket detail page's "Custom Fields" sidebar card — agent/admin only. Saves immediately on blur/change, like the other sidebar fields.
- **Not** exposed on the customer portal submission form — customers never set these directly.
- Settable at ticket-creation time via the public API's `customFields` payload (see `docs/api.md`), and readable via `GET /api/v1/tickets/:id` and `GET /api/v1/config`.
- Deleting a field definition cascades to delete its stored values (hard delete, no "in use" block — unlike Categories/Statuses/Priorities, this is a real foreign key, not a denormalized slug on `tickets`).
- Editing a field logs a `custom_field_changed` row in `ticket_activity`.

---

## SLA

**Currently hidden from the UI.** The admin policy manager, the per-agent "Show SLA & Overdue" setting, and the metric/outcome badges are all disabled — every page that computes an `SlaSnapshot` now resolves a `null` policy, so `firstResponse`/`nextResponse`/`resolution` are always `null` and nothing SLA-specific renders. The underlying code (this section, `lib/sla.ts`, `lib/sla-policies.ts`, `db/schema/sla-policies.ts`, `sla-policies-manager.tsx`, `sla-display-preferences-card.tsx`) is untouched and can be re-enabled by resolving a real policy again in `app/(agent)/tickets/page.tsx` and `app/(agent)/tickets/[ticketNumber]/page.tsx`, re-adding `SlaPoliciesManager` to the ticket-config page, and `SlaDisplayPreferencesCard` to settings. **Waiting Time** (below) is unaffected — it's derived from `tickets.awaitingReply`/`waitingSince` directly, not from a policy.

SLA policies are **admin-configurable** — managed at `/admin/ticket-config`, stored in `sla_policies`. Each policy defines three targets in minutes: **First Response**, **Next Response**, and **Resolution**.

### Policy scoping and resolution

A policy is optionally scoped by `priority` and/or `category` (both nullable — null means "any"). The **most specific match wins**, resolved live against the current policy list every time it's needed (not snapshotted per ticket — editing a policy immediately re-targets its matching open tickets):

1. exact match: `priority = ticket.priority AND category = ticket.category`
2. `priority = ticket.priority AND category IS NULL`
3. `priority IS NULL AND category = ticket.category`
4. the `isDefault` policy (the global fallback — always unscoped, `priority` and `category` both null)

Exactly one policy should have `isDefault = true`. The admin UI only allows marking an unscoped ("Any priority" / "Any category") policy as default, and setting a new default automatically unsets the previous one.

### The three metrics

- **First Response** — elapsed time from ticket creation to the first non-internal agent/admin reply. Frozen permanently once that reply happens (`tickets.firstRespondedAt`) — the metric keeps showing its final met/breached outcome afterward.
- **Next Response** — elapsed time since the customer's most recent unanswered message (`tickets.waitingSince`), counted only once First Response has already happened and only while currently waiting on the agent. Not shown while waiting on the customer (nothing is currently due from the agent) or before the first reply.
- **Resolution** — total accumulated "waiting for agent" time across the ticket's whole lifetime (`tickets.slaActiveSeconds` plus any in-progress span), compared against the policy's resolution target. Frozen with a final met/breached verdict once the ticket is closed; resuming (reopening) continues accumulating from where it left off rather than resetting.

### Pause/resume

The SLA clock rides the same `tickets.awaitingReply` flag the rest of the app already uses for the unread/notification badge: `true` = **waiting for agent** (clock running), `false` = **waiting for customer** (clock paused). It's flipped by the same events that already flip `awaitingReply` — ticket creation, agent/customer replies, close, and reopen — so there's no separate event stream to keep in sync. `tickets.waitingSince` records when the *current* wait state began, and is only updated on an actual state change (a customer's second follow-up before the agent replies doesn't reset anything).

### Display

Shown on both the ticket list (customizable **SLA** column — see § Ticket List Columns) and the ticket detail page's **SLA** sidebar card. While the ticket is **open**: "Open for" (total ticket age), the current wait state with its duration ("Waiting for agent · 2h 15m" / "Waiting for customer…"), and each applicable metric as a colored pill:

| Color | Meaning |
|-------|---------|
| Green | On track |
| Yellow | Live and ≥80% of the target elapsed (approaching deadline) |
| Red | Breached (live and over target, or a frozen breached outcome) |
| Grey | Already met — a finished target, kept quiet so live SLAs stand out |

The countdown ticks forward client-side every 30 seconds without a page reload — the server sends one snapshot per ticket and the client re-derives the current elapsed time from it.

**Once the ticket is closed, every clock stops.** There is no countdown left to run, so the display switches to the outcome:

- "Open for" becomes **"Resolved in 2d 4h"** — the ticket's total lifetime (created → closed), a fixed number. It never keeps counting up after closure.
- The list's Waiting Time column drops the most-urgent-metric pill and shows one **verdict pill** instead: **"SLA met"** (grey) or **"SLA breached"** (red, if *any* target was missed). Hover for the per-target breakdown.
- The detail sidebar shows the same verdict pill alongside every individual target's final result.

A breach stays red after closing — it's the permanent record the team reports on. A met target goes grey, because a wall of green on closed tickets drowns out the open ones that actually need attention.

While a ticket is open but **waiting on the customer**, the Resolution clock is paused, not finished: it reads "paused · 3h left" (or "paused · overdue by 20m"). It never reports "met" — nothing has been met until the ticket is actually resolved.

### Business rules

- A policy's (priority, category) scope pair must be unique — the admin API rejects a duplicate.
- Only an unscoped policy can be `isDefault`.
- The `isDefault` policy cannot be deleted — mark another policy as default first.
- See `docs/plans/12-sla.md` for the full design write-up, including business-hours/holidays as a documented future extension point.

---

## Ticket Number

- `ticket_number` is a PostgreSQL `serial` (auto-increment integer).
- Always displayed with a `#` prefix in the UI: `#1001`.
- Used for searching — agents can search by ticket number.
- Never editable.

---

## Ticket List Columns

Each agent/admin can customize their own `/tickets` table — which columns are shown and in what order —
from the "Columns" button above the table. Checkbox, `#`, and Subject are always pinned first; the rest
(Status, Category, Priority, Waiting Time, Customer, Assigned, Tags, Updated By, Updated) are toggle/reorderable.

- Persisted per user in `user_ticket_table_prefs` (`columns` jsonb — visibility + order), via
  `PATCH /api/tickets/table-columns`. Not shared across agents.
- **Waiting Time** (column id `waitingTime` — named for the always-on Waiting Time display, not the
  disabled SLA feature it also carries) — for an open ticket: "Open for" + current wait state, plus, only
  if SLA is re-enabled, the single most urgent metric (First/Next Response or Resolution, whichever is
  closest to breaching). For a closed ticket: "Resolved in …" + a single "SLA met" / "SLA breached"
  verdict pill when SLA is active. See § SLA for the full model; the detail page's Waiting Time sidebar
  card shows all three metrics when SLA is active.
- **Tags** — the ticket's tags, read-only in this view (manage them from the ticket detail sidebar).
- **Updated By** — the most recent **agent/admin** actor from `ticket_activity` for that ticket (customer
  activity is excluded); shows "—" if no agent/admin has touched it yet.

---

## Comments / Replies

All communication on a ticket (customer replies + agent replies + internal notes) is stored in `ticket_comments`.

| Field | Type | Description |
|-------|------|-------------|
| `id` | cuid2 | |
| `ticketId` | text FK | |
| `authorId` | text | FK → `user.id` for agents; `null` for customer comments |
| `authorName` | text | Stored at write time — preserved if agent is later deleted |
| `authorRole` | enum | `customer` / `agent` / `admin` |
| `content` | text | Tiptap JSON (rich text). Legacy rows may be plain text — readers tolerate both. Flatten with `richTextToPlainText()` for previews/emails |
| `isInternal` | boolean | If true: visible to agents/admins only — never sent to customer |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

### Internal Notes

- Internal notes (`is_internal = true`) are only visible to agents and admins.
- They are stripped server-side from all customer-facing API responses.
- They are visually distinguished in the agent portal (e.g. yellow background, lock icon).
- Customers never see internal notes — not in the UI, not via the API.

---

## Attachments

Attachments can be added to the initial ticket or to any comment/reply.

| Field | Type | Description |
|-------|------|-------------|
| `id` | cuid2 | |
| `ticketId` | text FK | |
| `commentId` | text FK (nullable) | null = attached to the ticket itself, not a comment |
| `filename` | text | Original filename shown in UI |
| `storageKey` | text | Storage path — never a full URL |
| `fileSize` | integer | Bytes |
| `mimeType` | text | |
| `uploadedBy` | text | `user.id` for agents; `customerEmail` for customer uploads |
| `createdAt` | timestamp | |

See [file-uploads.md](./file-uploads.md) for upload rules and validation.

---

## Activity History

Every significant action on a ticket is logged in `ticket_activity` for a full audit trail.

| Action | Description |
|--------|-------------|
| `ticket_created` | Ticket was submitted |
| `status_changed` | Status changed from X to Y |
| `assigned` | Ticket assigned to agent |
| `unassigned` | Ticket unassigned |
| `comment_added` | Customer or agent replied |
| `internal_note_added` | Internal note added (visible to agents only) |
| `ticket_closed` | Ticket was closed |
| `ticket_reopened` | Ticket was reopened |
| `attachment_added` | File attached |
| `tag_added` | Tag added to the ticket |
| `tag_removed` | Tag removed from the ticket |
| `ticket_linked` / `ticket_unlinked` | A link to another ticket was added/removed (written on both tickets) |
| `merged_into` / `merged_from` | This ticket was merged into another / another ticket was merged into this one |
| `split_to` / `split_from` | A reply was split out of this ticket / this ticket was split from another |

```
ticket_activity
+-- id          cuid2 PK
+-- ticket_id   FK → tickets.id (cascade delete)
+-- actor_id    text nullable (null = customer action, since customers have no user.id)
+-- actor_name  text (stored at write time)
+-- actor_role  enum: customer / agent / admin / system
+-- action      text
+-- metadata    jsonb  ← e.g. { from: 'open', to: 'in_progress' }
+-- created_at  timestamp
```

Activity history is displayed chronologically on the ticket detail page for agents. Customers see a simplified version (status changes + replies — no internal note activity).

---

## Merge, Split & Link

Each of the three can be turned off (and its notifications separately) under
**Admin → Ticket Config → Ticket Actions** — see
[admin-portal.md § Ticket Actions](./admin-portal.md#ticket-actions). The routes then return
`403` and the UI hides the control; existing links stay visible read-only.

Agent-only actions on the ticket detail page (merge is also in the ticket list's bulk bar). Logic lives in `lib/tickets/merge.ts`,
`lib/tickets/split.ts` and `lib/tickets/links.ts`.

### Merge

"Merge" folds one or more duplicate tickets (the **sources**) into one **primary**
ticket (the **target**) — e.g. a customer who opened 3–4 tickets about the same login
problem. Both entry points open the same dialog (`components/agent/merge-tickets-dialog.tsx`):

- **Ticket sidebar → Merge Ticket:** the current ticket is ticked; the customer's other
  tickets are listed to tick (open ones first — closed ones can be folded in too).
- **Ticket list → select 2+ → Merge** (bulk bar): the selected tickets are ticked.

The agent picks the primary (it must be open; the oldest open ticket is preselected), and
the dialog sends one `POST /api/tickets/merge` with `{ sourceTicketIds, targetTicketNumber }`.
`mergeTicketsInto()` merges every source **in one transaction — all or nothing** — and
sends the customer **one** Ticket Merged email listing every merged ticket. Owners get one
in-app notification each; the audit log and `ticket.merged` webhook still get one entry per
source, the same shape as a single merge. At most 50 sources per merge. Rules, all enforced
server-side:

- **Same customer only.** The source's old portal link forwards to the target *with the
  target's token*; across customers that would hand one customer another's thread.
- The target must be **open** — the customer is forwarded there and must be able to reply.
- Neither ticket may already be merged; a ticket can't merge into itself.
- **Irreversible.** The customer gets the **Ticket Merged** email linking to the target
  (an admin can turn it off under Ticket Config → Ticket Actions; see
  [email-notifications.md § Ticket Merged](./email-notifications.md#4-ticket-merged)). Agents
  who own either ticket get a `ticket_merged` in-app notification (see
  [in-app-notifications.md](./in-app-notifications.md)).

What happens, in one transaction:

1. The source's description becomes a customer comment on the target, back-dated to the
   source's `createdAt`; the source's opening attachments are attached to that comment.
2. All source comments and attachments move to the target (storage keys don't change).
3. Tags are unioned; custom-field values only fill fields the target left empty.
4. Reply drafts on the source are deleted (they can't move — the same agent may have one on
   the target).
5. Links on the source are re-pointed at the target (self-links/duplicates dropped).
6. Tickets previously merged into the source now point at the target — forwarding is
   always a single hop.
7. The source is closed and gets `mergedIntoTicketId` / `mergedAt`. It is **kept**, not
   deleted, so its id and portal link keep working.
8. The target's `awaitingReply` / `pendingReplies` are recomputed from the merged thread
   (`lib/tickets/thread-state.ts`); `firstRespondedAt` keeps the earlier of the two.
9. An internal note on the target records the source's number and subject; `merged_into` /
   `merged_from` activity is written on both.

**Forwarding.** Reads and replies for a merged ticket act on the target:
the customer portal page redirects (`/ticket/{source}?token=…` → `/ticket/{target}?token=…`),
and the customer/agent comment routes plus the `/api/v1/tickets/:id` read and comment routes
resolve the id first (`forwardMergedTicket()` / `resolveMergedTicketId()`). The agent page
`/tickets/{sourceNumber}` redirects to the target.

**State changes are not forwarded.** Close, reopen, the agent `PATCH /api/tickets/{id}`
(status / category / priority / assignee) and `PATCH /api/v1/tickets/:id/status` answer `409`
for a merged ticket (`MERGED_TICKET_CHANGE_MESSAGE`). Forwarding them would let a stale tab or
an integrator's stored id silently close or reassign the *target* — a different conversation
than the caller meant. Bulk updates skip merged tickets. Reply drafts aren't forwarded either
(`409`): the agent may already have a draft on the target, and a stale tab's autosave would
overwrite it; the composer stops autosaving when it sees the `409`.
Merged tickets are hidden from the agent ticket list, the dashboard counts, reports, the
customer's "My Tickets" page (and its email), the customer profile popover, and
`GET /api/v1/tickets?email=`. The agent-only tag, custom-field and attachment-delete routes
forward (merge already combined those into the target), so a tab left open on the merged
ticket doesn't write to the hidden shell. When an admin deletes a status, category or
priority, merged tickets don't count as "in use" — they're moved to the target's value (or,
for status, another closed status) first (`moveMergedTicketsOffSlug()`).

**Concurrency.** Merge and split lock their tickets and re-check inside the transaction; a
conflicting simultaneous merge/split gets a `409` ("just changed by someone else"). A reply
saved while a merge is in flight waits for it; if the ticket was merged meanwhile the reply
is rejected with a `409` asking to resend (its uploads are cleaned up), never stranded on the
hidden ticket. Deleting a ticket also deletes the tickets merged into it, under a row lock so a
merge into it can't land mid-delete (`deleteTicketsWithMergedShells()`). Merges and splits are also
recorded in the admin audit log (`ticket.merged` / `ticket.split`).

**First response.** The target keeps its own `firstRespondedAt`; it only inherits the
source's when it had none and the source's came after the target was created (so a first
response can never predate the ticket).

### Split

The split icon on a **customer's public reply** moves that reply into a new ticket for the same
customer: the reply becomes the description, its attachments become the new ticket's opening
attachments, and it is removed from the original (an internal note, back-dated to the reply,
marks where it was). The
new ticket copies category, priority, `source` and `apiKeyId` (so its portal link uses the same
`portalUrlTemplate`), starts unassigned and awaiting reply, and is linked `related_to` the
original. The customer receives the normal "ticket created" email with the new link. The
original's owner gets a `ticket_split` notification (or the plain `ticket_created` one when the
admin turned split notifications off); every other active agent gets the usual
`ticket_created` one (the new ticket is unassigned), plus OS push. A reply with only
attachments gets a short placeholder description. Agent
replies and internal notes can't be split.

### Link

The **Linked Tickets** sidebar card connects tickets without moving anything. Types:

| Type | On the ticket that added it | On the other ticket |
|---|---|---|
| `related_to` | Related to #N | Related to #N |
| `duplicate_of` | Duplicate of #N | Duplicated by #N |
| `blocks` | Blocks #N | Blocked by #N |

One `ticket_links` row per link, read from both ends. Self-links, links to merged tickets,
and a second link of the same type between the same pair — in either direction (so no
"A blocks B" plus "B blocks A") — are rejected. Links are agent-only —
never shown to customers.

So a teammate working the *other* ticket can't miss a link, it surfaces in four places:

- **Ticket header** — a "Linked:" row of chips under the subject (type, `#N`, subject,
  status), each linking to the other ticket.
- **Sidebar card** — the "Linked Tickets" header shows a count even while collapsed; each
  entry says who linked it ("Linked by …").
- **Ticket list** — a link icon + count next to the subject; hover lists the numbers.
- **Notification** — adding a link sends a `ticket_linked` in-app notification for each
  end: to its assignee, or to all active agents/admins if it's unassigned (same routing as
  `customer_replied`). The agent who added it is skipped, and each person gets at most one.
  Removing a link only writes activity.

---

## Business Rules

1. Ticket numbers are sequential integers starting from 1001 (first ticket is #1001).
2. A customer can only see their own tickets (enforced by `customerToken` — not by any shared session).
3. A customer cannot see internal notes — ever.
4. A customer cannot assign tickets or change the assigned agent.
5. Only agents and admins can mark a ticket `in_progress` — customers cannot set this status.
6. Closing a ticket does not delete any data.
7. Attachments are deleted from storage before the DB record is deleted.
8. When an agent account is deleted, their `assignedAgentId` references are set to `null` (ticket becomes unassigned). Their name is preserved in comment `authorName`.
9. `customerToken` is never returned in any agent-facing API response.
10. The ticket `updatedAt` timestamp is bumped whenever a new comment is added or the status changes.

---

## API Endpoints

| Method | Route | Actor | Description |
|--------|-------|-------|-------------|
| POST | `/api/tickets` | Customer (no auth) | Create a ticket |
| GET | `/api/tickets` | Agent/Admin | List all tickets (paginated, filterable) |
| GET | `/api/tickets/mine` | Customer (token) | List tickets for a customer email (via token in query) |
| GET | `/api/tickets/{id}` | Customer (token) / Agent | Get ticket details |
| PATCH | `/api/tickets/{id}` | Agent/Admin | Update status, priority, category, or assigned agent |
| PATCH | `/api/tickets/{id}/close` | Customer (token) / Agent | Close the ticket |
| PATCH | `/api/tickets/{id}/reopen` | Customer (token) / Agent | Reopen the ticket |
| POST | `/api/tickets/{id}/comments` | Customer (token) / Agent | Add a comment or internal note |
| DELETE | `/api/tickets/{id}` | Admin only | Hard delete (spam removal) |
| POST | `/api/tickets/{id}/merge` | Agent/Admin | Merge this ticket into another (body: `{ targetTicketNumber }`) |
| POST | `/api/tickets/merge` | Agent/Admin | Merge several tickets into one, all or nothing (body: `{ sourceTicketIds, targetTicketNumber }`; max 50 sources) |
| POST | `/api/tickets/{id}/split` | Agent/Admin | Split a customer reply into a new ticket (body: `{ commentId, subject }`) |
| GET / POST | `/api/tickets/{id}/links` | Agent/Admin | List links / add one (body: `{ ticketNumber, type }`) |
| DELETE | `/api/tickets/{id}/links/{linkId}` | Agent/Admin | Remove a link (from either end) |
| PATCH | `/api/tickets/bulk` | Admin only | Bulk assign, change status, change priority, or add a tag across up to 200 tickets at once (body: `{ ids, action: "assign" \| "status" \| "priority" \| "tag", value }`) |
| DELETE | `/api/tickets/bulk` | Admin only | Bulk hard delete (spam removal) across up to 200 tickets at once |
