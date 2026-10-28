import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAdminFromRequest } from "@/lib/authz";
import { getPusherBeamsSettings } from "@/lib/integration-settings";
import { testPusherBeamsConnection } from "@/lib/integration-test";

interface TestBody {
  instanceId?: unknown;
  secretKey?: unknown;
}

// POST — admin only. Tests the Pusher Beams fields currently in the form,
// which may not be saved yet. A blank secret key falls back to the
// already-saved one. Ad hoc only — never persists a result; see the
// smtp/test route for why.
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

  const instanceId =
    typeof body.instanceId === "string" ? body.instanceId.trim() : "";

  let secretKey = typeof body.secretKey === "string" ? body.secretKey : "";
  if (!secretKey) {
    const saved = await getPusherBeamsSettings();
    secretKey = saved?.secretKey ?? "";
  }

  if (!(instanceId && secretKey)) {
    return NextResponse.json(
      { ok: false, message: "Fill in the instance ID and secret key first." },
      { status: 400 }
    );
  }

  const result = await testPusherBeamsConnection({ instanceId, secretKey });
  return NextResponse.json(result);
}
