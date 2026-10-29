// Who may hand an assistant access to their Docket account over OAuth, and with
// which scopes. Enforced server-side by lib/auth.ts (the consent hook and the
// authorization-code choke point); the consent screen only mirrors it.
import { eq } from "drizzle-orm";
import { user } from "@/db/schema";
import { db } from "@/lib/db";
import { allowedMcpScopesForRole, isEligibleMcpRole } from "@/lib/mcp-tokens";
import { OAUTH_OFFLINE_SCOPE, OAUTH_SCOPES } from "@/lib/oauth";

export type OAuthUserAssessment =
  | { ok: true; role: string }
  | { ok: false; reason: "impersonated" | "not_permitted" };

/** Reads the user from the database (never from a cached session) and applies
 * the same eligibility rule as a personal access token: exactly role agent or
 * admin, not banned. A session an admin opened to act as someone else
 * (`impersonatedBy`) may never grant OAuth access, for the same reason it may
 * not create a token: the grant outlives the session. */
export async function assessOAuthUser(
  userId: string,
  impersonatedBy: string | null | undefined
): Promise<OAuthUserAssessment> {
  if (typeof impersonatedBy === "string" && impersonatedBy !== "") {
    return { ok: false, reason: "impersonated" };
  }
  const [row] = await db
    .select({ role: user.role, banned: user.banned })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!row || row.banned === true || !isEligibleMcpRole(row.role)) {
    return { ok: false, reason: "not_permitted" };
  }
  return { ok: true, role: row.role };
}

/** The scopes this role may grant over OAuth: its token ceiling, restricted to
 * what OAuth can issue, plus offline_access. */
export function oauthGrantableScopes(
  role: string | null | undefined
): string[] {
  const ceiling = new Set<string>(allowedMcpScopesForRole(role));
  return OAUTH_SCOPES.filter(
    (scope) => scope === OAUTH_OFFLINE_SCOPE || ceiling.has(scope)
  );
}

/** Scopes in `requested` this role may not grant (empty = all fine). Unknown
 * scopes count as not grantable. */
export function ungrantableOAuthScopes(
  role: string | null | undefined,
  requested: readonly string[]
): string[] {
  const grantable = new Set(oauthGrantableScopes(role));
  return requested.filter((scope) => !grantable.has(scope));
}

export function splitScopes(value: string | null | undefined): string[] {
  return (value ?? "").split(" ").filter((s) => s.length > 0);
}
