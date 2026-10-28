<!--
Thanks for contributing. Please open an issue first for anything large, so we can
agree on the approach before you spend time on it.
-->

## What does this change?

<!-- One or two sentences. -->

## Why?

<!-- Link the issue this closes: "Closes #123". If there's no issue, explain the problem. -->

## How was it tested?

<!-- What did you actually run? "pnpm dev, created a ticket as a customer, replied as an
     agent, confirmed the email in the worker log." Be concrete. -->

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` passes
- [ ] Schema changed? Ran `pnpm db:generate` and committed the migration in `db/migrations/`
- [ ] New env var? Added to **both** `.env.example` and `.env.docker.example`, and to `lib/env.ts`
- [ ] UI change? Used the `components/ui/*` primitives, Phosphor icons, and semantic colour tokens (`bg-card`, `text-foreground`, …) rather than hardcoded hex or raw brand utilities — see [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] Dark mode still looks right (agent/admin portals)
- [ ] Docs in `docs/` updated if behaviour changed

## Screenshots

<!-- For any user-visible change. Light and dark mode if it's in the agent/admin portal. -->

## Breaking changes

<!-- Anything a self-hoster must do by hand when upgrading (new required env var, a
     manual data migration, a changed default). Write "None" if there are none. -->
