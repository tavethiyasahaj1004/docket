import { createId } from "@paralleldrive/cuid2";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { cannedResponses } from "@/db/schema";
import { requireAgentFromRequest } from "@/lib/authz";
import { searchCannedResponses } from "@/lib/canned-responses";
import { db } from "@/lib/db";
import { isRichTextEmpty } from "@/lib/rich-text";

// GET /api/canned-responses — agent/admin. Optional ?q= title search.
export async function GET(request: NextRequest) {
  try {
    requireAgentFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  const q = request.nextUrl.searchParams.get("q")?.trim();
  const rows = await searchCannedResponses(q);

  return NextResponse.json(rows);
}

// POST /api/canned-responses — agent/admin. Team-shared — any agent can create.
export async function POST(request: NextRequest) {
  let actor: ReturnType<typeof requireAgentFromRequest>;
  try {
    actor = requireAgentFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  let body: { title?: string; content?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 }
    );
  }

  const title = body.title?.trim();
  if (!title || title.length < 2 || title.length > 100) {
    return NextResponse.json(
      { error: "Title must be 2–100 characters." },
      { status: 400 }
    );
  }
  const content = body.content ?? "";
  if (isRichTextEmpty(content)) {
    return NextResponse.json(
      { error: "Content is required." },
      { status: 400 }
    );
  }

  const now = new Date();
  const [inserted] = await db
    .insert(cannedResponses)
    .values({
      id: createId(),
      title,
      content,
      createdById: actor.id,
      createdByName: actor.name || actor.email,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return NextResponse.json(inserted, { status: 201 });
}
