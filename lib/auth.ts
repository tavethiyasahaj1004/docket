import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins/admin";
import { magicLink } from "better-auth/plugins/magic-link";
import * as schema from "@/db/schema";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { enqueueEmail } from "@/lib/email";
import { magicLinkTemplate } from "@/lib/email/templates/magic-link";
import { resetPasswordTemplate } from "@/lib/email/templates/reset-password";
import { env } from "@/lib/env";
import { getGoogleOAuthSettings } from "@/lib/integration-settings";
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

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
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
