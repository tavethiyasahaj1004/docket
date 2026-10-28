# Deployment & Zammad Migration Guide

This is a step-by-step runbook for standing up Docket on a server with
Docker, and pulling historical tickets/attachments over from an existing
Zammad instance. Follow it in order — migration must happen **after** the
app is deployed and running.

---

## 1. Prerequisites

- A server (VPS or similar) with **Docker** and **Docker Compose** installed.
- This repo cloned onto that server.
- Access to the Zammad instance you're migrating from:
  - Its base URL (e.g. `https://support.oldcompany.com`)
  - An **API token** for a Zammad admin account (Zammad → Profile → Token
    Access → create a token with read access to Users, Tickets, Groups)

No local Node/pnpm install is required for the Docker path — everything
builds and runs inside containers.

---

## 2. Choose your Postgres setup

- **Bundled PostgreSQL (default, easiest)** — `docker-compose.yml` runs
  PostgreSQL, app and worker together, with data in a Docker volume. It
  downloads a prebuilt image from GitHub Packages, so nothing compiles here.
- **Your own database** (Neon, Supabase, RDS and so on) —
  `docker-compose.external-db.yml` runs only app and worker; you supply
  `DATABASE_URL`. Also a prebuilt image.
- **Built from source** — `docker-compose.build.yml`, only if you changed the
  code or need the optional Pusher features.

Use ONE of these compose files, never two. Everything below shows the default
bundled setup; on either of the others, add `-f <that file>` to every
`docker compose` command.

---

## 3. Configure environment variables

```bash
cp .env.docker.example .env
```

Edit `.env` and set at minimum:

| Variable | Required | Notes |
|---|---|---|
| `APP_SECRET` | Yes | Random string, **32+ characters**. Generate with `openssl rand -hex 32`. |
| `NEXT_PUBLIC_APP_URL` | Yes | The public URL this instance will be reached at, e.g. `https://support.yourco.com`. No trailing slash. |
| `DATABASE_URL` | Only for Option B | Already pre-filled to match the bundled Postgres for Option A — leave as-is. |

Optional but recommended — and skippable here entirely: SMTP, Google OAuth,
and Pusher can all be set later from the app itself (the setup wizard's
Integrations step, or **Admin → Integrations**) instead of editing `.env`.
Env vars below remain supported as a fallback for anything not configured
that way:

| Variable | Purpose |
|---|---|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `EMAIL_FROM` | Without these, outgoing email (ticket notifications, magic links) is only logged, never actually sent. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Enables "Continue with Google" login for agents. Set via Integrations instead? An app restart (`docker compose restart app`) is needed before it takes effect — every other integration here applies live. |

Storage defaults to local disk (`./uploads`, mounted as a persistent Docker
volume already in `docker-compose.yml` — no action needed). If you'd rather
use S3 or Cloudflare R2, see `docs/file-uploads.md`.

---

## 4. Build and start the stack

```bash
docker compose up -d
```

This builds the app image, starts Postgres, runs the one-shot `migrate`
service (DB migrations + default statuses/categories), then starts the
`app` and `worker` containers.

Check everything is healthy:

```bash
docker compose ps
docker compose logs -f app worker
```

The app is now listening on `:3000` inside the container (`expose`, not
`ports` — put a reverse proxy in front, see step 6).

### 4.1 Platforms that aren't Docker Compose (Dokploy, Coolify, `docker run`)

If your platform deploys the published image once from a registry URL, leave
the **command blank**. With no command the image's entrypoint
(`scripts/docker-entrypoint.sh`) applies pending migrations (and seeds
defaults), then runs the web server **and exactly one worker** in that one
container. Every new version you select therefore migrates itself.

| Variable | Default | Meaning |
|---|---|---|
| `DOCKET_ROLE` | `all` | `all` = migrate + web + worker. Or `app`, `worker`, `migrate` to run a single role. |
| `DOCKET_RUN_MIGRATIONS` | `true` for `all`/`migrate`, else `false` | Set `false` if your managed database user may not run DDL. |

