# Release 4 (OAuth) integration notes

Branch `mcp/phase-8-oauth` was cut from `d6a17ee`. Phase 6 landed on main as
`843b483` ("Phase 6 MCP ticket action tools") and also owns migration number
0019. These notes say how to bring Release 4 onto it. Nothing here has been
done in this branch: no rebase, merge or commit was made.

> **Status (2026-10-29):** carried out on `mcp/integration-phases-1-8` (from
> `mcp/phases-1-5` + `843b483` + Phase 7 `5a78641` + the uncommitted Release 4
> work), without a rebase: the OAuth migration was regenerated as
> `0020_curvy_human_torch` (same DDL, trigger SQL re-appended), and
> `lib/mcp/tools/approvals.ts` passes `oauthConsentId` for OAuth callers
> (`tests/integration/oauth-approval-tools.test.ts`). Scratch databases that ran
> the old `0019_white_triton` can't be migrated forward; use a fresh one.

## 1. Rebase

```
git rebase 843b483        # from mcp/phase-8-oauth, once the work is committed
```

## 2. Migrations (do this BEFORE resolving anything else)

This branch generated `0019_white_triton` (OAuth tables, `oauth_consent_id`,
CHECK, consent-delete trigger, extended R6 function). Phase 6 shipped
`0019_large_mandarin` (adds `platform_settings.mcp_customer_replies_enabled`,
one statement, no overlap with the OAuth tables or `mcp_pending_actions`).
Phase 6 keeps number 0019. Release 4 becomes 0020.

1. Take Phase 6's journal and snapshot as they are:
   `git checkout 843b483 -- db/migrations/meta/_journal.json`.
2. Delete this branch's `db/migrations/0019_white_triton.sql` and
   `db/migrations/meta/0019_snapshot.json`. Phase 6's `0019_snapshot.json`
   stays as it is on main.
   Keep a copy of the hand-written SQL appended to the end of
   `0019_white_triton.sql` first (everything after the last drizzle-generated
   statement: `mcp_cancel_pending_actions_on_consent_delete()`, the BEFORE
   DELETE trigger `mcp_pending_actions_cancel_on_consent_delete` on
   `oauth_consent`, and the `CREATE OR REPLACE FUNCTION
   mcp_revoke_tokens_for_ineligible_user()` that adds the three OAuth deletes
   to the 0017 body).
3. Resolve `db/schema/mcp.ts` (see section 3), then run `pnpm drizzle-kit
   generate`. It produces `0020_<name>.sql` plus `0020_snapshot.json` and a
   journal entry, diffed against Phase 6's 0019 snapshot.
4. Append the saved hand-written SQL to the generated 0020 file (statement
   breakpoints between statements, as in 0017/0018).
5. Update `OAUTH_MIGRATION_TAG` in `tests/integration/oauth-migration.test.ts`
   to the new tag, and the expected `drizzle.__drizzle_migrations` row count
   (21 after the move; it is 20 on this branch). The test migrates a scratch
   database to everything before the OAuth migration, seeds PAT and
   pending-action rows, then applies the rest.

## 3. Expected conflicts and what to do

