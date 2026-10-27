import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ADMIN_ROLE, AGENT_ROLE } from "@/config/platform";
import { tickets } from "@/db/schema";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { MERGED_TICKET_CHANGE_MESSAGE } from "@/lib/tickets/merge";
import { deleteReplyDraft, saveReplyDraft } from "@/lib/tickets/reply-drafts";

// Generous ceiling for a Tiptap JSON reply — only here to stop the autosave
// endpoint from being used to park arbitrarily large blobs in the DB.
const MAX_DRAFT_LENGTH = 200_000;

// /api/tickets/* is not covered by the proxy.ts middleware matcher, so we
// check the session directly here (same pattern as
// app/api/tickets/table-columns/route.ts).
async function requireAgentSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return null;
  }
  if (session.user.role !== AGENT_ROLE && session.user.role !== ADMIN_ROLE) {
    return null;
  }
  return session;
}

// Drafts on a merged ticket are NOT forwarded: the agent may already have a
// draft on the surviving ticket, and a stale tab's autosave (or Discard) would
// silently overwrite or delete it. The merge already deleted this ticket's
// drafts; the composer stops autosaving on this 409.
async function isMergedTicket(ticketId: string): Promise<boolean> {
  const [row] = await db
    .select({ mergedIntoTicketId: tickets.mergedIntoTicketId })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  return Boolean(row?.mergedIntoTicketId);
}

function mergedResponse() {
  return NextResponse.json(
    { error: MERGED_TICKET_CHANGE_MESSAGE },
    { status: 409 }
  );
}

// PUT — upsert the caller's own reply draft for this ticket. An empty draft
// deletes the row instead, so clearing the composer also clears the list's
// "Draft" marker.
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAgentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { id: ticketId } = await params;
  if (await isMergedTicket(ticketId)) {
    return mergedResponse();
  }

  let body: { content?: unknown; isInternal?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (
    typeof body.content !== "string" ||
    typeof body.isInternal !== "boolean" ||
    body.content.length > MAX_DRAFT_LENGTH
  ) {
    return NextResponse.json({ error: "Invalid draft." }, { status: 400 });
  }

  const result = await saveReplyDraft({
    ticketId,
    userId: session.user.id,
    content: body.content,
    isInternal: body.isInternal,
  });
  if (result.status === "cleared") {
    return NextResponse.json({ draft: null });
  }
  if (result.status === "not_found") {
    return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  }
  return NextResponse.json({
    draft: { updatedAt: result.updatedAt.toISOString() },
  });
}

// DELETE — discard the caller's own draft for this ticket.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAgentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { id: ticketId } = await params;
  if (await isMergedTicket(ticketId)) {
    return mergedResponse();
  }
  await deleteReplyDraft(ticketId, session.user.id);
  return NextResponse.json({ draft: null });
}
