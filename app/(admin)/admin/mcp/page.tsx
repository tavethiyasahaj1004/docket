import { requireAdmin } from "@/lib/authz";
import { listPendingActionsForAdmin } from "@/lib/mcp/pending-actions";
import { isOAuthAvailable } from "@/lib/oauth";
import { McpAdminManager } from "./_components/mcp-admin-manager";
import { McpOAuthSection } from "./_components/mcp-oauth-section";
import { McpPendingActionsList } from "./_components/mcp-pending-actions-list";

export const metadata = { title: "AI assistant (MCP)" };

export default async function McpAdminPage() {
  await requireAdmin();
  const pendingActions = await listPendingActionsForAdmin();

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <McpAdminManager />
      {isOAuthAvailable() && <McpOAuthSection />}
      <McpPendingActionsList actions={pendingActions} />
    </div>
  );
}
