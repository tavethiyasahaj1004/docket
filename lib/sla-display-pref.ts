// Pure resolution logic for the "Show SLA & Overdue" ticket-list preference,
// separated from lib/user-preferences.ts (which touches the DB) so it can be
// unit tested directly — same pattern as lib/reply-composer-keys.ts.

/** Resolves the saved showSlaAndOverdue row into the effective preference —
 * defaults to true (SLA/overdue badges shown, today's behavior) when the
 * agent has no saved row yet, so upgrades from versions predating this
 * preference keep their prior behavior. */
export function resolveShowSlaAndOverduePref(
  row: { showSlaAndOverdue: boolean } | undefined
): boolean {
  return row?.showSlaAndOverdue ?? true;
}
