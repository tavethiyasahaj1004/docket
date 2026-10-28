import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getVolumeStats } from "@/lib/stats";

// GET — agent/admin can read (middleware already enforced access)
export async function GET(request: NextRequest) {
  const days = Math.min(
    30,
    Math.max(
      7,
      Number.parseInt(new URL(request.url).searchParams.get("days") ?? "7", 10)
    )
  );

  return NextResponse.json(await getVolumeStats(days));
}
