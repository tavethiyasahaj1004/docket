import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireApiKey } from "@/lib/api-auth";
import { getPublicTicketConfig } from "@/lib/ticket-config";

// GET /api/v1/config — the valid category/priority/status slugs, so integrators
// can build a ticket form without hardcoding slugs that break silently when an
// admin renames them. Arrays come pre-sorted in the display order agents see;
// `tags` is the shared pool, alphabetical, since tags have no defined order.
export async function GET(request: NextRequest) {
  try {
    await requireApiKey(request);
  } catch (e) {
    return e as Response;
  }

  return NextResponse.json(await getPublicTicketConfig());
}
