import { eq } from "drizzle-orm";
import { platformSettings } from "@/db/schema/settings";
import { db } from "@/lib/db";

/** Whether an admin has allowed customer replies over MCP
 * (`platform_settings.mcp_customer_replies_enabled`, off by default). A fresh
 * read every time, never cached: the setting is checked when a server is built
 * for a request, again inside the reply tool, and the approval path checks it in
 * its own compare-and-set. */
export async function isCustomerRepliesEnabled(): Promise<boolean> {
  const [row] = await db
    .select({ enabled: platformSettings.mcpCustomerRepliesEnabled })
    .from(platformSettings)
    .where(eq(platformSettings.id, "default"))
    .limit(1);
  return row?.enabled ?? false;
}
