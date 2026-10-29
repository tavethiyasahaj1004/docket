# Changelog

Notable changes to Docket. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Docket is below 1.0.0, so a minor version bump can still contain a breaking change.
Anything needing manual work on upgrade is called out under **Upgrade notes**.

## [Unreleased]

### Added

- **OAuth sign-in for AI assistants (MCP).** claude.ai, Claude Desktop, mobile and Claude Code's
  login can now connect to `/api/mcp` by signing in to Docket and approving access on a consent
  screen, instead of pasting a personal access token. Only agents and admins can approve, only the
  permissions their role allows, and every connected app can be revoked from **Settings → Connected
  apps** (or by an admin), effective on the next call. Applications identify themselves with Client
  ID Metadata Documents; open dynamic client registration is not offered. Personal access tokens
  keep working unchanged. See `docs/mcp.md` § 3a.

### Changed

- **Better Auth upgraded from 1.6.18 to 1.7.14.** No code or configuration changes were
  needed. Checked against a fresh database: password and magic-link sign-in, sign-out,
  sessions, creating users and setting their passwords, banning, password reset, and the
  admin switches for each sign-in method all work as before. Google sign-in was only checked
  with no Google credentials set up.

### Upgrade notes

- **Two additive migrations.** `0019` adds the admin switch for MCP customer replies; `0020` adds
  the OAuth tables and an optional column on MCP approval requests. No existing data changes, and the
  tables Better Auth uses are unchanged by the 1.7 upgrade.
- **OAuth needs HTTPS.** OAuth is switched on only when `NEXT_PUBLIC_APP_URL` is `https://` (or a
  `localhost` / `127.0.0.1` address). Any other plain-`http` deployment starts as before, with
  personal access tokens only.
- **Reverse proxies** must pass `/.well-known/oauth-protected-resource/…`,
  `/.well-known/oauth-authorization-server/…` and `/api/auth/…` through unchanged for OAuth to work.
- Known issue, not fixed yet: a magic-link sign-in to an email address changed on the profile
  page now removes that account's password and signs out its other sessions. An admin can
  set a new password. Tracked as Pending in the README's Roadmap.

### Fixed

- **A ticket closed twice at the same moment** (two tabs, the customer portal, the API) now sends
  one close email and one `ticket.closed` webhook instead of two. The second request gets the usual
  "Ticket is already closed." response.
- **Closing from the status menu at the same moment as another close** no longer sends a
  duplicate `ticket.closed` webhook or writes a second "closed" entry in the ticket activity.

## [0.9.0] - 2026-10-28

### Added

- **AI assistant access (MCP).** Docket can expose a Model Context Protocol endpoint at `/api/mcp`,
  so an assistant such as Claude Code can look up tickets, threads, customers, canned responses and
  statistics as the agent or admin who created its token, seeing only what that person can see.
  An admin switches it on under **Admin → AI assistant (MCP)**. It is off by default, and in
  production it only turns on when `NEXT_PUBLIC_APP_URL` uses `https://`. Each person creates
  their own tokens under **Settings → AI assistant access**. Tokens are read-only unless the
  optional `tickets:write` scope is ticked; with it the assistant can save reply drafts, add
  internal notes and change tags, priority and category. It cannot reply to a customer, close,
  reopen or assign, and every change is recorded in the audit log and ticket activity. See
  `docs/mcp.md`.

### Security

- **API attachment downloads match what the API lists.**
  `GET /api/v1/tickets/:id/attachments/:attachmentId` now serves only a ticket's own attachments
  and those on public replies, the files the `url` fields on `GET /tickets/:id` and
  `GET /tickets/:id/comments` point to. Any other attachment id gets the same `404` as an unknown
  one. Integrations that follow those `url` fields are unaffected.
- **Ticket attachment links are tied to a sign-in or a portal visit.** Agents and admins open
  attachments as before while signed in. The customer portal now shows each attachment through a
  link that expires after one to two hours; reloading the page gives fresh links. Logos and other
  branding images stay public, so emails are unaffected.

