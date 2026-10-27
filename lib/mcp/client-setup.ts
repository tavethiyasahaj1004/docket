/** Shell snippet that registers the Docket MCP endpoint with Claude Code. The
 * `${DOCKET_MCP_TOKEN}` reference is left for the user's shell to expand. */
export function buildClaudeCodeSetupSnippet(
  rawToken: string,
  mcpUrl: string
): string {
  return [
    `export DOCKET_MCP_TOKEN="${rawToken}"`,
    `claude mcp add --transport http docket ${mcpUrl} --header "Authorization: Bearer \${DOCKET_MCP_TOKEN}"`,
  ].join("\n");
}
