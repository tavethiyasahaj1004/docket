import { requireAdmin } from "@/lib/authz";
import { McpAdminManager } from "./_components/mcp-admin-manager";

export const metadata = { title: "AI assistant (MCP)" };

export default async function McpAdminPage() {
  await requireAdmin();

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <McpAdminManager />
    </div>
  );
}
