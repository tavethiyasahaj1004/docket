import { NextResponse } from "next/server";
import { getPusherClientConfig } from "@/lib/integration-settings";

// GET /api/config/client — public and unauthenticated, like /api/health.
// Returns only public Pusher identifiers, never secrets. It exists because
// NEXT_PUBLIC_* is inlined at *build* time; fetching at runtime lets the
// published image pick up a DB-saved value on a page refresh.
export const dynamic = "force-dynamic";

export async function GET() {
  const config = await getPusherClientConfig();
  return NextResponse.json(config);
}
