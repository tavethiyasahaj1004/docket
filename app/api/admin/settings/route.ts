import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { platformSettings } from "@/db/schema/settings";
import { audit } from "@/lib/audit";
import { requireAdminFromRequest } from "@/lib/authz";
import { db } from "@/lib/db";
import {
  pickTicketActionSettings,
  TICKET_ACTION_SETTING_KEYS,
  type TicketActionSettings,
} from "@/lib/ticket-actions";
import {
  resolveAttachmentLimits,
  validateAttachmentLimitInput,
} from "@/lib/tickets/attachment-limits";

const VALID_THEMES = new Set([
  "default",
  "ocean",
  "forest",
  "sunset",
  "indigo",
  "slate",
]);
const VALID_APPEARANCES = new Set(["light", "dark", "auto"]);
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

interface SettingsBody extends Partial<TicketActionSettings> {
  appearanceMode?: string;
  attachmentMaxFileSizeMb?: unknown;
  attachmentMaxPerMessage?: unknown;
  attachmentMaxPerTicketSizeMb?: unknown;
  brandName?: string | null;
  emailAccentColor?: string | null;
  googleLoginEnabled?: boolean;
  magicLinkEnabled?: boolean;
  passwordLoginEnabled?: boolean;
  theme?: string;
  ticketEmailNotificationsEnabled?: boolean;
}

/** The three attachment caps as stored-column values (validated, defaulted). */
function attachmentSettingsFrom(
  row: Parameters<typeof resolveAttachmentLimits>[0]
) {
  const limits = resolveAttachmentLimits(row);
  return {
    attachmentMaxPerMessage: limits.maxPerMessage,
    attachmentMaxFileSizeMb: limits.maxFileSizeMb,
    attachmentMaxPerTicketSizeMb: limits.maxPerTicketSizeMb,
  };
}

// GET — agent/admin can read (middleware already enforced access)
export async function GET(_request: NextRequest) {
  const [row] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.id, "default"))
    .limit(1);

  return NextResponse.json({
    theme: row?.theme ?? "default",
    appearanceMode: row?.appearanceMode ?? "auto",
    passwordLoginEnabled: row?.passwordLoginEnabled ?? true,
    magicLinkEnabled: row?.magicLinkEnabled ?? false,
    googleLoginEnabled: row?.googleLoginEnabled ?? false,
    ticketEmailNotificationsEnabled:
      row?.ticketEmailNotificationsEnabled ?? true,
    brandName: row?.brandName ?? null,
    logoKey: row?.logoKey ?? null,
    emailAccentColor: row?.emailAccentColor ?? null,
    ...pickTicketActionSettings(row),
    ...attachmentSettingsFrom(row),
  });
}

