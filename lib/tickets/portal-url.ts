import { eq } from "drizzle-orm";
import { apiKeys } from "@/db/schema";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

/** The customer-facing ticket link for emails and the create-ticket response.
 * A key carrying `portalUrlTemplate` points at the integrator's own page rather
 * than the built-in portal, so every caller should use this instead of
 * re-deriving it. Server-only, hence kept out of client-imported lib/tickets.ts. */
export async function resolveTicketPortalUrl(
  ticketId: string,
  customerToken: string,
  apiKeyId: string | null
): Promise<string> {
  const defaultUrl = `${env.NEXT_PUBLIC_APP_URL}/ticket/${ticketId}?token=${customerToken}`;
  if (!apiKeyId) {
    return defaultUrl;
  }
  const [key] = await db
    .select({ portalUrlTemplate: apiKeys.portalUrlTemplate })
    .from(apiKeys)
    .where(eq(apiKeys.id, apiKeyId))
    .limit(1);
  if (!key?.portalUrlTemplate) {
    return defaultUrl;
  }
  return key.portalUrlTemplate
    .replace(/\{\{\s*ticketId\s*\}\}/g, ticketId)
    .replace(/\{\{\s*token\s*\}\}/g, customerToken);
}
