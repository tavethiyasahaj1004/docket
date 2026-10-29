// OAuth 2.1 for the MCP endpoint (Release 4): the constants and the enablement
// guard shared by lib/auth.ts (plugin registration), the discovery routes, the
// bearer-token verifier and the UI. No database and no Better Auth import, so
// it is safe to load from anywhere (and from `next build` with placeholder env).
import { env } from "@/lib/env";
import { getMcpUrl } from "@/lib/mcp/http";
import { OAUTH_OFFLINE_SCOPE } from "@/lib/oauth-scopes";

export { OAUTH_OFFLINE_SCOPE };

/** Better Auth's mount point (app/api/auth/[...all]). */
export const AUTH_BASE_PATH = "/api/auth";

/** The Docket scopes OAuth can ever grant. An explicit list on purpose, NOT
 * derived from MCP_ISSUABLE_SCOPES: a scope that later becomes issuable for
 * personal access tokens (tickets:manage, tickets:reply) must not silently become
 * grantable over OAuth; adding one here is a deliberate decision.
 * tickets:read_internal, tickets:manage and tickets:reply are absent. */
export const OAUTH_MCP_SCOPES = [
  "tickets:read",
  "customers:read",
  "tickets:write",
  "reports:read",
] as const;

/** Every scope the provider will ever issue: those plus offline_access. */
export const OAUTH_SCOPES: readonly string[] = [
  OAUTH_OFFLINE_SCOPE,
  ...OAUTH_MCP_SCOPES,
];

/** What a CIMD client gets as its default capability (matches the PAT defaults). */
export const OAUTH_DEFAULT_SCOPES: readonly string[] = [
  "tickets:read",
  "customers:read",
  OAUTH_OFFLINE_SCOPE,
];

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** OAuth needs a trustworthy transport: https, or http on a loopback host (local
 * development). Anything else leaves MCP on personal access tokens only. */
export function isOAuthAvailableFor(appUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && isLoopbackHost(url.hostname))
  );
}

/** True when the OAuth plugins are registered for this process. */
export function isOAuthAvailable(): boolean {
  return isOAuthAvailableFor(env.NEXT_PUBLIC_APP_URL);
}

/** The protected-resource identifier tokens are bound to (`aud`): exactly the
 * connector URL users paste into their assistant, no trailing slash. */
export const MCP_OAUTH_RESOURCE = getMcpUrl();

/** Where clients find the RFC 9728 document for the MCP endpoint. */
export function protectedResourceMetadataUrl(): string {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  return `${base}/.well-known/oauth-protected-resource/api/mcp`;
}

/** Scopes advertised in 401 challenges (what an assistant should ask for).
 * Claude Code requests exactly these, so offline_access must be in the list or
 * it gets no refresh token and has to sign in again every hour. */
export const OAUTH_CHALLENGE_SCOPE = `tickets:read customers:read ${OAUTH_OFFLINE_SCOPE}`;
