# Admin Portal

## Overview

The admin portal gives admins full control over the support tool — everything an agent can do, plus user management, role assignment, and spam ticket deletion.

Admins use the same agent portal routes (`/dashboard`, `/tickets`) with additional capabilities unlocked by their role. Admin-only sections live under `/(admin)/`.

Access requires a session with `role: admin`.

---

## Admin Capabilities (vs. Agent)

| Capability | Agent | Admin |
|------------|-------|-------|
| View all tickets | Yes | Yes |
| Search & filter tickets | Yes | Yes |
| Assign tickets | Yes | Yes |
| Reply to customers | Yes | Yes |
| Add internal notes | Yes | Yes |
| Change ticket status | Yes | Yes |
| Close / Reopen tickets | Yes | Yes |
| Delete tickets (spam) | No | **Yes** |
| View all users | No | **Yes** |
| Assign / change user roles | No | **Yes** |
| Deactivate / reactivate users | No | **Yes** |
| Promote to admin | No | **Yes** (or via CLI) |
| View cross-agent reports (`/admin/reports`) | No | **Yes** |

---

## 1. User Management (`/admin/users`)

### Add User

Admins create new agent/admin accounts via the "Add User" button. There is exactly **one** way to do this: the admin enters name, email, role, and the new user's password directly in the dialog (min 8 characters, confirm field). No email is sent — the admin shares the password with the user themselves, same as the Reset Password flow below. This works with no SMTP configured, and the account is usable (and assignable to tickets) immediately.

Because the password is mandatory, the dialog requires password sign-in to be enabled. When it's off, the dialog explains that and links to `/admin/appearance` instead of showing the form; `POST /api/users` rejects the request with `403` regardless of the UI.

### User List

Shows all agent/admin users. Paginated — 25 per page.

Each row shows:
- Avatar + name + email
- Role badge (Agent / Admin)
- Status (Active / Deactivated)
- Joined date

### Search

Search by name or email.

### Actions Per User

| Action | Description |
|--------|-------------|
| Change Role | Set to `agent` or `admin` |
| Reset Password | Directly set a new password for the user — no old password required, nothing emailed. Only shown when password sign-in is enabled. |
| Deactivate | The standard off-boarding action. Immediately revokes all sessions; the user cannot sign in, be assigned new tickets, or receive notifications. Existing assignments and reply history are untouched. Reversible. Optionally enter a reason. |
| Reactivate | Restores sign-in access, assignability, and notifications. |
| Delete Permanently | Erasure path — removes the user record and their sessions, unassigns their tickets, and replaces their name with "Deleted user" in every reply, note, attachment, and activity entry. Not reversible. |

**Deactivate vs. Delete.** Deactivate is an access decision; delete is a data
decision. Off-boarding a colleague should always use Deactivate — a resolved
ticket needs to keep saying who resolved it. Reserve Delete for erasure
requests, where the name has to go with the account.

### Assign Role Flow

1. Admin clicks "Change Role" on a user row.
2. A small popover/dialog appears: "Set role for [name]" — radio: Agent / Admin.
3. Confirm.
4. Role updated immediately. If the user is currently signed in, their next request will reflect the new role (session is not revoked — role is read from DB on each request).

### Reset Password Flow

1. Admin clicks "Reset Password" on a user row (hidden if password sign-in is disabled platform-wide).
2. Dialog: enter a new password (min 8 characters) and confirm it.
3. Confirm. The user's password is updated immediately — no email is sent, so the admin must share the new password with the user themselves.
4. The user's existing sessions are unaffected; they keep using the app until they next sign out, then sign back in with the new password.

### Deactivate Flow

1. Admin clicks "Deactivate".
2. Dialog explains that the user is signed out immediately, can no longer sign in or take new tickets, but keeps their existing assignments and history — and that it's reversible.
3. Optional: enter a reason (shown in the user list for admin reference).
4. Confirm.
5. Better Auth revokes all active sessions for that user.

Deactivated users are excluded from the assignee picker, notification fan-out,
and API auto-assignment — all of which filter on `user.banned = false`. A
ticket still assigned to a deactivated agent keeps showing their name, suffixed
"(deactivated)" (see `buildAssigneeOptions` in `lib/tickets.ts`).

> The DB column is `user.banned` — owned by Better Auth's Admin Plugin, so the
> name stays. Every user-facing surface says "deactivated". Audit slugs
> (`user.banned` / `user.unbanned`) are unchanged too, so historical log rows
> keep matching the filter; only their display labels were updated.

### Delete Permanently Flow

