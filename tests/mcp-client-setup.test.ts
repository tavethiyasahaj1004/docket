import { describe, expect, it } from "vitest";
import { buildClaudeCodeSetupSnippet } from "@/lib/mcp/client-setup";

describe("buildClaudeCodeSetupSnippet", () => {
  it("exports the token and registers the endpoint with a shell-expanded header", () => {
    expect(
      buildClaudeCodeSetupSnippet("dkm_abc", "https://help.example.com/api/mcp")
    ).toBe(
      [
        'export DOCKET_MCP_TOKEN="dkm_abc"',
        `claude mcp add --transport http docket https://help.example.com/api/mcp --header "Authorization: Bearer \${DOCKET_MCP_TOKEN}"`,
      ].join("\n")
    );
  });
});
