import { redirect } from "next/navigation";
import { AuthForm } from "@/app/(auth)/_components/auth-form";
import { getVerifiedSession } from "@/lib/authz";
import { isGoogleOAuthConfigured } from "@/lib/integration-settings";
import { isOAuthContinuationQuery } from "@/lib/oauth-scopes";
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

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Fresh install with no admin yet — there's nothing to sign into. Send them
  // through the first-run wizard instead.
  if (!(await hasAdminUser())) {
    redirect("/setup");
  }

  // Must be the cache-bypassing read: a session that only exists in Better
  // Auth's cookie cache would bounce to /post-auth, which does a real user
  // lookup, fails it, and bounces back here — an infinite redirect loop.
  const session = await getVerifiedSession();
  // An assistant sent the browser here to sign in (signed OAuth query in the
  // URL): show the form even when a session exists, because the provider asked
  // for a fresh sign-in, and /post-auth would drop the authorization.
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const v of Array.isArray(value) ? value : value ? [value] : []) {
      query.append(key, v);
    }
  }
  if (session && !isOAuthContinuationQuery(query)) {
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
