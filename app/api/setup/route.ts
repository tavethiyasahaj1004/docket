import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { platformSettings } from "@/db/schema/settings";
import { AdminCreationError, createAdminUser } from "@/lib/bootstrap-admin";
import { db } from "@/lib/db";
import { seedDefaults } from "@/lib/seed-defaults";
import { hasAdminUser } from "@/lib/setup";

const VALID_THEMES = new Set([
  "default",
  "ocean",
  "forest",
  "sunset",
  "indigo",
  "slate",
]);
const VALID_APPEARANCES = new Set(["light", "dark", "auto"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SetupBody {
  appearanceMode?: string;
  brandName?: string;
  email?: string;
  name?: string;
  password?: string;
  theme?: string;
}

// POST — first-run bootstrap. Creates the very first admin, seeds defaults, and
// persists the chosen theme. Deliberately UNauthenticated (there's no admin to
// authenticate as yet) but self-disabling: the moment an admin exists it
// returns 403, so it can never be used to add a second admin on a live install.
export async function POST(request: NextRequest) {
  if (await hasAdminUser()) {
    return NextResponse.json(
      { error: "Setup has already been completed." },
      { status: 403 }
    );
  }

  let body: SetupBody;
  try {
    body = (await request.json()) as SetupBody;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const name = body.name?.trim() ?? "";
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";

  if (!name) {
    return NextResponse.json(
      { error: "Please enter your name." },
      { status: 400 }
    );
  }
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: "Please enter a valid email address." },
      { status: 400 }
    );
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters." },
      { status: 400 }
    );
  }

  const theme =
    body.theme && VALID_THEMES.has(body.theme) ? body.theme : "default";
  const appearanceMode =
    body.appearanceMode && VALID_APPEARANCES.has(body.appearanceMode)
      ? body.appearanceMode
      : "auto";
  const brandName = body.brandName?.trim().slice(0, 60) || null;

  try {
    await createAdminUser({ name, email, password });
  } catch (error) {
    if (error instanceof AdminCreationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  // Make the install fully usable in one shot: seed ticket config and persist
  // the theme picked in the wizard. Both are idempotent / safe if a prior
  // `pnpm setup` already ran them.
  await seedDefaults();

  const now = new Date();
  await db
    .insert(platformSettings)
    .values({
      id: "default",
      theme,
      appearanceMode,
      brandName,
      // Password login is on so the admin we just created can sign in with the
      // credentials they entered — no SMTP/OAuth required for the first login.
      passwordLoginEnabled: true,
      magicLinkEnabled: false,
      googleLoginEnabled: false,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: { theme, appearanceMode, brandName, updatedAt: now },
    });

  return NextResponse.json({ ok: true });
}