// PATCH — admin only. Partial update: only fields present in the body are
// changed, everything else keeps its current stored value.
export async function PATCH(request: NextRequest) {
  let admin;
  try {
    admin = requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  let body: SettingsBody;
  try {
    body = (await request.json()) as SettingsBody;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const [existing] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.id, "default"))
    .limit(1);

  const theme = body.theme ?? existing?.theme ?? "default";
  const appearanceMode =
    body.appearanceMode ?? existing?.appearanceMode ?? "auto";
  const passwordLoginEnabled =
    body.passwordLoginEnabled ?? existing?.passwordLoginEnabled ?? true;
  const magicLinkEnabled =
    body.magicLinkEnabled ?? existing?.magicLinkEnabled ?? false;
  const googleLoginEnabled =
    body.googleLoginEnabled ?? existing?.googleLoginEnabled ?? false;
  const ticketEmailNotificationsEnabled =
    body.ticketEmailNotificationsEnabled ??
    existing?.ticketEmailNotificationsEnabled ??
    true;
  const ticketActions = pickTicketActionSettings(existing);
  for (const key of TICKET_ACTION_SETTING_KEYS) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "boolean") {
        return NextResponse.json(
          { error: "Invalid ticket action setting." },
          { status: 400 }
        );
      }
      ticketActions[key] = body[key];
    }
  }
  // Attachment caps: absent fields keep their current value; any present field
  // is validated strictly (integers, bounds).
  const attachmentSettings = attachmentSettingsFrom(existing);
  if (
    body.attachmentMaxPerMessage !== undefined ||
    body.attachmentMaxFileSizeMb !== undefined ||
    body.attachmentMaxPerTicketSizeMb !== undefined
  ) {
    const candidate = {
      maxPerMessage:
        body.attachmentMaxPerMessage ??
        attachmentSettings.attachmentMaxPerMessage,
      maxFileSizeMb:
        body.attachmentMaxFileSizeMb ??
        attachmentSettings.attachmentMaxFileSizeMb,
      maxPerTicketSizeMb:
        body.attachmentMaxPerTicketSizeMb ??
        attachmentSettings.attachmentMaxPerTicketSizeMb,
    };
    const errors = validateAttachmentLimitInput(candidate);
    const first = Object.values(errors)[0];
    if (first) {
      return NextResponse.json({ error: first }, { status: 400 });
    }
    attachmentSettings.attachmentMaxPerMessage =
      candidate.maxPerMessage as number;
    attachmentSettings.attachmentMaxFileSizeMb =
      candidate.maxFileSizeMb as number;
    attachmentSettings.attachmentMaxPerTicketSizeMb =
      candidate.maxPerTicketSizeMb as number;
  }
  const brandName =
    body.brandName === undefined
      ? (existing?.brandName ?? null)
      : (body.brandName?.trim() ?? "") || null;
  const emailAccentColor =
    body.emailAccentColor === undefined
      ? (existing?.emailAccentColor ?? null)
      : (body.emailAccentColor?.trim() ?? "") || null;

  if (body.theme !== undefined && !VALID_THEMES.has(theme)) {
    return NextResponse.json({ error: "Invalid theme." }, { status: 400 });
  }
  if (
    body.appearanceMode !== undefined &&
    !VALID_APPEARANCES.has(appearanceMode)
  ) {
    return NextResponse.json(
      { error: "Invalid appearance mode." },
      { status: 400 }
    );
  }
  if (!(passwordLoginEnabled || magicLinkEnabled || googleLoginEnabled)) {
    return NextResponse.json(
      { error: "At least one sign-in method must stay enabled." },
      { status: 400 }
    );
  }
  if (brandName !== null && brandName.length > 60) {
    return NextResponse.json(
      { error: "Brand name must be 60 characters or fewer." },
      { status: 400 }
    );
  }
  if (emailAccentColor !== null && !HEX_COLOR_RE.test(emailAccentColor)) {
    return NextResponse.json(
      { error: "Email accent color must be a hex color like #384959." },
      { status: 400 }
    );
  }

  const now = new Date();

  await db
    .insert(platformSettings)
    .values({
      id: "default",
      theme,
      appearanceMode,
      passwordLoginEnabled,
      magicLinkEnabled,
      googleLoginEnabled,
      ticketEmailNotificationsEnabled,
      ...ticketActions,
      ...attachmentSettings,
      brandName,
      emailAccentColor,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: {
        theme,
        appearanceMode,
        passwordLoginEnabled,
        magicLinkEnabled,
        googleLoginEnabled,
        ticketEmailNotificationsEnabled,
        ...ticketActions,
        ...attachmentSettings,
        brandName,
        emailAccentColor,
        updatedAt: now,
      },
    });

  await audit({
    action: "settings.updated",
    actorEmail: admin.email,
    actorId: admin.id,
    description: "Updated platform settings",
    entityId: "default",
    entityType: "platform_settings",
    metadata: {
      theme,
      appearanceMode,
      passwordLoginEnabled,
      magicLinkEnabled,
      googleLoginEnabled,
      ticketEmailNotificationsEnabled,
      ...ticketActions,
      ...attachmentSettings,
      brandName,
      emailAccentColor,
    },
  });

  return NextResponse.json({
    theme,
    appearanceMode,
    passwordLoginEnabled,
    magicLinkEnabled,
    googleLoginEnabled,
    ticketEmailNotificationsEnabled,
    ...ticketActions,
    ...attachmentSettings,
    brandName,
    emailAccentColor,
  });
}
