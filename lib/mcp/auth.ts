import type { NextRequest } from "next/server";
import { mcpJson, secondsUntilWindowEnds } from "@/lib/mcp/http";
import { MCP_RATE_LIMITS } from "@/lib/mcp/limits";
import {
  MCP_TOKEN_DISPLAY_PREFIX_LENGTH,
  MCP_TOKEN_PREFIX,
  type McpScope,
  verifyMcpToken,
} from "@/lib/mcp-tokens";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export type McpPrincipal = {
  userId: string;
  name: string;
  email: string;
  role: string;
  /** Effective scopes: the token's grant intersected with the owner's current role. */
  scopes: McpScope[];
  authMethod: "pat";
  credentialId: string;
  credentialName: string;
  credentialExpiresAt: Date;
};

const REASON_TEXT = {
  invalid: "invalid token",
  expired: "token expired",
  revoked: "token revoked",
  not_permitted: "account not permitted",
} as const;

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
        "WWW-Authenticate": 'Bearer realm="docket"',
      })
    );
  }

  const result = await verifyMcpToken(raw);
  if (!result.ok) {
    const description = REASON_TEXT[result.reason];
    return await authFailure(request, raw, result.reason, () =>
      mcpJson({ error: description }, 401, {
        "WWW-Authenticate": `Bearer realm="docket", error="invalid_token", error_description="${description}"`,
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
