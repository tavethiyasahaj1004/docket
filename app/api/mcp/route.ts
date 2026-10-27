import { createId } from "@paralleldrive/cuid2";
import type { NextRequest } from "next/server";
import { resolvePrincipal } from "@/lib/mcp/auth";
import {
  checkHost,
  checkOrigin,
  isMcpServing,
  mcpJson,
  parseSingleJsonRpc,
  readBodyCapped,
  secondsUntilWindowEnds,
} from "@/lib/mcp/http";
import { MCP_MAX_BODY_BYTES, MCP_RATE_LIMITS } from "@/lib/mcp/limits";
import { describeErrorForLog } from "@/lib/mcp/safe-handler";
import { mcpHandler, toMcpAuthInfo } from "@/lib/mcp/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { getPlatformSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Outside the proxy.ts matcher on purpose: MCP authenticates with its own bearer
// token, never a browser session, so the x-user-* headers do not exist here.
export async function POST(request: NextRequest) {
  // Disabled is checked before anything else, so an off switch never answers
  // 401 and never touches a token's lastUsedAt.
  const settings = await getPlatformSettings();
  if (!isMcpServing(settings)) {
    return mcpJson({ error: "MCP is disabled on this server." }, 404);
  }

  const blocked = checkOrigin(request) ?? checkHost(request);
  if (blocked) {
    return blocked;
  }

  const body = await readBodyCapped(request, MCP_MAX_BODY_BYTES);
  if (!body.ok) {
    return body.response;
  }

  const resolved = await resolvePrincipal(request);
  if (!resolved.ok) {
    return resolved.response;
  }
  const { principal } = resolved;

  const limit = await checkRateLimit({
    action: "mcp",
    key: principal.userId,
    limit: MCP_RATE_LIMITS.allCallsPerMinute,
    windowMinutes: 1,
  });
  if (!limit.allowed) {
    return mcpJson({ error: "Rate limit exceeded." }, 429, {
      "Retry-After": String(secondsUntilWindowEnds()),
    });
  }

  const parsed = parseSingleJsonRpc(body.text);
  if (!parsed.ok) {
    return parsed.response;
  }

  const requestId = createId();
  const forwarded = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: body.text,
  });

  try {
    const response = await mcpHandler.fetch(forwarded, {
      authInfo: toMcpAuthInfo(principal, requestId),
    });
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    console.error(
      `[mcp] handler_failed ref=${requestId}`,
      describeErrorForLog(error)
    );
    return mcpJson({ error: "Internal server error." }, 500);
  }
}

function methodNotAllowed() {
  return mcpJson({ error: "Method not allowed." }, 405, { Allow: "POST" });
}

export function GET() {
  return methodNotAllowed();
}

export function DELETE() {
  return methodNotAllowed();
}
