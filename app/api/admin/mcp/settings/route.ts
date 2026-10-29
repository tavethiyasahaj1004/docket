import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { platformSettings } from "@/db/schema/settings";
import { audit } from "@/lib/audit";
import { requireAdminFromRequest } from "@/lib/authz";
import { db } from "@/lib/db";
import { getMcpUrl, isHttpsRequirementMet } from "@/lib/mcp/http";
import {
  cancelledActionAudit,
  cancelPendingRepliesForGateOff,
} from "@/lib/mcp/pending-actions-core";
import { isCustomerRepliesEnabled } from "@/lib/mcp/reply-gate";

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
    customerRepliesEnabled: await isCustomerRepliesEnabled(),
    httpsRequirementMet: isHttpsRequirementMet(),
    mcpUrl: getMcpUrl(),
  });
}

/** Turns the customer-replies setting on or off. Turning it off cancels every
 * pending reply request in the SAME transaction, so no reply can be approved
 * after the switch (the approval path refuses replies while it is off, too). */
async function applyCustomerReplies(
  admin: { id: string; email: string },
  next: boolean
) {
  const now = new Date();
  const { previous, cancelled } = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ value: platformSettings.mcpCustomerRepliesEnabled })
      .from(platformSettings)
      .where(eq(platformSettings.id, "default"))
      .for("update");
    await tx
      .insert(platformSettings)
      .values({
        id: "default",
        mcpCustomerRepliesEnabled: next,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: platformSettings.id,
        set: { mcpCustomerRepliesEnabled: next, updatedAt: now },
      });
    return {
      previous: row?.value ?? false,
      cancelled: next ? [] : await cancelPendingRepliesForGateOff(tx),
    };
  });

  if (previous !== next) {
    await audit({
      action: "mcp.customer_replies_changed",
      actorEmail: admin.email,
      actorId: admin.id,
      description: `${next ? "Allowed" : "Disallowed"} customer replies via MCP`,
      entityId: "default",
      entityType: "platform_settings",
      metadata: { from: previous, to: next },
    });
  }
  for (const row of cancelled) {
    await audit(
      cancelledActionAudit(row, {
        actorId: admin.id,
        actorEmail: admin.email,
        reason: "replies_disabled",
      })
    );
  }
}

// PATCH /api/admin/mcp/settings — turn the MCP endpoint on or off (`enabled`)
// and/or allow customer replies via MCP (`customerRepliesEnabled`).
export async function PATCH(request: NextRequest) {
  let admin;
  try {
    admin = requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  let enabled: unknown;
  let customerReplies: unknown;
  try {
    const body = (await request.json()) as {
      enabled?: unknown;
      customerRepliesEnabled?: unknown;
    } | null;
    enabled = body?.enabled;
    customerReplies = body?.customerRepliesEnabled;
  } catch {
    enabled = undefined;
    customerReplies = undefined;
  }
  if (customerReplies !== undefined && typeof customerReplies !== "boolean") {
    return NextResponse.json(
      { error: "customerRepliesEnabled must be true or false." },
      { status: 400 }
    );
  }
  // Either field alone is fine; with neither, the original error stands.
  if (
    typeof enabled !== "boolean" &&
    (enabled !== undefined || customerReplies === undefined)
  ) {
    return NextResponse.json(
      { error: "enabled must be true or false." },
      { status: 400 }
    );
  }

  if (enabled === true && !isHttpsRequirementMet()) {
    return NextResponse.json(
      {
        error:
          "MCP can only be enabled when NEXT_PUBLIC_APP_URL uses https:// in production.",
      },
      { status: 409 }
    );
  }

  if (typeof enabled === "boolean") {
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
  }
  if (typeof customerReplies === "boolean") {
    await applyCustomerReplies(admin, customerReplies);
  }

  return NextResponse.json({
    ...(typeof enabled === "boolean" ? { enabled } : {}),
    ...(typeof customerReplies === "boolean"
      ? { customerRepliesEnabled: customerReplies }
      : {}),
  });
}
