import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { ConsentForm } from "@/app/(auth)/oauth/consent/_components/consent-form";
import { oauthClient } from "@/db/schema";
import { auth } from "@/lib/auth";
import { getVerifiedSession } from "@/lib/authz";
import { db } from "@/lib/db";
import { isMcpServing } from "@/lib/mcp/http";
import {
  assessOAuthUser,
  oauthGrantableScopes,
  splitScopes,
} from "@/lib/mcp/oauth-policy";
import { isOAuthAvailable } from "@/lib/oauth";
import {
  OAUTH_CHOOSABLE_SCOPES,
  OAUTH_DEFAULT_CHECKED,
  OAUTH_OFFLINE_SCOPE,
  OAUTH_SCOPE_LABELS,
} from "@/lib/oauth-scopes";
import {
  getPlatformSettings,
  resolveBrandName,
  resolveLogoUrl,
} from "@/lib/settings";

export const metadata = {
  title: "Connect an assistant",
};

// Signed OAuth query, session and settings are all per request.
export const dynamic = "force-dynamic";

function hostOf(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

export default async function OAuthConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const v of Array.isArray(value) ? value : value ? [value] : []) {
      query.append(key, v);
    }
  }

  const settings = await getPlatformSettings();
  const brand = {
    brandName: resolveBrandName(settings.brandName),
    logoUrl: resolveLogoUrl(settings.logoKey),
  };

  if (!(isOAuthAvailable() && isMcpServing(settings))) {
    return (
      <ConsentForm
        {...brand}
        problem="Connecting assistants is not enabled on this server."
      />
    );
  }

  const session = await getVerifiedSession();
  if (!session) {
    // Sign in first; the login page keeps the signed query so the provider can
    // resume this authorization afterwards.
    redirect(`/login?${query.toString()}`);
  }

  const secret = (await auth.$context).secret;
  if (
    !(
      query.has("sig") &&
      (await verifyOAuthQueryParams(query.toString(), secret))
    )
  ) {
    return (
      <ConsentForm
        {...brand}
        problem="This authorization request is invalid or has expired. Start the connection again from your assistant."
      />
    );
  }

  const clientId = query.get("client_id") ?? "";
  const [client] = await db
    .select({ name: oauthClient.name, disabled: oauthClient.disabled })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  if (!client || client.disabled === true) {
    return (
      <ConsentForm
        {...brand}
        problem="This application is not available. Start the connection again from your assistant."
      />
    );
  }

  const assessment = await assessOAuthUser(
    session.user.id,
    (session.session as { impersonatedBy?: string | null }).impersonatedBy
  );
  const requested = splitScopes(query.get("scope"));
  const grantable = new Set(
    assessment.ok ? oauthGrantableScopes(assessment.role) : []
  );
  const scopes = OAUTH_CHOOSABLE_SCOPES.filter(
    (scope) => requested.includes(scope) && grantable.has(scope)
  ).map((scope) => ({
    id: scope,
    label: OAUTH_SCOPE_LABELS[scope].label,
    description: OAUTH_SCOPE_LABELS[scope].description,
    checked: OAUTH_DEFAULT_CHECKED.includes(scope),
  }));

  let blocked: string | null = null;
  if (!assessment.ok) {
    blocked =
      assessment.reason === "impersonated"
        ? "You are viewing Docket as another user. Assistants can't be connected from an impersonated session. Stop impersonating, then try again."
        : "Your account isn't permitted to connect an assistant.";
  } else if (scopes.length === 0) {
    blocked =
      "This application asked for permissions that your role can't grant.";
  }

  return (
    <ConsentForm
      {...brand}
      blocked={blocked}
      clientHost={hostOf(clientId)}
      clientName={client.name ?? clientId}
      offline={requested.includes(OAUTH_OFFLINE_SCOPE)}
      redirectHost={hostOf(query.get("redirect_uri"))}
      scopes={scopes}
      userEmail={session.user.email}
      userName={session.user.name}
    />
  );
}
