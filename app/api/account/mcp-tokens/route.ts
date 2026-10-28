import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionUserFromRequest } from "@/lib/authz";
import { getMcpUrl, isMcpServing } from "@/lib/mcp/http";
import {
  allowedMcpScopesForRole,
  createMcpToken,
  DEFAULT_MCP_SCOPES,
  isEligibleMcpRole,
  listMcpTokensForUser,
  MCP_ISSUABLE_SCOPES,
  MCP_TOKEN_DEFAULT_TTL_DAYS,
  MCP_TOKEN_MAX_TTL_DAYS,
} from "@/lib/mcp-tokens";
import { getPlatformSettings } from "@/lib/settings";

// The request has already been through proxy.ts, which injected the x-user-*
// headers; only an agent or admin may manage MCP tokens.
function currentUser(request: NextRequest) {
  const me = getSessionUserFromRequest(request);
  if (!me) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (!isEligibleMcpRole(me.role)) {
    return {
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return { me };
}

const CREATE_ERRORS = {
  mcp_disabled: [403, "MCP is disabled on this server."],
  impersonated: [
    403,
    "MCP tokens can't be created while impersonating a user.",
  ],
  not_permitted: [403, "Your account can't create MCP tokens."],
  invalid_name: [400, "Name must be 1–100 characters."],
  invalid_scopes: [400, "Invalid scopes."],
  scope_not_issuable: [400, "One of these scopes can't be issued right now."],
  scope_not_allowed: [400, "Your role can't grant one of these scopes."],
  invalid_expiry: [400, "Expiry must be a whole number of days from 1 to 90."],
} as const;

// GET /api/account/mcp-tokens — the caller's own tokens (never the hash or the
// raw token) plus what the create form needs.
export async function GET(request: NextRequest) {
  const { me, error } = currentUser(request);
  if (!me) {
    return error;
  }

  const [tokens, settings] = await Promise.all([
    listMcpTokensForUser(me.id),
    getPlatformSettings(),
  ]);
  const allowed = allowedMcpScopesForRole(me.role);

  return NextResponse.json({
    tokens,
    mcpEnabled: isMcpServing(settings),
    mcpUrl: getMcpUrl(),
    issuableScopes: MCP_ISSUABLE_SCOPES.filter((s) => allowed.includes(s)),
    defaultScopes: DEFAULT_MCP_SCOPES,
    maxTtlDays: MCP_TOKEN_MAX_TTL_DAYS,
    defaultTtlDays: MCP_TOKEN_DEFAULT_TTL_DAYS,
  });
}

// POST /api/account/mcp-tokens — create a token. The raw token is returned in
// this response only and can never be retrieved again.
export async function POST(request: NextRequest) {
  const { me, error } = currentUser(request);
  if (!me) {
    return error;
  }

  let body: { name?: unknown; scopes?: unknown; expiresInDays?: unknown };
  try {
    const parsed: unknown = await request.json();
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }
    body = parsed as typeof body;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 }
    );
  }

  // proxy.ts only forwards identity headers, so the impersonation marker has to
  // come from the real session. Fail closed: no session, or one that belongs to
  // someone other than the header identity, can't mint a token.
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session || session.user.id !== me.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const impersonatedBy = session.session.impersonatedBy ?? null;

  const result = await createMcpToken({
    userId: me.id,
    name: typeof body.name === "string" ? body.name : "",
    scopes: body.scopes,
    expiresInDays: body.expiresInDays,
    impersonatedBy,
  });
  if (!result.ok) {
    const [status, message] = CREATE_ERRORS[result.reason];
    return NextResponse.json({ error: message }, { status });
  }

  return NextResponse.json(
    { token: result.token, rawToken: result.rawToken, mcpUrl: getMcpUrl() },
    { status: 201 }
  );
}
