import type { NextRequest } from "next/server";
import { mcpJson, secondsUntilWindowEnds } from "@/lib/mcp/http";
import { MCP_RATE_LIMITS } from "@/lib/mcp/limits";
import { verifyOAuthAccessToken } from "@/lib/mcp/oauth-verify";
import {
  MCP_TOKEN_DISPLAY_PREFIX_LENGTH,
  MCP_TOKEN_PREFIX,
  type McpScope,
  verifyMcpToken,
} from "@/lib/mcp-tokens";
import {
  isOAuthAvailable,
  OAUTH_CHALLENGE_SCOPE,
  protectedResourceMetadataUrl,
} from "@/lib/oauth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export type McpPrincipal = {
  userId: string;
  name: string;
  email: string;
  role: string;
  /** Effective scopes: the token's grant intersected with the owner's current role. */
  scopes: McpScope[];
  authMethod: "pat" | "oauth";
  /** The PAT row id; for OAuth, the OAuth client id (a stable, non-secret id
   * that is not a token — the grant itself is `consentId`). */
  credentialId: string;
  /** The token name (PAT) or the OAuth client's display name. */
  credentialName: string;
  /** PAT expiry, or the access token's own expiry for OAuth. */
  credentialExpiresAt: Date;
  /** OAuth only: the client the user granted access to. */
  clientId?: string;
  /** OAuth only: the user's grant (oauth_consent row) this call rides on. Keeps
   * pending approval requests tied to the grant, as a PAT id does for a PAT. */
  consentId?: string;
};

const REASON_TEXT = {
  invalid: "invalid token",
  expired: "token expired",
  revoked: "token revoked",
  not_permitted: "account not permitted",
} as const;

/** The 401 challenge. Exactly the pre-OAuth header unless OAuth is available, in
 * which case it also points clients at the protected-resource metadata. */
function challenge(errorDescription?: string): string {
  let value = 'Bearer realm="docket"';
  if (isOAuthAvailable()) {
    value += `, resource_metadata="${protectedResourceMetadataUrl()}", scope="${OAUTH_CHALLENGE_SCOPE}"`;
  }
  if (errorDescription !== undefined) {
    value += `, error="invalid_token", error_description="${errorDescription}"`;
  }
  return value;
}

/** Parses `Authorization: Bearer <value>`. Returns null for a missing header,
 * another scheme, or an empty value. */
function parseBearer(header: string | null): string | null {
  if (!header) {
    return null;
  }
  const match = /^bearer[ \t]+(.*)$/i.exec(header.trim());
  const value = match?.[1].trim();
  return value ? value : null;
}

/** Counts this failure against the per-IP and per-prefix budgets; returns a 429
 * response if either is spent, otherwise null. */
async function throttleAuthFailure(
  request: NextRequest,
  presented: string | null
): Promise<Response | null> {
  const ip = await checkRateLimit({
    action: "mcp-auth-fail-ip",
    key: getClientIp(request),
    limit: MCP_RATE_LIMITS.authFailuresPerIpPerMinute,
    windowMinutes: 1,
  });
  let allowed = ip.allowed;
  if (presented?.startsWith(MCP_TOKEN_PREFIX)) {
    const prefix = await checkRateLimit({
      action: "mcp-auth-fail-prefix",
      key: presented.slice(0, MCP_TOKEN_DISPLAY_PREFIX_LENGTH),
      limit: MCP_RATE_LIMITS.authFailuresPerPrefixPerMinute,
      windowMinutes: 1,
    });
    allowed = allowed && prefix.allowed;
  }
  if (allowed) {
    return null;
  }
  return mcpJson({ error: "Too many failed authentication attempts." }, 429, {
    "Retry-After": String(secondsUntilWindowEnds()),
  });
}

async function authFailure(
  request: NextRequest,
  presented: string | null,
  reason: string,
  response: () => Response
): Promise<{ ok: false; response: Response }> {
  const prefix = presented?.startsWith(MCP_TOKEN_PREFIX)
    ? presented.slice(0, MCP_TOKEN_DISPLAY_PREFIX_LENGTH)
    : "none";
  // Never the token itself or its hash — only the display prefix.
  console.warn(`[mcp] auth_failed reason=${reason} prefix=${prefix}`);
  const throttled = await throttleAuthFailure(request, presented);
  return { ok: false, response: throttled ?? response() };
}

/** Resolves the bearer token on a request to the agent/admin it belongs to, or
 * the exact 401/429 response to send. */
export async function resolvePrincipal(
  request: NextRequest
): Promise<
  { ok: true; principal: McpPrincipal } | { ok: false; response: Response }
> {
  const raw = parseBearer(request.headers.get("authorization"));
  if (raw === null) {
    return await authFailure(request, null, "missing", () =>
      mcpJson({ error: "Missing bearer token." }, 401, {
        "WWW-Authenticate": challenge(),
      })
    );
  }

  // dkm_ tokens are personal access tokens, whether or not OAuth is available;
  // anything else is an OAuth access token when OAuth is on (and an invalid
  // token when it is not).
  if (!raw.startsWith(MCP_TOKEN_PREFIX) && isOAuthAvailable()) {
    const oauth = await verifyOAuthAccessToken(raw);
    if (!oauth.ok) {
      const description = REASON_TEXT[oauth.reason];
      return await authFailure(request, raw, oauth.reason, () =>
        mcpJson({ error: description }, 401, {
          "WWW-Authenticate": challenge(description),
        })
      );
    }
    return {
      ok: true,
      principal: {
        userId: oauth.user.id,
        name: oauth.user.name,
        email: oauth.user.email,
        role: oauth.user.role,
        scopes: oauth.scopes,
        authMethod: "oauth",
        credentialId: oauth.clientId,
        credentialName: oauth.clientName,
        credentialExpiresAt: oauth.expiresAt,
        clientId: oauth.clientId,
        consentId: oauth.consentId,
      },
    };
  }

  const result = await verifyMcpToken(raw);
  if (!result.ok) {
    const description = REASON_TEXT[result.reason];
    return await authFailure(request, raw, result.reason, () =>
      mcpJson({ error: description }, 401, {
        "WWW-Authenticate": challenge(description),
      })
    );
  }

  return {
    ok: true,
    principal: {
      userId: result.user.id,
      name: result.user.name,
      email: result.user.email,
      role: result.user.role,
      scopes: result.scopes,
      authMethod: "pat",
      credentialId: result.token.id,
      credentialName: result.token.name,
      credentialExpiresAt: result.token.expiresAt,
    },
  };
}
