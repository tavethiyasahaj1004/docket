import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ADMIN_ROLE, AGENT_ROLE } from "@/config/platform";
import { tickets } from "@/db/schema";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { authorizeChannel } from "@/lib/realtime";

const TICKET_CHANNEL_PREFIX = "private-ticket-";
const USER_CHANNEL_PREFIX = "private-user-";

// POST /api/pusher/auth — authorizes private-channel subscriptions. Outside the
// middleware matcher because it serves two callers: an agent session gets the
// ticket list and any ticket (but only their own `private-user-{id}` bell), while
// a customer proving a ticket `token` gets that one ticket and never the list.
export async function POST(request: NextRequest) {
  let socketId: string | null;
  let channel: string | null;
  let token: string | null;
  try {
    const form = await request.formData();
    socketId = form.get("socket_id") as string | null;
    channel = form.get("channel_name") as string | null;
    token = form.get("token") as string | null;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (!(socketId && channel)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const session = await auth.api.getSession({ headers: request.headers });
  const isAgent =
    !!session?.user &&
    (session.user.role === AGENT_ROLE || session.user.role === ADMIN_ROLE);

  if (channel === "private-tickets") {
    if (!isAgent) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
  } else if (channel.startsWith(TICKET_CHANNEL_PREFIX)) {
    if (!isAgent) {
      const ticketId = channel.slice(TICKET_CHANNEL_PREFIX.length);
      if (!token) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
      const [ticket] = await db
        .select({ customerToken: tickets.customerToken })
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .limit(1);
      if (!ticket || ticket.customerToken !== token) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
    }
  } else if (channel.startsWith(USER_CHANNEL_PREFIX)) {
    const targetUserId = channel.slice(USER_CHANNEL_PREFIX.length);
    if (!isAgent || session?.user.id !== targetUserId) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
  } else {
    return NextResponse.json({ error: "Unknown channel." }, { status: 403 });
  }

  const authResponse = await authorizeChannel(socketId, channel);
  if (!authResponse) {
    return NextResponse.json({ error: "Not configured." }, { status: 404 });
  }

  return NextResponse.json(authResponse);
}
