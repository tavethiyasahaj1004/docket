import type { McpPrincipal } from "@/lib/mcp/auth";
import { isEligibleMcpRole, type McpScope } from "@/lib/mcp-tokens";

type ToolPolicy = {
  name: string;
  /** Scope the token must hold; null = any valid principal. */
  scope: McpScope | null;
};

// The order here is the order tools are registered and listed in.
const TOOL_REGISTRY: readonly ToolPolicy[] = [
  { name: "whoami", scope: null },
  { name: "get_ticket_config", scope: "tickets:read" },
];

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
  return tool.scope === null || principal.scopes.includes(tool.scope);
}

/** Names of the tools this principal may use, in registry order. */
export function permittedToolNames(principal: McpPrincipal): string[] {
  return TOOL_REGISTRY.filter((t) => canUseTool(principal, t.name)).map(
    (t) => t.name
  );
}
