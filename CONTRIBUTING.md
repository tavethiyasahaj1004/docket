# Contributing to Docket

Thanks for your interest in contributing! This is an open-source, self-hostable
customer support ticketing system built with Next.js, Drizzle ORM, and Postgres.

## Getting started

**Prerequisites:** Node.js 22+, pnpm 11+, and either Docker or a local Postgres.

```bash
git clone <your-fork-url>
cd docket
pnpm install
cp .env.example .env          # fill in APP_SECRET (32+ chars) and NEXT_PUBLIC_APP_URL
```

You can run Postgres locally without Docker using the embedded dev database:

```bash
pnpm db:local                 # starts an embedded Postgres on port 5432
pnpm setup                    # apply migrations and seed default statuses & categories
pnpm dev                      # runs Next.js + the background worker together
```

Open http://localhost:3000 — with no admin account yet, this lands you on the setup
wizard automatically to create your login. Prefer the command line?

```bash
pnpm create:admin you@example.com "Your Name" "a-strong-password"
```

## Project layout

```
app/            Next.js App Router
  (customer)/   public customer portal (submit / track tickets)
  (agent)/      agent portal (ticket queue, detail, dashboard)
  (admin)/      admin portal (users, appearance, ticket config)
  api/          REST API route handlers
components/     UI (daisyUI + Headless UI primitives in components/ui)
db/             Drizzle schema + migrations
lib/            db client, auth, email, storage, worker
scripts/        setup, seed, admin, worker entrypoints
docs/           product specs — read the relevant doc before changing a feature
```

## Conventions

- **TypeScript everywhere.** Run `pnpm typecheck` before pushing — it must pass.
- **Lint/format with Biome:** `pnpm lint` (check) / `pnpm lint:fix` (autofix).
- **Tests:** `pnpm test` (Vitest, in `tests/`). The suite deliberately covers the
  security-sensitive pure functions only: signed customer tokens, API key hashing,
  webhook signatures and secret encryption, client IP extraction, and rich-text
  flattening. Adding a test there should never require a database.
- **UI:** use the `components/ui/*` primitives; cards/dialogs use `rounded-xl`, buttons/inputs `rounded-md`.
- **Colors are theme tokens** (`bark`, `sand`, `stone`, `cream`, `bg-public`) — don't hardcode hex so the admin theme + dark mode keep working.
- **Statuses & categories are dynamic** — never hardcode status slugs like `"closed"`;
  use the `isClosedState` / `isDefault` flags (see `lib/ticket-config.ts`).
- **Database:** add a schema file under `db/schema/`, then `pnpm db:generate` and
  `pnpm db:migrate`. All IDs are generated app-side; tables carry `createdAt`/`updatedAt`.
  **Commit the generated migration** — CI fails if `db/schema/` changed without one.
- **API:** check auth first, return `{ error: string }` with the right status, never leak internal errors.
- **New env var:** add it to `lib/env.ts` **and** both `.env.example` and
  `.env.docker.example`. The two templates differ only in `DATABASE_URL` (`localhost` vs
  the `postgres` service hostname) — keep everything else in sync.

## Making a change

1. Create a branch off `main`.
2. Make your change; keep it focused. Add/adjust the relevant doc in `docs/` if behavior changes.
3. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`. CI runs all
   four plus a migrations check against a real Postgres — see
   [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
4. Open a pull request describing **what** changed and **why**. Screenshots help for UI.

## Reporting bugs / requesting features

Open an issue with clear steps to reproduce (for bugs) or the problem you're trying
to solve (for features). Please check existing issues first.

**Security vulnerabilities don't go in issues** — see [SECURITY.md](SECURITY.md).

Everyone participating here is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

By contributing, you agree your contributions are licensed under the same license as this project.
