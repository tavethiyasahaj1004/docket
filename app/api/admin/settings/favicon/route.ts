import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { platformSettings } from "@/db/schema/settings";
import { requireAdminFromRequest } from "@/lib/authz";
import { db } from "@/lib/db";
import { resolveLogoUrl } from "@/lib/settings";
import { storage } from "@/lib/storage";

const ALLOWED_MIME_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};
const MAX_FILE_SIZE = 2 * 1024 * 1024;

// POST /api/admin/settings/favicon — admin only. Uploads a new favicon,
// replacing (and deleting) any previous one.
export async function POST(request: NextRequest) {
  try {
    requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const file = formData.get("favicon");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }
  // Some browser/OS combos don't register a MIME type for .ico at all and
  // report file.type as "" or "application/octet-stream" — fall back to the
  // filename extension for that one case.
  const ext =
    ALLOWED_MIME_TYPES[file.type] ??
    (file.name.toLowerCase().endsWith(".ico") ? "ico" : undefined);
  if (!ext) {
    return NextResponse.json(
      { error: "Favicon must be a PNG, JPEG, SVG, WebP, or ICO image." },
      { status: 400 }
    );
  }
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: "Favicon must be 2 MB or smaller." },
      { status: 400 }
    );
  }

  const [existing] = await db
    .select({ faviconKey: platformSettings.faviconKey })
    .from(platformSettings)
    .where(eq(platformSettings.id, "default"))
    .limit(1);

  const key = `branding/favicon-${createId()}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await storage.upload(key, buffer, file.type);

  const now = new Date();
  await db
    .insert(platformSettings)
    .values({ id: "default", faviconKey: key, updatedAt: now })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: { faviconKey: key, updatedAt: now },
    });

  if (existing?.faviconKey) {
    await storage.delete(existing.faviconKey).catch(() => undefined);
  }

  return NextResponse.json({ faviconUrl: resolveLogoUrl(key) });
}

// DELETE /api/admin/settings/favicon — admin only. Clears the favicon,
// reverting the browser tab icon to the logo (or the static default).
export async function DELETE(request: NextRequest) {
  try {
    requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  const [existing] = await db
    .select({ faviconKey: platformSettings.faviconKey })
    .from(platformSettings)
    .where(eq(platformSettings.id, "default"))
    .limit(1);

  const now = new Date();
  await db
    .insert(platformSettings)
    .values({ id: "default", faviconKey: null, updatedAt: now })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: { faviconKey: null, updatedAt: now },
    });

  if (existing?.faviconKey) {
    await storage.delete(existing.faviconKey).catch(() => undefined);
  }

  return NextResponse.json({ ok: true });
}
