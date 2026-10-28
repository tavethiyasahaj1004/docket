import { NextResponse } from "next/server";
import { dbClient } from "@/lib/db";

// Liveness/readiness probe for orchestrators and uptime monitors. Unauthenticated
// on purpose — a healthcheck needing a session is useless to Docker — so it
// reports only "can this process reach its database", never versions, connection
// strings or error text. Failure reasons go to the log, not the response.
export const dynamic = "force-dynamic";

const VERSION = process.env.APP_VERSION ?? "dev";

export async function GET() {
  try {
    await dbClient`select 1`;
  } catch (error) {
    console.error("[health] database check failed", error);
    return NextResponse.json(
      { status: "error", database: "unreachable", version: VERSION },
      { status: 503 }
    );
  }

  return NextResponse.json({
    status: "ok",
    database: "ok",
    version: VERSION,
  });
}
