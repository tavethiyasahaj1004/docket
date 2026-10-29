import { protectedResourceResponse } from "@/lib/oauth-discovery";

// RFC 9728 protected-resource metadata for the MCP endpoint. Served at
// /.well-known/oauth-protected-resource and (path-inserted, as clients try it)
// /.well-known/oauth-protected-resource/api/mcp; anything deeper is a 404.
// Answers the constant "no OAuth" 404 when OAuth is unavailable or MCP is off.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  return await protectedResourceResponse((await params).path);
}
