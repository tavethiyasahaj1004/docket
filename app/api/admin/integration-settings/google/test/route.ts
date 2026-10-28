import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAdminFromRequest } from "@/lib/authz";
import { getGoogleOAuthSettings } from "@/lib/integration-settings";
import { testGoogleOAuthCredentials } from "@/lib/integration-test";

interface TestBody {
  clientId?: unknown;
  clientSecret?: unknown;
}

// POST — admin only. Tests the client ID/secret currently in the form, which
// may not be saved yet. A blank secret falls back to the already-saved one.
// Ad hoc only — never persists a result; see the smtp/test route for why.
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

  const clientId =
    typeof body.clientId === "string" ? body.clientId.trim() : "";

  let clientSecret =
    typeof body.clientSecret === "string" ? body.clientSecret : "";
  if (!clientSecret) {
    const saved = await getGoogleOAuthSettings();
    clientSecret = saved?.clientSecret ?? "";
  }

  if (!(clientId && clientSecret)) {
    return NextResponse.json(
      { ok: false, message: "Fill in the client ID and secret first." },
      { status: 400 }
    );
  }

  const result = await testGoogleOAuthCredentials(clientId, clientSecret);
  return NextResponse.json(result);
}
