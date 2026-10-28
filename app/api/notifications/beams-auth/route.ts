import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/authz";
import { generateBeamsToken } from "@/lib/push";

// GET /api/notifications/beams-auth?user_id=... — issues a Pusher Beams device
// token, but only for the currently signed-in agent's own user id.
export async function GET(request: NextRequest) {
  const me = getSessionUserFromRequest(request);
  if (!me) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const userId = request.nextUrl.searchParams.get("user_id");
  if (!userId || userId !== me.id) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const token = await generateBeamsToken(userId);
  if (!token) {
    return NextResponse.json(
      { error: "Push not configured." },
      { status: 404 }
    );
  }

  return NextResponse.json(token);
}
