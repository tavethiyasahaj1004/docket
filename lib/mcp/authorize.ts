import type { McpPrincipal } from "@/lib/mcp/auth";
import { isEligibleMcpRole, type McpScope } from "@/lib/mcp-tokens";

type ToolPolicy = {
  name: string;
  /** Scope the token must hold; null = any valid principal. An array means
   * ANY of the scopes (the token needs at least one). */
  scope: McpScope | readonly McpScope[] | null;
  /** Role the owner must currently hold, on top of the scope. */
  role?: "admin";
};

// The order here is the order tools are registered and listed in.
const TOOL_REGISTRY: readonly ToolPolicy[] = [
  { name: "whoami", scope: null },
  { name: "get_ticket_config", scope: "tickets:read" },
  { name: "list_tickets", scope: "tickets:read" },
  { name: "get_ticket", scope: "tickets:read" },
  { name: "get_ticket_thread", scope: "tickets:read" },
  { name: "get_customer", scope: "customers:read" },
  { name: "list_agents", scope: "tickets:read" },
  { name: "search_canned_responses", scope: "tickets:read" },
  { name: "get_ticket_stats", scope: "tickets:read" },
  { name: "get_report", scope: "reports:read", role: "admin" },
  { name: "save_reply_draft", scope: "tickets:write" },
  { name: "add_internal_note", scope: "tickets:write" },
  { name: "update_ticket_tags", scope: "tickets:write" },
  { name: "update_ticket_fields", scope: "tickets:write" },
  { name: "assign_ticket", scope: "tickets:manage" },
  { name: "set_ticket_status", scope: "tickets:manage" },
  { name: "close_ticket", scope: "tickets:manage" },
  { name: "reopen_ticket", scope: "tickets:manage" },
  // Also needs the admin setting (customer replies via MCP); that is read when
  // the server is built, not here, so these functions stay pure.
  { name: "reply_to_customer", scope: "tickets:reply" },
  { name: "get_action_status", scope: ["tickets:manage", "tickets:reply"] },
];

/** Tools that exist only while an admin setting is on. */
export const REPLY_GATED_TOOLS: readonly string[] = ["reply_to_customer"];

/** The role is re-checked on every call (it comes from the database via the
 * principal, never from the client), as is the scope. */
export function canUseTool(principal: McpPrincipal, name: string): boolean {
  const tool = TOOL_REGISTRY.find((t) => t.name === name);
  if (!tool) {
    return false;
  }
  if (!isEligibleMcpRole(principal.role)) {
    return false;
  }
  if (tool.role !== undefined && principal.role !== tool.role) {
    return false;
  }
  if (tool.scope === null) {
    return true;
  }
  const needed = Array.isArray(tool.scope) ? tool.scope : [tool.scope];
  return needed.some((scope) => principal.scopes.includes(scope));
}

/** Names of the tools this principal may use, in registry order. */
export function permittedToolNames(principal: McpPrincipal): string[] {
  return TOOL_REGISTRY.filter((t) => canUseTool(principal, t.name)).map(
    (t) => t.name
  );
}