1. Admin clicks "Delete Permanently".
2. Confirmation dialog spells out the erasure, and points to Deactivate as the option for ordinary off-boarding.
3. Admin must type the user's email to confirm.
4. On confirm, in a single transaction (`anonymizeUserContent` in `lib/user-deletion.ts`, then the deletes):
   - `authorName` / `actorName` / `uploadedByName` / `createdByName` snapshots pointing at this user are set to "Deleted user". This runs **first** — those columns are `ON DELETE SET NULL`, so the rows are unreachable once the user is gone.
   - Any tickets assigned to this user set `assignedAgentId = null`.
   - All sessions deleted.
   - `account` and `user` records deleted.
5. `audit_logs` is deliberately **not** scrubbed — it's the tamper-evident record of admin actions, including this deletion. Purge it separately if a specific erasure request requires it.

The self-service "delete my account" action (`app/actions/profile.ts`) runs the
same anonymization, so both erasure paths behave identically.

---

## 2. Delete Ticket (Spam) (`/tickets/{ticketNumber}`)

Admins see a "Delete Ticket" button in the ticket detail sidebar that agents do not see.

### Flow

1. Admin clicks "Delete Ticket".
2. Confirmation dialog: "Permanently delete ticket #1042? All comments and attachments will be deleted. This cannot be undone."
3. On confirm:
   - All attachments deleted from storage first (files deleted before DB records).
   - All `ticket_comments` deleted (cascade).
   - All `ticket_activity` deleted (cascade).
   - All `ticket_attachments` deleted (cascade).
   - `ticket` record deleted.
4. Admin redirected to `/tickets`.

---

## 3. Ticket Configuration (`/admin/ticket-config`)

Admins can manage the statuses and categories used across all tickets. Changes take effect immediately for all new and existing ticket displays.

### Attachment Limits

The top card sets three limits — maximum files per message (default 5), maximum file size in MB
(default 10) and **maximum attachment storage per ticket** in MB (default 250, range 1–10,000, and not
smaller than the per-file size). The per-ticket value caps the combined size of all attachments across
a ticket's messages and replies; the number of attachments per ticket is not limited. Integers only,
validated client- and server-side. They live on `platform_settings`, are read per request via
`getAttachmentLimits()` in `lib/settings.ts`, and apply to the customer portal, agent replies and the
public API immediately — no redeploy. Lowering a limit never deletes existing files: a ticket already
over its storage limit (for example after a merge) keeps and can serve them but takes no new
attachments until usage is back under the limit. File types and the 2 MB logo/favicon limits are fixed.

### Ticket Actions

The first card on the page switches the agent ticket actions on or off, each with its own
notification switch (all on by default; stored on `platform_settings`, read via
`getTicketActionSettings()` in `lib/settings.ts`):

| Action | Feature switch (`…Enabled`) | When off | Notification switch (`…NotificationsEnabled`) |
|---|---|---|---|
| Merge | `ticketMergeEnabled` | "Merge Ticket" button hidden; `POST /api/tickets/{id}/merge` → 403 | `ticket_merged` notifications; plus **Email the customer** (`ticketMergeCustomerEmailEnabled`) for the "Ticket Merged" email |
| Split | `ticketSplitEnabled` | Split icon hidden on customer replies; `POST /api/tickets/{id}/split` → 403 | The owner's `ticket_split` notification (with it off, the owner gets the plain `ticket_created` one instead — the new ticket's `ticket_created` notification and push always go out, like any new ticket) |
| Link | `ticketLinkEnabled` | Add/remove controls hidden — existing links stay visible read-only (sidebar card hidden if there are none); link add/remove APIs → 403 | `ticket_linked` notifications |

A notification switch is greyed out while its feature is off. Changes apply on the next
page load / request — no restart. Saved through `PATCH /api/admin/settings`.

### 3a. Statuses

Displays all ticket statuses in `sortOrder` order.

Each status row shows:
- Color swatch + label + slug (read-only)
- **Default** badge (if `isDefault = true`) — shown as a green "Default" chip
- **Closed State** badge (if `isClosedState = true`) — shown as a gray "Closed State" chip
- Edit + Delete buttons

**Add Status** — a form/dialog with:
- Label (text input) — slug auto-generated from label on creation, shown as read-only preview
- Color (preset picker: Blue / Amber / Slate / Red / Orange / Purple / Green / Teal / Pink / Indigo)
- Mark as default (checkbox)
- Mark as closed state (checkbox)

**Edit Status** — dialog pre-filled with existing values. Slug is read-only (immutable after creation).

**Delete Status** — blocked if:
- It is the only remaining status
- It is the current default status
- Any tickets currently use this status slug (show count in error)

**Setting a new default** — when admin marks a status as default, the previous default is automatically unset. There is always exactly one default.

### 3b. Categories

Same pattern as statuses, minus the `isDefault` and `isClosedState` flags.

**Add Category** — label + color picker.

**Edit Category** — label and color only (slug immutable).

