import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins/admin";
import { jwt } from "better-auth/plugins/jwt";
import { magicLink } from "better-auth/plugins/magic-link";
import { eq } from "drizzle-orm";
import { ADMIN_ROLE } from "@/config/platform";
import * as schema from "@/db/schema";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { enqueueEmail } from "@/lib/email";
import { magicLinkTemplate } from "@/lib/email/templates/magic-link";
import { resetPasswordTemplate } from "@/lib/email/templates/reset-password";
import { env } from "@/lib/env";
import { getGoogleOAuthSettings } from "@/lib/integration-settings";
import { isMcpServing } from "@/lib/mcp/http";
import {
  assessOAuthUser,
  splitScopes,
  ungrantableOAuthScopes,
} from "@/lib/mcp/oauth-policy";
import {
  isOAuthAvailable,
  MCP_OAUTH_RESOURCE,
  OAUTH_DEFAULT_SCOPES,
  OAUTH_SCOPES,
} from "@/lib/oauth";
import { getEmailBranding, getPlatformSettings } from "@/lib/settings";

// Resolved once per process into the betterAuth() singleton, since Better Auth
// builds `socialProviders` synchronously — so Google credentials changed via
// /admin/integrations need a restart. Must never throw: `next build` imports
// this against a placeholder DATABASE_URL.
let googleOAuth: Awaited<ReturnType<typeof getGoogleOAuthSettings>> = null;
try {
  googleOAuth = await getGoogleOAuthSettings();
} catch (error) {
  console.warn(
    "[auth] Could not resolve Google OAuth settings at startup — Google sign-in disabled until next restart.",
    error
  );
}

// OAuth 2.1 sign-in for the MCP endpoint (Release 4) needs a trustworthy
// transport, so it is registered only when NEXT_PUBLIC_APP_URL is https or a
// loopback host; any other deployment keeps working with personal access tokens
// alone. @better-auth/mcp throws at construction for a non-https, non-loopback
// resource, so the guard has to run before it is called.
const oauthEnabled = isOAuthAvailable();
if (!oauthEnabled) {
  console.warn(
    "[auth] OAuth for MCP is disabled: NEXT_PUBLIC_APP_URL is neither https nor a loopback host. MCP clients can still use personal access tokens."
  );
}

/** The access-token signing key, the OAuth provider (mcp() IS the provider; a
 * separate oauthProvider() must never be added) and Client ID Metadata
 * Documents. Dynamic client registration is deliberately off, no client may
 * skip consent, and only authorization_code + refresh_token are enabled. */
function buildOAuthPlugins() {
  return [
    jwt({
      // The provider signs access tokens; the plugin must not also hand out
      // session JWTs in a response header.
      disableSettingJwtHeader: true,
      jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } },
    }),
    mcp({
      resource: MCP_OAUTH_RESOURCE,
      loginPage: "/login",
      consentPage: "/oauth/consent",
      scopes: [...OAUTH_SCOPES],
      grantTypes: ["authorization_code", "refresh_token"],
      clientRegistrationDefaultScopes: [...OAUTH_DEFAULT_SCOPES],
      clientRegistrationAllowedScopes: [...OAUTH_SCOPES],
      // Clients arrive through CIMD, never by hand, and app/api/auth does not
      // route any client or resource management endpoint. Should one ever be
      // reached, only an admin may manage clients and resources.
      clientPrivileges: ({ user }) => user?.role === ADMIN_ROLE,
      resourcePrivileges: ({ user }) => user?.role === ADMIN_ROLE,
    }),
    cimd({
      fetchClientMetadataResource,
      metadataProfile: "mcp-2026-07-28",
    }),
  ];
}

/** True when the OAuth endpoints must refuse because the admin MCP switch is off
 * (or the https requirement is not met). */
async function oauthRefused(): Promise<boolean> {
  return !isMcpServing(await getPlatformSettings());
}

const OAUTH_GATED_PATHS = new Set([
  "/oauth2/authorize",
  "/oauth2/token",
  "/oauth2/consent",
  "/oauth2/continue",
  "/oauth2/revoke",
]);

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

function notGrantable(refused: string[]) {
  return new APIError("FORBIDDEN", {
    message: `These permissions are not available to your role: ${refused.join(", ")}`,
  });
}

/** Server-side control for accepting consent; the consent page only mirrors it.
 * Refuses unless the signed-in user is a live agent/admin on a non-impersonated
 * session and every scope being granted fits their role. */