| File | Phase 6 change | Release 4 change | Resolution |
| --- | --- | --- | --- |
| `lib/mcp/pending-actions-core.ts` | adds `or`, `platformSettings`, `replies_disabled`, `replyGateOpenSql`, `cancelPendingRepliesForGateOff` | adds `oauthConsent`, `oauthConsentId` in the cancelled columns and audit metadata, and an `or(PAT branch, consent branch)` in `actionablePendingSql` | Keep both. The reply-gate predicate ANDs onto the combined PAT-or-consent predicate; do not let it replace either branch. Do not import `or` twice. |
| `lib/mcp/pending-actions.ts` | reply gate, rate limits, duplicate-reply refusal, new kinds | `createPendingAction` takes exactly one of `credentialId` / `oauthConsentId`, locks the consent row FOR SHARE, extends `classifyRefusal` and the viewer's credential-name coalesce | Keep Phase 6 logic; re-apply the consent branch to every new creation path and to the new kinds. |
| `db/schema/mcp.ts` | edit near the pending-actions table | `oauthConsentId` column, index, `mcp_pending_actions_one_credential_chk` | Keep both. |
| `lib/mcp/tools/approvals.ts`, `lib/mcp/write-call.ts`, `lib/mcp/reconcile.ts` | new Phase 6 files/paths that pass `principal.credentialId` | not touched here | Must be adapted: for `principal.authMethod === "oauth"` pass `oauthConsentId: principal.consentId` (and no `credentialId`); for PATs keep `credentialId`. `get_action_status` and reconcile must match on either owner column. Anything that joins `mcp_access_tokens` by `credential_id` has to tolerate NULL. |
| `lib/mcp-tokens.ts` | `MCP_ISSUABLE_SCOPES` now also has `tickets:manage` and `tickets:reply` | not touched | No conflict. OAuth scopes are an explicit list (`OAUTH_MCP_SCOPES` in `lib/oauth.ts`), so these two do NOT become grantable over OAuth. Granting them over OAuth is a separate decision: add them to `OAUTH_MCP_SCOPES`, `OAUTH_CHOOSABLE_SCOPES` and `OAUTH_SCOPE_LABELS`, then update the scope assertions in `tests/oauth-config.test.ts`, `oauth-flow`, `oauth-tokens` and `mcp-discovery`. |
| `lib/mcp/auth.ts`, `lib/mcp/authorize.ts` | `authorize.ts` gains scope/tool gating for the new tools | `auth.ts`: OAuth bearer path, `McpPrincipal.authMethod/clientId/consentId` | Different files mostly; check `authorize.ts` still receives the principal's effective scopes for OAuth. |
| `lib/mcp/tools/meta.ts` | `whoami` / instructions text | `authMethod` enum now `pat` or `oauth` | Keep both. |
| `components/common/mcp-token-parts.tsx` | small addition (scope labels) | `McpRevokeDialog` `token` prop relaxed to `Pick<McpTokenItem, "name">` | Keep both. |
| `lib/auth.ts` | none | OAuth plugins, hooks | No conflict expected unless main changed it meanwhile. |
| `package.json`, `pnpm-lock.yaml` | none | `@better-auth/mcp`, `@better-auth/cimd`, better-auth bump | On conflict regenerate the lockfile with `pnpm install` rather than merging by hand. |
| `lib/settings.ts`, `db/schema/settings.ts` | add `mcp_customer_replies_enabled` | not touched | No conflict. |
| `tests/integration/mcp-*.test.ts` | Phase 6 edits `mcp-account-api`, `mcp-admin-api`, `mcp-close-reconcile-reopen`, `mcp-reconcile`, `mcp-sweeper`, `mcp-tokens` | `mcp-discovery.test.ts` rewritten | Only `mcp-discovery` is mine; the rest should merge cleanly. |
| docs | Phase 6 edits `docs/mcp.md`, `admin-portal.md`, `database-schema.md` | none yet (coordinator updates `mcp.md`, CHANGELOG, `authentication.md`) | Write the OAuth docs after the rebase. |

## 4. Re-run checklist after the rebase

1. `pnpm install --frozen-lockfile` (or regenerate the lockfile once), then
   `pnpm drizzle-kit generate` must report no further changes.
2. `pnpm typecheck` and `pnpm lint`.
3. `pnpm test` (unit): includes `tests/oauth-config.test.ts`.
4. Integration (`CI=true`, a disposable database, never `docket_test`):
   `oauth-migration` (migrates a DB at the previous migration with live
   PAT and pending-action rows), `oauth-flow`, `oauth-tokens`,
   `oauth-revocation`, `oauth-pending-actions`, `oauth-unavailable`,
   `mcp-discovery`, then the whole MCP suite including Phase 6's
   `mcp-approval-tools`, `mcp-manage-tools`, `mcp-reply-gate`,
   `mcp-write-tools`.
5. Add (new, because Phase 6 tools did not exist when the OAuth tests were
   written) a test that an OAuth principal can call `close_ticket` and
   `reply_to_customer` (once reply scope is grantable over OAuth, or via a
   directly seeded consent) and gets a pending action with
   `oauth_consent_id` set, `credential_id` NULL; that revoking the grant
   cancels it with `status_reason = token_revoked`; and that the reply gate
   going off cancels it as well.
6. `pnpm build` and one `next start` smoke run on a loopback URL (OAuth on) and
   on a non-loopback http URL (OAuth off, PATs working). Neither was run in
   this branch.
7. `pnpm docs:check`.