### Upgrade notes

- A raw `/api/files/tickets/...` attachment URL that was copied or saved elsewhere now opens only
  for a signed-in agent or admin. Customers' portal links in emails keep working and always show
  current attachment links.
- Docket now logs a warning at startup when `APP_SECRET` is shorter than 32 characters. It still
  starts; generate a longer value with `openssl rand -base64 32` when convenient. Changing
  `APP_SECRET` signs everyone out and makes previously encrypted settings unreadable, so plan it.

## [0.8.0] - 2026-10-22

### Added

- **Filter the ticket list by tag.** The Filters popover has a new **Tag** dropdown listing the
  shared tag pool. The choice is kept in the URL (`?tag=<name>`), shows as a removable chip, and
  also applies to the queue-tab counts, pagination and the ticket page's Previous/Next.
- **Single-container deploys now migrate and run the worker.** The image has an entrypoint
  (`scripts/docker-entrypoint.sh`): with no command it applies pending migrations, then runs the web
  server and one worker. Previously a platform that runs the image once (Dokploy, Coolify,
  `docker run`) started only the web server, so a release that added a column failed with a Server
  Components render error and no email was ever sent. Pick a role with `DOCKET_ROLE`
  (`all`/`app`/`worker`/`migrate`); skip migrations with `DOCKET_RUN_MIGRATIONS=false`. The compose
  files are unchanged: their explicit `command:` per service passes straight through.

### Fixed

- **Dropdown menus.** The selected row now keeps one colour instead of flipping between light and
  dark as the cursor moves, and a row being pressed no longer looks selected. Applies to the
  Status/Priority/Category selects and the searchable selects (Assigned, Rows per page, filters).
- **Rows per page** shows the new size immediately instead of the old one until the list reloads.
- **Popovers** now fade in and out instead of appearing abruptly.

### Upgrade notes

- If a platform deployment sets the command to `pnpm start` to work around the missing worker,
  clear it. An explicit command overrides the entrypoint, so migrations and the worker stay off.

## [0.7.0] - 2026-10-19

### Added

- **Configurable attachment limits.** Admin → Ticket Config → Attachment Limits sets the files
  per message (default 5), size per file (default 10 MB) and **combined attachment size per
  ticket** (default 250 MB). The number of attachments per ticket is not limited; a message that
  would push a ticket over its storage limit is rejected whole, on every upload path, and the
  check is atomic under concurrent uploads. Existing attachments are never deleted when a limit
  is lowered or a merge pushes a ticket over it.

