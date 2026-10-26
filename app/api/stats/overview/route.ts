import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getOverviewStats } from "@/lib/stats";

// GET — agent/admin can read (middleware already enforced access)
export async function GET(_request: NextRequest) {
  return NextResponse.json(await getOverviewStats());
}