- **Mount a persistent volume at `/app/uploads`** (or set `STORAGE_DRIVER=s3|r2`).
  The image does not create one; without it attachments vanish on the next
  redeploy. The container logs `[entrypoint] WARNING: /app/uploads is not a
  mounted volume` at boot when it is missing.
- Run **one** container in role `all`. Don't scale it: two workers can
  double-process jobs.
- Setting an explicit command (e.g. `pnpm start`) **overrides the entrypoint**:
  no migrations, no worker. That is what the compose files do on purpose, one
  service per role.
- If either the web server or the worker dies, the container exits so the
  platform restarts it, rather than looking healthy with a dead worker.

| Symptom | Cause |
|---|---|
| Server Components render error right after a release, `column … does not exist` in logs | Migrations not applied: a command is set (e.g. `pnpm start`), or `DOCKET_RUN_MIGRATIONS=false`. Clear the command. |
| No email / magic-link never arrives | No worker is running: same cause. |
| Container logs `unknown DOCKET_ROLE` and exits 64 | Typo. Valid: `all`, `app`, `worker`, `migrate`. |
| Restart loop right after `pg-boss started` | In role `all` either process dying takes the container down by design. Read the logs above the restart. |

---

## 5. Create the first admin account

Deliberately a manual step (not automatic on startup) so you see
success/failure immediately instead of it failing silently in a background
container:

```bash
docker compose run --rm app pnpm create:admin you@example.com "Your Name" "a-strong-password"
```

Sign in at `https://<your-domain>/login`.

---

## 6. Put a reverse proxy in front (TLS)

The `app` container only `expose`s port 3000 (not published to the host).
Put Nginx or Caddy in front for TLS termination and proxy to `:3000`, then
point `NEXT_PUBLIC_APP_URL` in `.env` at the final public HTTPS URL.

If you change `NEXT_PUBLIC_APP_URL` after the first build, you must rebuild
(not just restart) for it to take effect:

```bash
docker compose build && docker compose up -d
```

Pusher's `NEXT_PUBLIC_PUSHER_*` values don't have this problem anymore if
set from Admin → Integrations — the browser fetches them at runtime, no
rebuild ever needed (see `docs/realtime-updates.md`). The rebuild
requirement only still applies if you set them via `.env` and build with
`docker-compose.build.yml`.

---

## 7. Migrate data from Zammad

Once the app is deployed and reachable, migrate historical tickets. Both
scripts are **read-only against Zammad** — they only issue `GET` requests
(verified: no POST/PUT/PATCH/DELETE anywhere in either script). Nothing in
Zammad is ever modified or deleted; the scripts only copy data out into
Docket's own database and file storage.

Both scripts are **idempotent** — safe to re-run, and nothing is ever
duplicated. Be clear on what a plain re-run does, though: it imports tickets
that weren't there last time and leaves already-imported ones untouched. To
also pull across what changed in Zammad since (replies, closes,
priority/assignee/tag edits), re-run in **sync mode** — see 7.4.

### 7.1 Dry run first

Always preview before writing anything:

```bash
docker compose exec \
  -e ZAMMAD_BASE_URL="https://your-zammad.example.com" \
  -e ZAMMAD_API_TOKEN="your-admin-api-token" \
  -e MIGRATION_DRY_RUN=1 \
  app pnpm migrate:zammad:users

docker compose exec \
  -e ZAMMAD_BASE_URL="https://your-zammad.example.com" \
  -e ZAMMAD_API_TOKEN="your-admin-api-token" \
  -e MIGRATION_DRY_RUN=1 \
  app pnpm migrate:zammad
```

Review the logged counts (tickets, comments, attachments, tags) before
proceeding.

### 7.2 Migrate agent/admin accounts (run FIRST)

```bash
docker compose exec \
  -e ZAMMAD_BASE_URL="https://your-zammad.example.com" \
  -e ZAMMAD_API_TOKEN="your-admin-api-token" \
  app pnpm migrate:zammad:users
```

