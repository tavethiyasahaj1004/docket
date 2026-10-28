import { requireAdmin } from "@/lib/authz";
import { listPendingActionsForAdmin } from "@/lib/mcp/pending-actions";
import { McpAdminManager } from "./_components/mcp-admin-manager";
import { McpPendingActionsList } from "./_components/mcp-pending-actions-list";

export const metadata = { title: "AI assistant (MCP)" };

export default async function McpAdminPage() {
  await requireAdmin();
  const pendingActions = await listPendingActionsForAdmin();

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <McpAdminManager />
      <McpPendingActionsList actions={pendingActions} />
    </div>
  );
}