async function enforceConsentPolicy(ctx: HookContext) {
  const session = await getAuthoritativeSessionFromCtx(ctx);
  if (!session?.session) {
    return; // the endpoint answers 401 itself
  }
  const body = ctx.body as { scope?: unknown; oauth_query?: unknown };
  const assessment = await assessOAuthUser(
    session.user.id,
    (session.session as { impersonatedBy?: string | null }).impersonatedBy
  );
  if (!assessment.ok) {
    throw new APIError("FORBIDDEN", {
      message:
        assessment.reason === "impersonated"
          ? "Access cannot be granted from an impersonated session."
          : "This account is not permitted to connect an assistant.",
    });
  }

  let granted: string[] = [];
  if (typeof body.scope === "string") {
    granted = splitScopes(body.scope);
  } else if (typeof body.oauth_query === "string") {
    if (!(await verifyOAuthQueryParams(body.oauth_query, ctx.context.secret))) {
      throw new APIError("BAD_REQUEST", { error: "invalid_signature" });
    }
    granted = splitScopes(new URLSearchParams(body.oauth_query).get("scope"));
  }
  const refused = ungrantableOAuthScopes(assessment.role, granted);
  if (refused.length > 0) {
    throw notGrantable(refused);
  }
}

/** Runs for every verification row; only authorization codes are inspected. */
async function enforceCodePolicy(rawValue: string | null | undefined) {
  if (
    typeof rawValue !== "string" ||
    !rawValue.includes("authorization_code")
  ) {
    return;
  }
  let value: {
    type?: string;
    userId?: string;
    sessionId?: string;
    query?: { scope?: string };
  };
  try {
    value = JSON.parse(rawValue);
  } catch {
    return;
  }
  if (value.type !== "authorization_code") {
    return;
  }
  const [row] = value.sessionId
    ? await db
        .select({ impersonatedBy: schema.session.impersonatedBy })
        .from(schema.session)
        .where(eq(schema.session.id, value.sessionId))
        .limit(1)
    : [];
  const assessment = value.userId
    ? await assessOAuthUser(value.userId, row?.impersonatedBy)
    : ({ ok: false, reason: "not_permitted" } as const);
  if (!assessment.ok) {
    throw new APIError("FORBIDDEN", {
      message: "This account is not permitted to connect an assistant.",
    });
  }
  const refused = ungrantableOAuthScopes(
    assessment.role,
    splitScopes(value.query?.scope)
  );
  if (refused.length > 0) {
    throw notGrantable(refused);
  }
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      ...(oauthEnabled
        ? {
            jwks: schema.jwks,
            oauthClient: schema.oauthClient,
            oauthResource: schema.oauthResource,
            oauthClientResource: schema.oauthClientResource,
            oauthRefreshToken: schema.oauthRefreshToken,
            oauthAccessToken: schema.oauthAccessToken,
            oauthConsent: schema.oauthConsent,
            oauthClientAssertion: schema.oauthClientAssertion,
          }
        : {}),
    },
  }),
  secret: env.APP_SECRET,
  baseURL: env.NEXT_PUBLIC_APP_URL,
  emailAndPassword: {
    enabled: true,
    // Self-hosted installs may not have SMTP configured yet — password login
    // must work as a zero-dependency bootstrap path (see scripts/create-admin.ts).
    requireEmailVerification: false,
    minPasswordLength: 8,
    sendResetPassword: async ({ user, url }) => {
      const { html, text } = await resetPasswordTemplate({
        email: user.email,
        resetUrl: url,
      });

      const { productName } = await getEmailBranding();
      await enqueueEmail({
        to: user.email,
        subject: `Reset your ${productName} password`,
        html,
        text,
      });

      await audit({
        action: "auth.password_reset_requested",
        actorEmail: user.email,
        description: `Password reset requested for ${user.email}`,
        entityType: "user",
        metadata: { email: user.email },
      });
    },
  },
  socialProviders: {
    ...(googleOAuth
      ? {
          google: {
            clientId: googleOAuth.clientId,
            clientSecret: googleOAuth.clientSecret,
          },
        }
      : {}),
  },
  // The jwt plugin's GET /token turns any session into a JWT signed by the same
  // keys as access tokens. Nothing needs it, so it is not routable.
  disabledPaths: oauthEnabled ? ["/token"] : [],
  plugins: [
    admin({
      impersonationSessionDuration: 3600,
      allowImpersonatingAdmins: false,
    }),
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        const { html, text } = await magicLinkTemplate({
          email,
          magicLinkUrl: url,
        });

        const { productName } = await getEmailBranding();
        await enqueueEmail({
          to: email,
          subject: `Sign in to ${productName}`,
          html,
          text,
        });

        await audit({
          action: "auth.magic_link_sent",
          actorEmail: email,
          description: `Magic link sent to ${email}`,
          entityType: "user",
          metadata: { email },
        });
      },
    }),
    // Typed as if registered; empty at runtime when OAuth is unavailable.
    ...((oauthEnabled ? buildOAuthPlugins() : []) as unknown as ReturnType<
      typeof buildOAuthPlugins
    >),
    // Must be last: patches auth.api.* calls from Server Actions and Route
    // Handlers to actually forward Set-Cookie via next/headers. Without it they
    // compute the right cookie changes but never apply them, so the browser
    // keeps still-valid session cookies after "signing out" until they expire.
    nextCookies(),
  ],
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 60,
    },
  },
  hooks: {
    // Enforce the admin-configured sign-in method toggles server-side — not
    // just hiding the button in the UI — so a disabled method can't be used
    // by posting directly to the API.
    before: createAuthMiddleware(async (ctx) => {
      // Defense in depth behind the route wrapper in app/api/auth: with MCP off
      // (or no https) every OAuth endpoint refuses, whoever mounts the handler.
      if (OAUTH_GATED_PATHS.has(ctx.path) && (await oauthRefused())) {
        throw new APIError("FORBIDDEN", {
          message: "MCP is disabled on this server.",
        });
      }
      if (ctx.path === "/oauth2/authorize") {
        // Docket has one protected resource, so a request that names none is
        // for it. Without a resource the provider would mint an opaque token
        // that /api/mcp does not accept; with it, a JWT bound to the endpoint.
        const isPost = ctx.method === "POST";
        const source = (isPost ? ctx.body : ctx.query) as
          | Record<string, unknown>
          | undefined;
        if (source && typeof source === "object" && !("resource" in source)) {
          const patched = { ...source, resource: MCP_OAUTH_RESOURCE };
          return { context: isPost ? { body: patched } : { query: patched } };
        }
      }
      if (ctx.path === "/oauth2/consent" && ctx.body?.accept === true) {
        await enforceConsentPolicy(ctx);
        return;
      }
      const isPasswordSignIn = ctx.path === "/sign-in/email";
      const isMagicLinkRequest = ctx.path === "/sign-in/magic-link";
      const isSocialSignIn = ctx.path === "/sign-in/social";
      const isPasswordReset =
        ctx.path === "/request-password-reset" ||
        ctx.path === "/reset-password";
      if (
        !(
          isPasswordSignIn ||
          isMagicLinkRequest ||
          isSocialSignIn ||
          isPasswordReset
        )
      ) {
        return;
      }

      const settings = await getPlatformSettings();
      if (isPasswordSignIn && !settings.passwordLoginEnabled) {
        throw new APIError("FORBIDDEN", {
          message: "Password sign-in is disabled.",
        });
      }
      if (isMagicLinkRequest && !settings.magicLinkEnabled) {
        throw new APIError("FORBIDDEN", {
          message: "Magic link sign-in is disabled.",
        });
      }
      if (isSocialSignIn && !settings.googleLoginEnabled) {
        throw new APIError("FORBIDDEN", {
          message: "Google sign-in is disabled.",
        });
      }
      // Nothing to reset into if password login itself is off.
      if (isPasswordReset && !settings.passwordLoginEnabled) {
        throw new APIError("FORBIDDEN", {
          message: "Password sign-in is disabled.",
        });
      }
    }),
  },
  databaseHooks: {
    // The single place an authorization code comes into existence, whichever
    // endpoint (authorize, consent, a post-login resume) reached it: the
    // signed-in user must be a live agent/admin on a real (not impersonated)
    // session, and the scope the code carries must fit the role ceiling.
    verification: {
      create: {
        before: async (verification) => {
          await enforceCodePolicy(verification.value);
        },
      },
    },
    user: {
      create: {
        after: async (user) => {
          await audit({
            action: "user.created",
            actorEmail: user.email,
            actorId: user.id,
            description: `User created: ${user.email}`,
            entityId: user.id,
            entityType: "user",
          });
        },
      },
    },
  },
});