Creates a Docket user (as a plain agent, regardless of their Zammad
role) for every Zammad Agent/Admin, matched by email. **Every created
account shares one temporary password**, the one you pass in
`MIGRATION_USER_PASSWORD`. It is required and has no default, because a
built-in fallback would mean every deployment that forgot to set it ends
up with accounts sharing a password anyone can look up. Generate one with
`openssl rand -base64 24`. This script does not email anyone or force a
reset, so **tell the team to change their password after first login**.
Promote specific people to admin afterward:

```bash
docker compose exec app pnpm make:admin someone@yourco.com
```

### 7.3 Migrate tickets, comments, attachments, tags

```bash
docker compose exec \
  -e ZAMMAD_BASE_URL="https://your-zammad.example.com" \
  -e ZAMMAD_API_TOKEN="your-admin-api-token" \
  app pnpm migrate:zammad
```

Preserves: subject, opening message, full conversation thread, attachments
(bytes copied), customer name/email, original timestamps, open/closed
status, priority, internal-note flags, awaiting-reply state, tags, and the
assignee (Zammad's ticket owner, matched to a Docket user by email —
which is why step 7.2 runs first).
Does **not** preserve Zammad's original ticket number (Docket assigns
its own; the original is recorded in a `zammad_migrated` activity row).

Useful optional flags (pass as `-e` before `app`, same as above):

| Env var | Purpose |
|---|---|
| `MIGRATION_ZAMMAD_SEARCH` | Restrict export to a Zammad search query, e.g. `tags:DTM`. Omit to migrate ALL tickets. |
| `MIGRATION_LIMIT` | Stop after seeing N tickets (oldest-first) — useful for a first test batch, e.g. `100`. |
| `MIGRATION_DEFAULT_CATEGORY` | Category slug assigned to imported tickets (default `issue`). |
| `MIGRATION_SYNC` | `1` (or the `--sync` flag) — also update already-imported tickets instead of skipping them. See 7.4. |
| `MIGRATION_SYNC_FORCE` | `1` (or `--sync-force`) — sync mode, but re-read every ticket rather than trusting Zammad's `updated_at` to say which ones changed. |

**Attachments — important caveat:** unlike the app's normal upload path
(which restricts uploads to JPG/PNG/PDF/ZIP/TXT, 10 MB max, 5 files per
ticket), this migration copies through **every attachment type and size
exactly as it was in Zammad** — images, zips, Word docs, anything — with no
filtering or per-ticket cap. That's intentional (preserve full history),
but be aware disk usage may be larger than the app's normal rules would
otherwise allow.

If it crashes partway through, just re-run the same command — a checkpoint
file (`uploads/.zammad-migration-state.json`) and a DB marker on each
migrated ticket make it resume without duplicating anything. If some
tickets fail, only those are retried on the next run (see the summary
printed at the end for a failed count and pointer to the checkpoint file).

### 7.4 Keeping Docket up to date afterwards (sync mode)

The command in 7.3 is **import-only**: it adds tickets that aren't in Docket
yet and leaves every ticket it already imported exactly as it was. So a second
run days later brings across the *new* tickets, but nothing that happened to
the older ones in the meantime — a ticket closed in Zammad still shows as open
here, replies added to an existing thread never appear, and priority, subject,
assignee and tag edits are all missed.

To pull those across, run the migration in **sync mode**:

```bash
docker compose exec \
  -e ZAMMAD_BASE_URL="https://your-zammad.example.com" \
  -e ZAMMAD_API_TOKEN="your-admin-api-token" \
  app pnpm migrate:zammad:sync
```

(That is just `migrate:zammad --sync`; `-e MIGRATION_SYNC=1` does the same if
you'd rather pass an env var. `MIGRATION_DRY_RUN=1` works here too, and prints
exactly which tickets would change and how — do that first.)

What a sync brings across on an already-imported ticket:

