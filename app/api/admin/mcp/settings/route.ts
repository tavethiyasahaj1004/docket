import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { platformSettings } from "@/db/schema/settings";
import { audit } from "@/lib/audit";
import { requireAdminFromRequest } from "@/lib/authz";
import { db } from "@/lib/db";
import { getMcpUrl, isHttpsRequirementMet } from "@/lib/mcp/http";

async function readEnabled(): Promise<boolean> {
  const [row] = await db
    .select({ mcpEnabled: platformSettings.mcpEnabled })
    .from(platformSettings)
    .where(eq(platformSettings.id, "default"))
    .limit(1);
  return row?.mcpEnabled ?? false;
}

// GET /api/admin/mcp/settings
export async function GET(request: NextRequest) {
  try {
    requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  return NextResponse.json({
    enabled: await readEnabled(),
    httpsRequirementMet: isHttpsRequirementMet(),
    mcpUrl: getMcpUrl(),
  });
}

// PATCH /api/admin/mcp/settings — turn the MCP endpoint on or off.
export async function PATCH(request: NextRequest) {
  let admin;
  try {
    admin = requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  let enabled: unknown;
  try {
    enabled = ((await request.json()) as { enabled?: unknown } | null)?.enabled;
  } catch {
    enabled = undefined;
  }
  if (typeof enabled !== "boolean") {
    return NextResponse.json(
      { error: "enabled must be true or false." },
      { status: 400 }
    );
  }

  if (enabled && !isHttpsRequirementMet()) {
    return NextResponse.json(
      {
        error:
          "MCP can only be enabled when NEXT_PUBLIC_APP_URL uses https:// in production.",
      },
      { status: 409 }
    );
  }

  const previous = await readEnabled();
  const now = new Date();
  await db
    .insert(platformSettings)
    .values({ id: "default", mcpEnabled: enabled, updatedAt: now })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: { mcpEnabled: enabled, updatedAt: now },
    });

  if (previous !== enabled) {
    await audit({
      action: "mcp.enabled_changed",
      actorEmail: admin.email,
      actorId: admin.id,
      description: `${enabled ? "Enabled" : "Disabled"} the MCP endpoint`,
      entityId: "default",
      entityType: "platform_settings",
      metadata: { from: previous, to: enabled },
    });
  }

  return NextResponse.json({ enabled });
}
