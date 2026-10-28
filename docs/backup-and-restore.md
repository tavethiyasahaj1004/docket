# Backup & Restore

Docket stores everything in two places: **PostgreSQL** (tickets, users,
comments, config) and **file storage** (attachments — local disk by default,
or S3/R2 if configured). Neither is backed up automatically. This doc covers
both, for the bundled-Postgres Docker setup, the external-DB Docker setup, and
a manual VPS install.

---

## What you need to back up

| Data | Where it lives | Back up? |
|---|---|---|
| Database (tickets, users, comments, config) | Postgres | **Always** |
| File attachments (`local` driver) | `docket_uploads` Docker volume, or `./uploads` on a manual VPS install | **Yes**, unless using S3/R2 |
| File attachments (`s3`/`r2` driver) | Your S3/R2 bucket | Covered by the provider's own durability — see [Cloud storage](#cloud-storage-s3--r2) below |

Check `STORAGE_DRIVER` in your `.env` to know which case you're in — see
[docs/file-uploads.md](file-uploads.md).

---

## 1. Database backups

### Bundled Postgres (Docker, `docker-compose.yml`)

```bash
docker compose exec -T postgres pg_dump -U postgres -d docket -Fc > docket-$(date +%F).dump
```

`-Fc` (custom format) is compressed and restorable with `pg_restore`,
including selective table restores. A plain SQL dump also works if you
prefer something human-readable:

```bash
docker compose exec -T postgres pg_dump -U postgres -d docket > docket-$(date +%F).sql
```

### External Postgres (Neon, Supabase, RDS, etc.)

Prefer your provider's built-in backups / point-in-time recovery (PITR) —
they're managed, incremental, and usually enabled by default or a one-click
setting. `pg_dump` against your `DATABASE_URL` also works as a portable
supplement:

```bash
pg_dump "$DATABASE_URL" -Fc > docket-$(date +%F).dump
```

### Manual VPS install (no Docker)

Same as above, run directly against whatever `DATABASE_URL` you configured:

```bash
pg_dump "$DATABASE_URL" -Fc > docket-$(date +%F).dump
```

### Automating it

A daily cron job on the host, keeping the last 14 days locally and pruning
older ones:

```bash
# /etc/cron.d/docket-backup  (adjust path to your compose project dir)
0 3 * * * root cd /opt/docket && \
  docker compose exec -T postgres pg_dump -U postgres -d docket -Fc \
    > /opt/backups/docket-$(date +\%F).dump && \
  find /opt/backups -name 'docket-*.dump' -mtime +14 -delete
```

Copy `/opt/backups` off the host regularly (S3, rsync to another machine,
etc.) — a backup that lives only on the server you're protecting against
doesn't survive that server's disk failing.

---

## 2. File attachment backups

### Local disk (`STORAGE_DRIVER=local`, the default)

**Docker** — back up the named volume without stopping the app (tar reads a
live volume fine for this purpose):

```bash
docker run --rm \
  -v docket_uploads:/data:ro \
  -v "$(pwd)":/backup \
  alpine tar czf /backup/uploads-$(date +%F).tar.gz -C /data .
```

**Manual VPS install** — the `./uploads` directory is a regular folder;
back it up with any file-level tool (`tar`, `rsync`, your existing server
backup process):

```bash
tar czf uploads-$(date +%F).tar.gz -C /path/to/docket/uploads .
```

### Cloud storage (S3 / R2)

Docket doesn't need to back these up itself — object storage is
already durable and replicated by the provider. If you want extra protection
(e.g. against accidental deletion from the app), enable **bucket versioning**
on the S3/R2 bucket directly; no Docket-side action needed either way.

---

## 3. Restoring

Always restore the database and the uploads backup **from the same point in
time** — a newer DB with older attachments (or vice versa) can leave ticket
records pointing at attachment files that no longer exist, or files with no
matching DB row.

### Database restore (Docker, bundled Postgres)

Stop the app and worker first so nothing writes during the restore; leave
Postgres running:

```bash
docker compose stop app worker

# Custom-format dump:
docker compose exec -T postgres pg_restore -U postgres -d docket --clean --if-exists < docket-2026-07-20.dump

# Plain SQL dump:
docker compose exec -T postgres psql -U postgres -d docket < docket-2026-07-20.sql

docker compose start app worker
```

`--clean --if-exists` drops existing objects before recreating them, so the
restore fully replaces current data rather than merging with it.

### Database restore (external Postgres / manual VPS)

```bash
pg_restore -d "$DATABASE_URL" --clean --if-exists docket-2026-07-20.dump
```

### Uploads restore (Docker)

```bash
docker compose stop app worker

docker run --rm \
  -v docket_uploads:/data \
  -v "$(pwd)":/backup \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/uploads-2026-07-20.tar.gz -C /data"

docker compose start app worker
```

### Uploads restore (manual VPS)

```bash
rm -rf /path/to/docket/uploads/*
tar xzf uploads-2026-07-20.tar.gz -C /path/to/docket/uploads
```

---

## 4. Disaster recovery (fresh host)

1. Clone the repo and set up `.env` as in the normal [deployment
   guide](deployment-and-zammad-migration.md), pointing `DATABASE_URL` at a
   fresh Postgres.
2. Start only Postgres (`docker compose up -d postgres`) — don't run
   `migrate`/`app`/`worker` yet.
3. Restore the database dump into it (see above).
4. Restore the uploads volume (see above) — create it first with
   `docker volume create docket_uploads` if starting from nothing.
5. Start the rest of the stack: `docker compose up -d`. Skip `pnpm setup`'s
   seeding behavior for statuses/categories since real data is already
   restored — it's idempotent and won't duplicate anything if it runs anyway.
6. Spot-check: log in, open a ticket with an attachment, confirm the file
   loads.

---

## Recommendations

- **Test restores periodically**, not just backups — an untested backup is
  a hope, not a plan.
- **Keep copies off the host** — local-only backups don't survive the disk
  or VM they're protecting against failing.
- **Back up DB and uploads together** — see the point-in-time note above.
- If you're on `s3`/`r2` storage, your main ongoing responsibility is just
  the database — attachments are already durable in the bucket.
