import { eq } from "drizzle-orm";
import { cache } from "react";
import { PRODUCT_NAME } from "@/config/platform";
import { platformSettings } from "@/db/schema/settings";
import { db } from "@/lib/db";
import { DEFAULT_EMAIL_ACCENT } from "@/lib/email/components/layout";
import { env } from "@/lib/env";
import { storage } from "@/lib/storage";
import {
  DEFAULT_TICKET_ACTION_SETTINGS,
  pickTicketActionSettings,
  type TicketActionSettings,
} from "@/lib/ticket-actions";
import {
  type AttachmentLimits,
  DEFAULT_ATTACHMENT_LIMITS,
  resolveAttachmentLimits,
} from "@/lib/tickets/attachment-limits";

// cache() dedupes repeat calls within one request — the root layout,
// generateMetadata, and the agent/admin layouts each read this independently.
// Outside a React render (e.g. the pg-boss worker calling getEmailBranding),
// cache() is a harmless no-op passthrough.
export const getPlatformSettings = cache(async () => {
  const [row] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.id, "default"))
    .limit(1);
  return (
    row ?? {
      theme: "default",
      appearanceMode: "auto" as const,
      // Fresh install: only password is on until an admin explicitly enables
      // magic link/Google from /admin/appearance — matches pnpm create:admin
      // being the zero-dependency bootstrap path (no SMTP/OAuth required).
      passwordLoginEnabled: true,
      magicLinkEnabled: false,
      googleLoginEnabled: false,
      ticketEmailNotificationsEnabled: true,
      mcpEnabled: false,
      ...DEFAULT_TICKET_ACTION_SETTINGS,
      attachmentMaxPerMessage: DEFAULT_ATTACHMENT_LIMITS.maxPerMessage,
      attachmentMaxFileSizeMb: DEFAULT_ATTACHMENT_LIMITS.maxFileSizeMb,
      attachmentMaxPerTicketSizeMb:
        DEFAULT_ATTACHMENT_LIMITS.maxPerTicketSizeMb,
      brandName: null as string | null,
      logoKey: null as string | null,
      faviconKey: null as string | null,
      emailAccentColor: null as string | null,
    }
  );
});

/** Admin switches for merge / split / link and their notifications. */
export async function getTicketActionSettings(): Promise<TicketActionSettings> {
  return pickTicketActionSettings(await getPlatformSettings());
}

/** Effective attachment caps. Re-read from the DB per request (cache() only
 * dedupes within one), so an admin's change applies without a redeploy. */
export async function getAttachmentLimits(): Promise<AttachmentLimits> {
  return resolveAttachmentLimits(await getPlatformSettings());
}

/** The configured brand name, or the PRODUCT_NAME default when unset. */
export function resolveBrandName(brandName: string | null | undefined): string {
  return brandName?.trim() ? brandName.trim() : PRODUCT_NAME;
}

/** The configured logo's serving URL, or null when unset (callers fall back to a
 * text wordmark). `absolute` prefixes the base URL and is required for email;
 * omit it for in-app <img> tags, which need only the relative path. */
export function resolveLogoUrl(
  logoKey: string | null | undefined,
  absolute = false
): string | null {
  if (!logoKey) {
    return null;
  }
  const path = storage.url(logoKey);
  return absolute ? `${env.NEXT_PUBLIC_APP_URL}${path}` : path;
}

/** The configured favicon's serving URL. Falls back to the logo (fine when it's
 * already square/icon-only), then to the static public/favicon.ico default. */
export function resolveFaviconUrl(
  faviconKey: string | null | undefined,
  logoKey: string | null | undefined
): string | null {
  return resolveLogoUrl(faviconKey ?? logoKey);
}

/** The configured email accent color (hex), or the built-in default when unset. */
export function resolveEmailAccentColor(
  accentColor: string | null | undefined
): string {
  return accentColor?.trim() || DEFAULT_EMAIL_ACCENT;
}

/** Brand name + absolute logo URL + accent color for outgoing emails. */
export async function getEmailBranding(): Promise<{
  productName: string;
  logoUrl: string | null;
  accentColor: string;
}> {
  const settings = await getPlatformSettings();
  return {
    productName: resolveBrandName(settings.brandName),
    logoUrl: resolveLogoUrl(settings.logoKey, true),
    accentColor: resolveEmailAccentColor(settings.emailAccentColor),
  };
}