**Delete Category** — blocked if any tickets currently use this category slug.

### 3c. SLA Policies

Displays all SLA policies in `sortOrder` order. Each policy has a name, an optional priority/category scope (both default to "Any"), and three targets in minutes: First Response, Next Response, Resolution. See `docs/tickets.md` § SLA for the full model (scoping precedence, the three metrics, pause/resume behavior).

Each policy row shows:
- Name + scope (e.g. "Any priority · Any category", "Urgent · Billing")
- **Default** badge (if `isDefault = true`)
- The three targets, formatted (e.g. "1h 30m")
- Edit + Delete buttons

**Add/Edit Policy** — a form/dialog with:
- Name (text input)
- Priority scope (select: Any + each configured priority)
- Category scope (select: Any + each configured category)
- First Response / Next Response / Resolution (minute inputs)
- Mark as default (checkbox — only enabled when both scope selects are "Any"; only an unscoped policy can be the global fallback)

**Delete Policy** — blocked if it is the current default policy (set another policy as default first). Unlike statuses/categories, there's no "tickets currently use this" check — policies aren't referenced by id on `tickets`, they're resolved live by matching priority/category.

**Setting a new default** — when admin marks a policy as default, the previous default is automatically unset, same pattern as statuses/priorities.

### 3d. Color Presets

Both statuses and categories use a fixed set of named color presets for badge styling. Stored as a color name in the DB, resolved to Tailwind classes at render time via `COLOR_BADGE` in `lib/tickets.ts`:

| Name | Badge classes |
|------|--------------|
| `blue` | `bg-sky-100 text-sky-700 border-sky-200` |
| `amber` | `bg-amber-100 text-amber-700 border-amber-200` |
| `slate` | `bg-stone-100 text-stone-600 border-stone-200` |
| `red` | `bg-red-50 text-red-700 border-red-200` |
| `orange` | `bg-orange-50 text-orange-700 border-orange-200` |
| `purple` | `bg-purple-50 text-purple-700 border-purple-200` |
| `green` | `bg-emerald-50 text-emerald-700 border-emerald-200` |
| `teal` | `bg-teal-50 text-teal-700 border-teal-200` |
| `pink` | `bg-pink-50 text-pink-700 border-pink-200` |
| `indigo` | `bg-indigo-50 text-indigo-700 border-indigo-200` |

### 3e. Seeding Defaults

On a fresh install, run `pnpm seed` to populate `ticket_statuses`, `ticket_categories`, `ticket_priorities`, and a default `sla_policies` row with the default values documented in `docs/tickets.md`. This is idempotent — it skips rows that already exist (by slug for statuses/categories/priorities, by a fixed id for the seeded SLA policy).

---

## 4. Reports (`/admin/reports`)

Admin-only — the only place in the app that compares agents against each other, which is why it's gated to admin rather than shared with the agent dashboard (`/dashboard`, which stays identical for agents and admins). Answers "who's busy, and how fast are we?"

A range toggle (**Last 30 days** / **Last 90 days** / **All time**, default 30 days) applies to every report below and to its CSV export, filtered on ticket creation date.

### 4a. Tickets per Agent

A stacked horizontal bar chart (Open vs. Closed per agent) sits above the table for an at-a-glance read of who's carrying the most open load, followed by the detailed table: one row per agent (by *current* assignment — not reassignment history) plus an **Unassigned** row, with Total tickets, Open tickets, Avg First Response, Avg Resolution.

- **Avg First Response** — average time from ticket creation to that agent's first public reply (`tickets.firstRespondedAt - tickets.createdAt`).
- **Avg Resolution** — average `tickets.slaActiveSeconds` (accumulated agent-active time toward resolution — already excludes time spent waiting on the customer, see `docs/tickets.md` § SLA) across that agent's closed tickets. This is a materially better "how fast do we resolve" number than a naive `closedAt - createdAt`, since it doesn't penalize an agent for a customer who took 3 days to reply.
- Both averages are blank ("—") for an agent with no qualifying tickets yet (no replies sent / no tickets closed) in the selected range.

### 4b. Tickets by Category / Priority / Tag

