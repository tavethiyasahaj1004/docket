import { redirect } from "next/navigation";
import { AuthForm } from "@/app/(auth)/_components/auth-form";
import { getVerifiedSession } from "@/lib/authz";
import { isGoogleOAuthConfigured } from "@/lib/integration-settings";
import {
  getPlatformSettings,
  resolveBrandName,
  resolveLogoUrl,
} from "@/lib/settings";
import { hasAdminUser } from "@/lib/setup";

export const metadata = {
  title: "Sign in",
};

// Setup state and enabled login methods come from the database and are
// admin-toggleable at runtime — they must be read per request, never at build
// time (the Docker builder has no database, and a baked answer would go stale).
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // Fresh install with no admin yet — there's nothing to sign into. Send them
  // through the first-run wizard instead.
  if (!(await hasAdminUser())) {
    redirect("/setup");
  }

  // Must be the cache-bypassing read: a session that only exists in Better
  // Auth's cookie cache would bounce to /post-auth, which does a real user
  // lookup, fails it, and bounces back here — an infinite redirect loop.
  const session = await getVerifiedSession();
  if (session) {
    redirect("/post-auth");
  }

  const [settings, googleConfigured] = await Promise.all([
    getPlatformSettings(),
    isGoogleOAuthConfigured(),
  ]);

  return (
    <AuthForm
      brandName={resolveBrandName(settings.brandName)}
      googleEnabled={googleConfigured && settings.googleLoginEnabled}
      logoUrl={resolveLogoUrl(settings.logoKey)}
      magicLinkEnabled={settings.magicLinkEnabled}
      passwordLoginEnabled={settings.passwordLoginEnabled}
    />
  );
}