- **Merge several tickets at once.** The Merge dialog (ticket sidebar, and new in the ticket
  list's bulk bar for 2+ selected tickets) lets an agent tick any number of the customer's
  tickets and pick the primary one to keep. Everything merges in one all-or-nothing step,
  and the customer gets a single **Ticket Merged** email listing every merged ticket. New
  endpoint: `POST /api/tickets/merge`.
- **Agents can select tickets in the list to merge them.** Agents now get the row
  checkboxes, and their bulk bar shows only **Merge**; assign, status, priority, tag and
  delete stay admin-only.

## [0.6.0] - 2026-10-05

### Added

- **Merge tickets.** Agents can fold a duplicate ticket into another open ticket from the
  same customer (sidebar → Merge). The thread, attachments, tags, custom-field values and
  links move to the surviving ticket; the merged ticket is closed and hidden from lists,
  counts and reports. Its old portal link and API id keep working for reads and replies.
  The customer gets a **Ticket Merged** email (can be turned off).
- **Split a reply into a new ticket.** A customer's public reply can be moved out into a
  new ticket for the same customer, linked back to the original. The customer gets the
  usual "ticket created" email.
- **Link tickets** as *related to*, *duplicate of* or *blocks*, shown in the sidebar.
- **Ticket Actions settings** (Admin → Ticket Config): switch merge, split and linking
  on or off, each with its own notification switch, plus the merge customer email.
- **Reply drafts.** The agent reply composer autosaves per agent and ticket, restores on
  return, shows a "Draft" marker in the ticket list, and has a Discard button.
- **Web Push as an alternative to Pusher Beams** for OS-level agent notifications.
  **Admin → Integrations → Push Notifications** now has a provider dropdown, and it shows
  only the chosen provider's settings. Web Push uses the browser's built-in push service
  directly, so it needs no third-party account. A **Generate keys** button creates the
  VAPID key pair, and **Test connection** sends a real notification to the admin's own
  browser. Both providers cover every agent notification (new tickets and customer replies).
- New opt-in webhook events `ticket.merged` and `ticket.split`. Existing endpoints don't
  receive them unless subscribed.

### Changed

- `PATCH /api/v1/tickets/:id/status` on a merged ticket returns `409` (naming the ticket it
  was merged into) instead of acting on that ticket, so a stored id can never close or reopen
  a different conversation. Status changes on non-merged tickets are unchanged.

### Upgrade notes

- Run migrations (`pnpm db:migrate`, or automatic on container start). They only add
  things — no existing data is changed: the `ticket_reply_drafts`, `push_subscriptions` and
  `ticket_links` tables, `tickets.merged_into_ticket_id` / `merged_at`, new
  `integration_settings` columns, and the ticket-action switches on `platform_settings`.
- **Merge, split and linking are switched on after upgrading** (all switches default to
  on). Turn any of them off under **Admin → Ticket Config → Ticket Actions**.
- Existing Pusher Beams setups keep working unchanged, because the push provider defaults
  to `pusher`. No new environment variables are required.

## [0.5.0] - 2026-08-27

### Added

- The ticket list's **Waiting Time** column is now sortable (ascending/descending),
  same as the Updated column. Sorting uses the actual waiting-time duration
  (derived from `waitingSince`/`createdAt`/`closedAt`, the same source the
  waiting-time badge already reads), not the formatted "2h"/"1d 4h" display
  text. Works together with all existing filters, including Status, and with
  pagination and the detail page's Previous/Next navigation.

### Changed

- The Updated column's sort indicator now uses plain up/down arrow icons
  instead of the previous caret/sort-glyph style, for a clearer ascending/
  descending affordance. Sorting behavior is unchanged.

## [0.4.3] - 2026-08-26

### Fixed

- Agents and admins could delete a customer's own ticket attachments —
  the delete button was shown regardless of who uploaded the file, and
  `DELETE /api/tickets/[id]/attachments/[attachmentId]` never checked
  ownership either. Customer attachments are now immutable to staff: the
  delete affordance no longer renders on them, and the endpoint rejects
  the request server-side (`403`) even if called directly. Agent/admin
  attachments are unaffected — deletion still works as before for those.

## [0.4.2] - 2026-08-25

### Changed

- Continued hiding SLA (see 0.4.1): the SLA policy CRUD API
  (`/api/admin/sla-policies`), the "Show SLA & Overdue" preference API
  (`/api/tickets/sla-display`), and the default SLA policy seeded on setup are
  now disabled too — commented out, not removed, same as the rest of the SLA
  code. None of these had a UI path to them, so this closes the last
  directly-reachable SLA surface.
- The ticket list's Waiting Time column is no longer internally identified as
  `sla` — renamed to `waitingTime` (label "Waiting Time"), so the always-on
  Waiting Time feature isn't named after the disabled SLA feature it happens
  to share code with. Also fixes the "Columns" toggle dialog showing "SLA" as
  the option label even though the column itself always displayed "Waiting
  Time".

## [0.4.1] - 2026-08-22

### Changed

- SLA is hidden from the UI for now: the admin SLA policy manager, the
  per-agent "Show SLA & Overdue" setting, and the SLA metric/outcome badges no
  longer render anywhere. The underlying SLA code (`lib/sla.ts`,
  `lib/sla-policies.ts`, the policy manager, the display-preference card) is
  untouched, just commented out at each call site, and can be restored by
  uncommenting. The **Waiting Time** badge ("Open for…" / "Waiting for
  agent"/"Waiting for customer") is unaffected — it doesn't depend on an SLA
  policy.

### Fixed

- The reply composer's "Internal note" toggle no longer stays on after
  sending. Previously, if an agent left it on, their next reply — intended as
  a public, customer-facing reply — would silently stay internal, so the
  customer never saw it and the ticket's waiting state never flipped to
  "Waiting for customer".

## [0.4.0] - 2026-08-20

### Added

- Zammad migration: a **sync mode** (`pnpm migrate:zammad:sync`, or
  `MIGRATION_SYNC=1`). A plain re-run of `migrate:zammad` only ever imported
  tickets that didn't exist yet and skipped already-imported ones whole, so
  anything that changed in Zammad afterwards — a ticket being closed, new
  replies, priority/assignee/subject/tag edits, files added to a thread —
  never arrived. Sync mode re-reads those tickets and updates them in place,
  appending only the articles it hasn't copied before. It is additive: nothing
  in Docket is deleted, and work done by agents inside Docket survives.
  See `docs/deployment-and-zammad-migration.md` §7.4.
- A per-agent **"Show SLA & Overdue" preference** on the Settings page. Off,
  the ticket list's SLA column collapses to just the waiting-time badge
  instead of the full SLA/overdue badges. Stored in
  `user_ticket_table_prefs.show_sla_and_overdue`.
- **Queue tabs** ("Awaiting Our Reply" / "All Open Tickets" / "All Tickets")
  and a **quick date-range filter** ("Today" / "7d" / "30d" / "90d" / "All
  time") above the ticket list, both writing the same `view`/`range` query
  params the Filters popover already used.

### Changed

- Ticket detail URLs now use the ticket number instead of the internal id
  (`/tickets/{ticketNumber}` instead of `/tickets/{id}`) — the internal id is
  no longer exposed in the URL. Old links using the internal id no longer
  resolve.

## [0.3.1] - 2026-08-19

### Added

- A new personal **Settings** page (`/settings`, agents/admins only) for
  per-agent preferences, starting with a **"Send reply on Enter"** toggle for
  the ticket reply composer. On (the default, matching prior behavior) Enter
  sends the reply and Shift+Enter inserts a newline; off, Enter always
  inserts a newline and only the Send button submits. Stored per agent in
  `user_ticket_table_prefs.send_reply_on_enter`.

## [0.3.0] - 2026-08-18

### Changed

- Replaced Radix UI/shadcn with Headless UI + daisyUI across every
  `components/ui/*` primitive and their call sites. daisyUI component classes
  now carry appearance (`btn`, `badge`, `card`, `modal-box`, `menu`, `input`,
  `table`, …) while Headless UI supplies behavior only (focus trap, roving
  tabindex, typeahead, ARIA) for `Dialog`, `Menu`, and `Listbox`. `Popover`
  and `Tooltip` are built on `@floating-ui/react` instead. Radix UI and
  shadcn are fully removed from the project.

## [0.2.0] - 2026-08-07

### Added

- SMTP, Google OAuth, Pusher (Beams + Channels) and file storage (S3/R2) can
  now be configured at runtime from **Admin → Integrations**, not just
  `.env`. A value saved there overrides the matching env var; an install that
  only ever used `.env` sees no change in behavior.

### Changed

- Finished the rename to Docket: the Postgres database and Docker volumes
  (`support_tool` → `docket`, `support_tool_pgdata` → `docket_pgdata`,
  `support_tool_uploads` → `docket_uploads`) and the `X-Support-Tool-*`
  webhook header aliases are gone. `X-Docket-*` headers are unaffected.
- New brand mark: favicons, PWA icons and the in-app logo are regenerated
  from the new navy-and-off-white logo.

### Fixed

- The `ghcr.io/stack256org/docket` package was private, so every
  `docker pull` in the README failed with 403 for anyone not signed in to
  GHCR. The release workflow now verifies anonymous pullability and fails
  the run if a customer couldn't actually pull what was just published. The
  README's version/tag references are also now generated from
  `package.json` instead of hand-written, so they can't drift again.

#### Upgrade notes

- No manual steps. Existing `.env`-based SMTP/OAuth/Pusher/storage
  configuration keeps working unchanged; Integrations settings are optional.

## [0.1.0] - 2026-07-31

First public release.

Docket is self-hosted customer support software. Customers send a request without
creating an account and follow it through a private link sent by email. Your team
answers from a shared queue with private notes, reply targets, assignment and saved
replies. Everything lives in your own PostgreSQL database.

### What is in it

- **Customer side.** A form and an emailed private link. No account, no password. Rich
  text and attachments up to 10 MB, five per request. Customers can see their own
  history, reply, and close a request themselves.
- **Team side.** A queue with search, filtering, sorting and bulk actions. Private notes
  in the conversation that the customer never receives. Saved replies, assignment, and
  stages, priorities, categories and tags you name yourself.
- **Reply targets** per priority, whose clock pauses while you are waiting on the
  customer.
- **Admin.** User management and roles, editable stages and categories, email templates,
  API keys, an audit log, six colour presets with light and dark modes, and a first-run
  setup wizard.
- **Reports** covering per-agent volume and response times, with breakdowns by category,
  priority and tag, and a spreadsheet export.
- **Public REST API** at `/api/v1`, with hashed bearer keys, an OpenAPI 3.1 description,
  a Postman collection and a browsable reference. Enough to build both a "send a request"
  and a "my requests" page on your own site.
- **Outgoing webhooks** on ticket events, signed with HMAC-SHA256, retried with backoff,
  with delivery history and one-click redelivery.
- **Durable email** through a background worker, so a failing mail provider is retried
  rather than dropping the message.
- **Attachments** on local disk, S3 or Cloudflare R2, chosen with one setting.
- **Zammad importer** for requests, people, replies and attachments. Safe to re-run.

### Running it

- Prebuilt images for `linux/amd64` and `linux/arm64`, published to GitHub Packages as
  `ghcr.io/stack256org/docket`, rebuilt on every change and tagged on every release.
- Three Compose files: prebuilt image with PostgreSQL included, build-from-source, or
  bring your own database.
- `GET /api/health` reports database reachability and the running version, and is wired
  in as the container's own health check.
- The container runs as an unprivileged user.
- Data lives on two named Docker volumes that survive `down`, `pull`, `build` and
  `up -d`. Only `down -v` removes them.

### Known deprecations

- Every webhook delivery carries both the current `X-Docket-Event`, `-Delivery`,
  `-Timestamp` and `-Signature` headers **and** the older `X-Support-Tool-*` names with
  identical values. The old names date from before the product was renamed and are sent
  only so existing endpoints keep working. Read the `X-Docket-*` set. The aliases will be
  removed in a later release, which will be a breaking change.
- API keys issued before the rename start `stk_live_`; new ones start `dk_live_`. Old
  keys stay valid, because verification matches a hash of the whole secret and never the
  prefix.

### Known gaps

Replying by email, satisfaction ratings after a request is closed, a spreadsheet export
of the request list itself, one-click deploy buttons, and attachments and webhooks in the
public API. See the Roadmap in the README.

[Unreleased]: https://github.com/stack256org/docket/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/stack256org/docket/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/stack256org/docket/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/stack256org/docket/compare/v0.5.0...v0.6.0
[0.2.0]: https://github.com/stack256org/docket/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/stack256org/docket/releases/tag/v0.1.0
