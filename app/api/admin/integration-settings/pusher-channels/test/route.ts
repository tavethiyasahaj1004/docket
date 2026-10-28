import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAdminFromRequest } from "@/lib/authz";
import { getPusherChannelsSettings } from "@/lib/integration-settings";
import { testPusherChannelsConnection } from "@/lib/integration-test";

interface TestBody {
  appId?: unknown;
  cluster?: unknown;
  key?: unknown;
  secret?: unknown;
}

// POST — admin only. Tests the Pusher Channels fields currently in the form,
// which may not be saved yet. A blank secret falls back to the already-saved
// one. Ad hoc only — never persists a result; see the smtp/test route for why.
export async function POST(request: NextRequest) {
  try {
    requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  let body: TestBody;
  try {
    body = (await request.json()) as TestBody;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const appId = typeof body.appId === "string" ? body.appId.trim() : "";
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const cluster = typeof body.cluster === "string" ? body.cluster.trim() : "";

  let secret = typeof body.secret === "string" ? body.secret : "";
  if (!secret) {
    const saved = await getPusherChannelsSettings();
    secret = saved?.secret ?? "";
  }

  if (!(appId && key && cluster && secret)) {
    return NextResponse.json(
      {
        ok: false,
        message: "Fill in the app ID, key, cluster, and secret first.",
      },
      { status: 400 }
    );
  }

  const result = await testPusherChannelsConnection({
    appId,
    key,
    cluster,
    secret,
  });
  return NextResponse.json(result);
}
