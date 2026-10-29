import { authorizationServerResponse } from "@/lib/oauth-discovery";

// RFC 8414 authorization-server metadata. Served at
// /.well-known/oauth-authorization-server and (path-inserted for the issuer
// /api/auth) /.well-known/oauth-authorization-server/api/auth; anything else is
// a 404. Answers the constant "no OAuth" 404 when OAuth is unavailable or MCP
// is off.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  return await authorizationServerResponse(request, (await params).path);
}
