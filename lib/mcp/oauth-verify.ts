// Verifies an OAuth access token presented to /api/mcp (Release 4). The token
// is a JWT signed with our own key, so it is checked locally against the
// in-process key set (never an HTTP fetch to our own public URL, which may be
// unreachable from inside a container). A valid signature is necessary but not
// sufficient: the token only stays good while the user's grant, the client and
// the account behind it are all still in good standing in the database, which
// is what makes revocation, bans and demotions take effect before expiry.
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { and, eq } from "drizzle-orm";
import { oauthClient, oauthConsent, user } from "@/db/schema";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { splitScopes } from "@/lib/mcp/oauth-policy";
import {
  effectiveMcpScopes,
  isEligibleMcpRole,
  type McpScope,
} from "@/lib/mcp-tokens";
import { MCP_OAUTH_RESOURCE, OAUTH_SCOPES } from "@/lib/oauth";

/** A grant created after the token was minted cannot have authorized it. The
 * consent row and the token's `iat` are both whole seconds written by the same
 * server, so this only absorbs a little clock drift between instances. */
const GRANT_CLOCK_SKEW_SECONDS = 2;

export type OAuthVerifyResult =
  | {
      ok: true;
      user: { id: string; name: string; email: string; role: string };
      scopes: McpScope[];
      clientId: string;
      clientName: string;
      consentId: string;
      expiresAt: Date;
    }
  | {
      ok: false;
      reason: "invalid" | "expired" | "revoked" | "not_permitted";
    };

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export async function verifyOAuthAccessToken(
  raw: string
): Promise<OAuthVerifyResult> {
  let payload: Awaited<ReturnType<typeof verifyJwsAccessToken>>;
  try {
    const { baseURL } = await auth.$context;
    payload = await verifyJwsAccessToken(raw, {
      // Read per call: no cache to go stale across a key rotation.
      jwksFetch: async () => await auth.api.getJwks(),
      verifyOptions: {
        issuer: baseURL,
        audience: MCP_OAUTH_RESOURCE,
        algorithms: ["EdDSA"],
        requiredClaims: ["sub", "azp", "exp", "iat"],
      },
    });
  } catch (error) {
    return {
      ok: false,
      reason: errorCode(error) === "ERR_JWT_EXPIRED" ? "expired" : "invalid",
    };
  }

  // We only accept plain Bearer tokens; one bound to a DPoP key must not be
  // honoured without that proof.
  if (payload.cnf !== undefined) {
    return { ok: false, reason: "invalid" };
  }
  // Issued for this endpoint and nothing else: the audience is exactly the
  // resource, not a list that merely contains it.
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (audience.length !== 1 || audience[0] !== MCP_OAUTH_RESOURCE) {
    return { ok: false, reason: "invalid" };
  }
  const { sub, azp, iat, exp } = payload;
  if (
    typeof sub !== "string" ||
    typeof azp !== "string" ||
    typeof iat !== "number" ||
    typeof exp !== "number" ||
    typeof payload.scope !== "string"
  ) {
    return { ok: false, reason: "invalid" };
  }

  const [owner] = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      banned: user.banned,
    })
    .from(user)
    .where(eq(user.id, sub))
    .limit(1);
  if (!owner || owner.banned === true || !isEligibleMcpRole(owner.role)) {
    return { ok: false, reason: "not_permitted" };
  }

  const [grant] = await db
    .select({
      consentId: oauthConsent.id,
      consentScopes: oauthConsent.scopes,
      grantedAt: oauthConsent.createdAt,
      clientName: oauthClient.name,
      clientDisabled: oauthClient.disabled,
    })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(and(eq(oauthConsent.userId, sub), eq(oauthConsent.clientId, azp)))
    .limit(1);
  if (
    !grant ||
    grant.clientDisabled === true ||
    grant.grantedAt.getTime() > (iat + GRANT_CLOCK_SKEW_SECONDS) * 1000
  ) {
    return { ok: false, reason: "revoked" };
  }

  // What the token says, narrowed by what the user currently allows, the
  // owner's CURRENT role ceiling, and what OAuth can issue at all.
  const consented = new Set(grant.consentScopes);
  const tokenScopes = splitScopes(payload.scope).filter((s) =>
    consented.has(s)
  );
  const scopes = effectiveMcpScopes(tokenScopes, owner.role).filter((scope) =>
    OAUTH_SCOPES.includes(scope)
  );

  return {
    ok: true,
    user: {
      id: owner.id,
      name: owner.name,
      email: owner.email,
      role: owner.role,
    },
    scopes,
    clientId: azp,
    clientName: grant.clientName ?? azp,
    consentId: grant.consentId,
    expiresAt: new Date(exp * 1000),
  };
}
