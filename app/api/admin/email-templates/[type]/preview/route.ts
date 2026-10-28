import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAdminFromRequest } from "@/lib/authz";
import {
  EMAIL_TEMPLATE_TYPES,
  type EmailTemplateType,
  renderEmailPreview,
} from "@/lib/email-templates";
import {
  getPlatformSettings,
  resolveBrandName,
  resolveEmailAccentColor,
  resolveLogoUrl,
} from "@/lib/settings";

function isValidType(type: string): type is EmailTemplateType {
  return EMAIL_TEMPLATE_TYPES.some((t) => t.type === type);
}

// POST — admin only. Renders the *unsaved* subject/body from the request
// body (not the DB row) against fixed sample data, so the admin UI can show
// a live preview before saving.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ type: string }> }
) {
  try {
    requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  const { type } = await params;
  if (!isValidType(type)) {
    return NextResponse.json(
      { error: "Unknown email template type." },
      { status: 404 }
    );
  }

  let body: { subject?: string | null; body?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 }
    );
  }

  if (!body.body) {
    return NextResponse.json(
      { error: "Body is required to preview." },
      { status: 400 }
    );
  }

  const settings = await getPlatformSettings();
  const preview = renderEmailPreview({
    type,
    subject: body.subject ?? null,
    body: body.body,
    brandName: resolveBrandName(settings.brandName),
    logoUrl: resolveLogoUrl(settings.logoKey, true),
    accentColor: resolveEmailAccentColor(settings.emailAccentColor),
  });

  return NextResponse.json(preview);
}
