/** One command that registers the Docket MCP endpoint with Claude Code. The
 * token is written into it literally: a `${VAR}` reference would be expanded
 * by bash before Claude Code saw it anyway, and PowerShell reads `${VAR}` as an
 * unset shell variable, which registered an empty `Bearer ` header. With no
 * `$` in it, the line runs unchanged in bash, zsh, PowerShell and cmd. */
export function buildClaudeCodeSetupSnippet(
  rawToken: string,
  mcpUrl: string
): string {
  return `claude mcp add --transport http docket ${mcpUrl} --header "Authorization: Bearer ${rawToken}"`;
}
