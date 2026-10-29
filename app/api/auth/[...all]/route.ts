import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { isMcpServing } from "@/lib/mcp/http";
import { AUTH_BASE_PATH, isOAuthAvailable } from "@/lib/oauth";
import { getPlatformSettings } from "@/lib/settings";

const handlers = toNextJsHandler(auth.handler);

// The OAuth provider mounts many endpoints (client CRUD, introspection,
// userinfo, registration, ...). Docket needs five reachable ones; everything
// else is refused here before Better Auth sees it. Paths are relative to the
// auth base path.
const OAUTH_ALLOWED: Record<string, readonly string[]> = {
  "/oauth2/authorize": ["GET", "POST"],
  "/oauth2/token": ["POST"],
  "/oauth2/consent": ["POST"],
  "/oauth2/revoke": ["POST"],
  "/jwks": ["GET"],
};

function isOAuthSurface(path: string): boolean {
  return (
    path.startsWith("/oauth2") ||
    path.startsWith("/admin/oauth2") ||
    path.startsWith("/.well-known") ||
    path.startsWith("/mcp") ||
    path === "/jwks" ||
    path === "/token"
  );
}

function refusal(status: 404 | 405, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function guarded(
  method: "GET" | "POST",
  request: Request
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const path = pathname.startsWith(AUTH_BASE_PATH)
    ? pathname.slice(AUTH_BASE_PATH.length).replace(/\/+$/, "") || "/"
    : pathname;
  if (isOAuthSurface(path)) {
    const allowed = isOAuthAvailable() ? OAUTH_ALLOWED[path] : undefined;
    if (!allowed) {
      return refusal(404, "Not found.");
    }
    if (!allowed.includes(method)) {
      return refusal(405, "Method not allowed.");
    }
    if (!isMcpServing(await getPlatformSettings())) {
      return refusal(404, "MCP is disabled on this server.");
    }
  }
  return method === "GET" ? handlers.GET(request) : handlers.POST(request);
}

export function GET(request: Request) {
  return guarded("GET", request);
}

export function POST(request: Request) {
  return guarded("POST", request);
}
