import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { userTicketTablePrefs } from "@/db/schema/user-preferences";
import { getSessionUserFromRequest } from "@/lib/authz";
import { db } from "@/lib/db";

// PATCH — save the caller's own reply-composer preferences (currently just
// sendReplyOnEnter). /api/account/* is covered by the proxy.ts middleware
// matcher, so the session is read from injected headers like
// app/api/account/session/route.ts.
export async function PATCH(request: NextRequest) {
  const user = getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: { sendReplyOnEnter?: unknown };
  try {
    body = (await request.json()) as { sendReplyOnEnter?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (typeof body.sendReplyOnEnter !== "boolean") {
    return NextResponse.json(
      { error: "Invalid preference value." },
      { status: 400 }
    );
  }

  const now = new Date();
  await db
    .insert(userTicketTablePrefs)
    .values({
      userId: user.id,
      sendReplyOnEnter: body.sendReplyOnEnter,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userTicketTablePrefs.userId,
      set: { sendReplyOnEnter: body.sendReplyOnEnter, updatedAt: now },
    });

  return NextResponse.json({ sendReplyOnEnter: body.sendReplyOnEnter });
}
