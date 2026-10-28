import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAdminFromRequest } from "@/lib/authz";
import { getSmtpSettings } from "@/lib/integration-settings";
import { testSmtpConnection } from "@/lib/integration-test";

interface TestBody {
  from?: unknown;
  host?: unknown;
  pass?: unknown;
  port?: unknown;
  user?: unknown;
}

// POST — admin only. Tests the SMTP fields currently in the form, which may
// not be saved yet. A blank password falls back to the already-saved one, so
// re-testing after a save doesn't require retyping it. Ad hoc only — never
// persists a result, unlike PATCH /api/admin/integration-settings, which
// records the authoritative last-tested state shown on the "Configured" badge.
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

  const host = typeof body.host === "string" ? body.host.trim() : "";
  const user = typeof body.user === "string" ? body.user.trim() : "";
  const port =
    typeof body.port === "number"
      ? Math.trunc(body.port)
      : Number.parseInt(String(body.port), 10);

  let pass = typeof body.pass === "string" ? body.pass : "";
  if (!pass) {
    const saved = await getSmtpSettings();
    pass = saved?.pass ?? "";
  }

  if (!(host && user && pass && Number.isFinite(port))) {
    return NextResponse.json(
      {
        ok: false,
        message: "Fill in host, port, username, and password first.",
      },
      { status: 400 }
    );
  }

  const result = await testSmtpConnection({ host, port, user, pass });
  return NextResponse.json(result);
}
