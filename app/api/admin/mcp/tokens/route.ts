import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAdminFromRequest } from "@/lib/authz";
import { listAllMcpTokens } from "@/lib/mcp-tokens";

// GET /api/admin/mcp/tokens — every user's tokens with their owner (never the
// hash or the raw token).
export async function GET(request: NextRequest) {
  try {
    requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  return NextResponse.json({ tokens: await listAllMcpTokens() });
}
