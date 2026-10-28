import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getTicketActionSettings } from "@/lib/settings";
import { TICKET_ACTION_DISABLED_MESSAGES } from "@/lib/ticket-actions";
import { getTicketAgent } from "@/lib/tickets/agent-session";
import { MAX_MERGE_SOURCES, mergeTicketsInto } from "@/lib/tickets/merge";
import { parseTicketNumber, readJsonObject } from "@/lib/tickets/route-input";

// POST /api/tickets/merge — agent/admin only.
// Body: { sourceTicketIds: string[], targetTicketNumber }.
// Merges every source INTO the target in one transaction — all or nothing —
// with one customer email for the lot (see lib/tickets/merge.ts). Irreversible.
export async function POST(request: NextRequest) {
  const agent = await getTicketAgent(request);
  if (!agent) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!(await getTicketActionSettings()).ticketMergeEnabled) {
    return NextResponse.json(
      { error: TICKET_ACTION_DISABLED_MESSAGES.merge },
      { status: 403 }
    );
  }

  const body = await readJsonObject(request);
  if (!body) {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 }
    );
  }

  const sourceTicketIds = Array.isArray(body.sourceTicketIds)
    ? body.sourceTicketIds.filter(
        (id): id is string => typeof id === "string" && id.length > 0
      )
    : [];
  if (sourceTicketIds.length === 0) {
    return NextResponse.json(
      { error: "Choose at least one ticket to merge." },
      { status: 400 }
    );
  }
  if (sourceTicketIds.length > MAX_MERGE_SOURCES) {
    return NextResponse.json(
      { error: `At most ${MAX_MERGE_SOURCES} tickets can be merged at once.` },
      { status: 400 }
    );
  }

  const targetTicketNumber = parseTicketNumber(body.targetTicketNumber);
  if (!targetTicketNumber) {
    return NextResponse.json(
      { error: "Choose a ticket to merge into." },
      { status: 400 }
    );
  }

  try {
    const result = await mergeTicketsInto(
      sourceTicketIds,
      targetTicketNumber,
      agent
    );
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }
    return NextResponse.json({
      ok: true,
      targetTicketNumber: result.targetTicketNumber,
      mergedTicketNumbers: result.mergedTicketNumbers,
    });
  } catch (err) {
    console.error("[POST /api/tickets/merge]", err);
    return NextResponse.json(
      { error: "Failed to merge tickets." },
      { status: 500 }
    );
  }
}
