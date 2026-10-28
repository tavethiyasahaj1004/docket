import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { listActiveAgents } from "@/lib/agents";

// GET — agent/admin can read (middleware already enforced access)
export async function GET(_request: NextRequest) {
  const agents = await listActiveAgents();

  return NextResponse.json(agents);
}