| Synced | Notes |
|---|---|
| New replies and internal notes | Appended in place. Replies already imported are never duplicated or rewritten. |
| Attachments | For new replies, plus any file added to a thread that was already imported. |
| Status (open/closed) and closed date | From Zammad's ticket state, via the same mapping the first import uses. |
| Priority, subject | |
| Assignee | Taken from Zammad's ticket owner whenever that person has a Docket account (so run `migrate:zammad:users` first if new agents joined). |
| Tags | Add-only — see below. |
| Awaiting-reply flag and unread count | Recomputed from the whole thread. |

What it deliberately does **not** do:

- **Nothing is ever deleted.** A reply removed in Zammad stays in Docket, and
  so does a tag removed in Zammad — agents can also tag a ticket from inside
  Docket and there's no way to tell the two apart. Tickets deleted in Zammad
  are left alone as well.
- **An assignee set inside Docket survives.** Docket only clears an assignee
  when Zammad has no owner *and* the current assignee is still the exact
  person Zammad's owner field last named.
- **Ticket numbers stay Docket's own**, as with the first import.

One thing to know before syncing tickets your agents are already working on
in Docket: **a sync mirrors Zammad, so Zammad wins on every field it owns.**
Status in particular maps onto open/closed only — the same two the first
import uses — so a migrated ticket someone moved to another status in Docket
is pulled back to whatever Zammad says. The awaiting-reply flag is likewise
recomputed from the Zammad thread, which doesn't know about replies your
agents wrote in Docket. Sync while Zammad is still the system of record, and
stop once the team has moved over.

Speed: the ticket listing already tells the script Zammad's `updated_at` for
every ticket, so a ticket untouched since the last sync is skipped without
fetching anything else, and a repeat sync over a large instance is cheap. Two
caveats:

- The **first** sync after upgrading to this version has no recorded
  `updated_at` for tickets imported before it, so it re-reads all of them once.
  Slower than later runs — and it's the run that backfills everything missed
  so far.
- Tag changes in Zammad don't reliably bump the ticket's own `updated_at`. If
  you specifically need tag edits picked up, add `-e MIGRATION_SYNC_FORCE=1`
  (or `--sync-force`), which re-reads every ticket instead of trusting
  `updated_at`.

Sync mode is safe to run repeatedly, on a schedule if you like. Like the
import, it writes straight to the database — it never emails anyone, fires a
webhook, or raises an in-app notification for the history it copies.

### 7.5 Order matters, but there's a safety net

Run `migrate:zammad:users` **before** `migrate:zammad` — replies and the
ticket assignee then link directly to the right agent account as they're
written. If you ran them out of order (or migrated tickets before any users
existed), just re-run `migrate:zammad:users` afterward — it always re-sweeps
already-migrated data and links what's still unlinked:

- **comments/attachments** → by matching the author's display name;
- **the assignee** of every migrated ticket that is still unassigned → from
  the Zammad owner recorded on its `zammad_migrated` activity row, or by
  re-reading the ticket from Zammad for imports that predate that field
  (so `ZAMMAD_BASE_URL` / `ZAMMAD_API_TOKEN` still need to be valid).

**Migrated tickets showing as "Unassigned" in the tickets list?** That's this
case — the agents didn't have accounts yet when the tickets were imported.
Re-run `migrate:zammad:users` and the owners are filled in (dry-run it first
to preview the counts). Owners it can't link are listed at the end of the
run — usually people who no longer hold an agent/admin role in Zammad; add
them under Admin → Users and run it once more.

---

## 8. Post-migration checklist

- [ ] Spot-check a handful of migrated tickets in the UI — conversation
      order, internal notes still marked internal, attachments open
      correctly.
- [ ] Confirm migrated agent accounts can log in and have been told to
      change their shared default password.
- [ ] Promote the right people to admin with `pnpm make:admin`.
- [ ] Confirm SMTP is configured if you want live email notifications
      going forward (not just logged).
