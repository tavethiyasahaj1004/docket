// The two well-known documents MCP clients read before they start OAuth
// (RFC 9728 protected-resource metadata and RFC 8414 authorization-server
// metadata). Served by app/.well-known/*; Better Auth cannot serve them itself
// because it is mounted under /api/auth, not at the site root.
import { auth } from "@/lib/auth";
import { isMcpServing, mcpJson } from "@/lib/mcp/http";
import {
  isOAuthAvailable,
  MCP_OAUTH_RESOURCE,
  OAUTH_MCP_SCOPES,
} from "@/lib/oauth";
import { getPlatformSettings } from "@/lib/settings";

/** What discovery says when OAuth is not offered (plain-http deployment or MCP
 * switched off): the same constant answer the pre-OAuth stub gave. */
export function oauthNotSupported(): Response {
  return mcpJson(
    {
      error: "This server does not support OAuth. Use a personal access token.",
    },
    404
  );
}

function notFound(): Response {
  return mcpJson({ error: "Not found." }, 404);
}

async function discoveryEnabled(): Promise<boolean> {
  if (!isOAuthAvailable()) {
    return false;
  }
  return isMcpServing(await getPlatformSettings());
}

function json(body: unknown): Response {
  return mcpJson(body, 200);
}

/** The authorization server's identifier: Better Auth's own base URL
 * (APP_URL + /api/auth), which is also the `iss` of every access token. */
async function getIssuer(): Promise<string> {
  return (await auth.$context).baseURL;
}

/** Serves `/.well-known/oauth-protected-resource[/api/mcp]`. */
export async function protectedResourceResponse(
  path: string[] | undefined
): Promise<Response> {
  if (!(await discoveryEnabled())) {
    return oauthNotSupported();
  }
  const joined = (path ?? []).join("/");
  if (joined !== "" && joined !== "api/mcp") {
    return notFound();
  }
  return json({
    resource: MCP_OAUTH_RESOURCE,
    authorization_servers: [await getIssuer()],
    bearer_methods_supported: ["header"],
    scopes_supported: [...OAUTH_MCP_SCOPES],
  });
}

// Keys Docket does not offer (see the OAUTH_ALLOWED list in app/api/auth): there
// are no confidential clients, so no introspection and no client authentication
// beyond PKCE, and no back-channel logout.
const OMITTED_METADATA_KEYS = [
  "introspection_endpoint",
  "introspection_endpoint_auth_methods_supported",
  "introspection_endpoint_auth_signing_alg_values_supported",
  "revocation_endpoint_auth_signing_alg_values_supported",
  "token_endpoint_auth_signing_alg_values_supported",
  "registration_endpoint",
  "backchannel_logout_supported",
  "backchannel_logout_session_supported",
  "dpop_signing_alg_values_supported",
] as const;

/** Serves `/.well-known/oauth-authorization-server[/api/auth]`. */
export async function authorizationServerResponse(
  request: Request,
  path: string[] | undefined
): Promise<Response> {
  if (!(await discoveryEnabled())) {
    return oauthNotSupported();
  }
  const joined = (path ?? []).join("/");
  if (joined !== "" && joined !== "api/auth") {
    return notFound();
  }
  const metadata = (await auth.api.getOAuthServerConfig({
    request,
    asResponse: false,
  })) as unknown as Record<string, unknown>;
  for (const key of OMITTED_METADATA_KEYS) {
    delete metadata[key];
  }
  return json({
    ...metadata,
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    // Docket's scopes are the resource's; this is what a client may ask for.
    scopes_supported: [...(metadata.scopes_supported as string[])],
  });
}