Three breakdown sections, each pairing a horizontal bar chart with its table — Category and Priority show count + share of total; Tag shows count only (a ticket can have multiple tags, so tag shares wouldn't sum to 100%) and is capped to the **top 20 tags** by ticket count (tags are an unbounded freeform pool — see `docs/tickets.md` § Tags).

Category and Priority bars (≤8 rows) are colored individually from the app's validated categorical chart palette (`--chart-1` … `--chart-8` in `app/globals.css`, `lib/chart-colors.ts`); Tag (up to 20 rows) uses a single hue instead, since per-bar color only carries meaning when there are few enough series to stay distinguishable.

### 4c. CSV Export

Every report has its own "Download CSV" link — a plain download, no dialog or client-side processing. Respects the current range selection. Time columns in the CSV are raw seconds (not formatted "2h 15m" strings) — a CSV is for further spreadsheet analysis, where raw numbers are more useful than pre-formatted text.

---

## 5. Audit Log (`/admin/audit-log`)

A system-wide, admin-only trail of sensitive actions — separate from `ticket_activity` (which is per-ticket and shown in the ticket detail sidebar; see `docs/tickets.md`). Newest first, paginated 25 per page.

Logged today: user role changes/bans/deletes, ticket deletion (single and bulk), ticket bulk actions, every ticket-config change (statuses/categories/priorities/SLA policies/custom fields), email template edits, platform/appearance settings changes (including the sign-in method toggles), API key create/revoke, MCP token create/revoke and the MCP on/off switch (`mcp_token.created`, `mcp_token.revoked`, `mcp.enabled_changed`), plus all the auth/profile/session events from the Better Auth side. See `docs/plans/07-audit-log-viewer.md`'s addendum for the full list and the reasoning behind what's deliberately *not* logged (read-only routes, field-level renames that don't change access or config).

- **Search** — matches `description` or `actorEmail` (`ilike`).
- **Action filter** — a dropdown populated from a live `SELECT DISTINCT action` over the table itself, not a hardcoded list, so it can never miss an action type that's actually been logged.
- Click a row with metadata to expand the raw JSON — useful for debugging without a dedicated column per possible shape.
- Failing to write an audit entry never breaks the action it's describing — `audit()` swallows its own errors (logged to the server console) rather than throwing.

## 6. AI Assistant (MCP) (`/admin/mcp`)

Admin-only page that controls whether agents and admins can connect an AI assistant (for example Claude Code) to Docket over the Model Context Protocol, and shows every token that has been issued.

### 6a. MCP Access

- A single switch turns the MCP endpoint on or off. It is **off by default**; while it is off the endpoint refuses every request and no one can create a token. Changes apply immediately.
- A **Data-sharing notice** callout sits next to the switch. Its wording is a placeholder for now and will be replaced once the final text is approved.
- In production the switch can only be turned on when `NEXT_PUBLIC_APP_URL` uses `https://`, because tokens travel in a request header. When that is not the case the page shows a warning and the switch cannot be turned on; if the server still rejects the request, its message is shown.
- While enabled, the endpoint URL (`<app URL>/api/mcp`) is shown read-only for client setup.

### 6b. Token Oversight

A table of **all** tokens from all users: owner (name and email), token name, key prefix (`dkm_xxxxxxxx…` — the secret itself is never shown or retrievable), scopes, created, last used, expires, and status (`active`, `expired`, `revoked`). Active tokens have a **Revoke** button that opens a confirmation dialog; revoking takes effect immediately and cannot be undone.

Tokens are also revoked automatically when their owner is deactivated, when the owner signs out their other sessions, and when the owner's role stops being agent or admin. See `docs/agent-portal.md` § Settings for what agents see.

The sidebar entry is **AI assistant (MCP)**, next to API Keys.

---

## 7. Admin Access to Orbit Panel

Admins also have access to the Better Auth Orbit panel at `/orbit`:
- View all user sessions.
- Impersonate any user (for debugging).
- View email outbox (sent emails).
- View job queue state (pg-boss).

This is provided by the scaffold — no custom implementation needed.

---

## 8. Business Rules

1. There must always be at least one admin in the system. Prevent the last admin from being demoted or deleted.
2. An admin cannot deactivate themselves.
3. Deleting a user does not delete their tickets or comments — tickets become unassigned and the author name on their comments becomes "Deleted user". Deactivating changes neither.
4. Ticket deletion is hard delete — no soft delete, no recovery.
5. When deleting a ticket, always delete storage files before the DB record.
6. Role changes take effect on the user's next API request — no need to force sign-out.
7. Admins can manage users created by any auth method (magic link, Google).

---

## 9. UI Notes

- Admin-only items (Delete Ticket button, Users/Reports nav links) are conditionally rendered based on `session.user.role === 'admin'`.
- The Users and Reports pages (`/admin/users`, `/admin/reports`) are not linked in the agent sidebar — only visible to admins.
- Destructive actions (delete ticket, delete user, deactivate user) always use `Dialog` from `components/ui/dialog.tsx` with explicit confirmation — never `window.confirm()`.
- Use Phosphor Icons: `TrashIcon` for delete, `UserMinusIcon` / `UserPlusIcon` for deactivate / reactivate, `ShieldCheckIcon` for admin role.
- Deactivate uses primary (not destructive) button styling and a muted status badge — it's routine off-boarding, not an error state. Only Delete Permanently is styled destructive.
