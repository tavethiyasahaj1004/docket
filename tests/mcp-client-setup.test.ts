import { describe, expect, it } from "vitest";
import { buildClaudeCodeSetupSnippet } from "@/lib/mcp/client-setup";

describe("buildClaudeCodeSetupSnippet", () => {
  it("registers the endpoint in one command with the token written in", () => {
    expect(
      buildClaudeCodeSetupSnippet("dkm_abc", "https://help.example.com/api/mcp")
    ).toBe(
      'claude mcp add --transport http docket https://help.example.com/api/mcp --header "Authorization: Bearer dkm_abc"'
    );
  });

  it("leaves nothing for a shell to expand", () => {
    const snippet = buildClaudeCodeSetupSnippet(
      "dkm_abc",
      "https://help.example.com/api/mcp"
    );
    expect(snippet).not.toContain("$");
    expect(snippet).not.toContain("\n");
  });
});
