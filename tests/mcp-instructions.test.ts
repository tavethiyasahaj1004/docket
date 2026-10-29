import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { MCP_INSTRUCTIONS_MAX_CHARS } from "@/lib/mcp/limits";
import { MCP_INSTRUCTIONS } from "@/lib/mcp/server";

describe("MCP server instructions", () => {
  it("fit the cap", () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(
      MCP_INSTRUCTIONS_MAX_CHARS
    );
  });

  it("steer replies to drafts and say that close and reply need approval", () => {
    expect(MCP_INSTRUCTIONS).toContain("prefer `save_reply_draft`");
    expect(MCP_INSTRUCTIONS).toContain(
      "`close_ticket` and `reply_to_customer` only create a request that the token owner must approve in Docket."
    );
    expect(MCP_INSTRUCTIONS).toContain("`get_action_status`");
    expect(MCP_INSTRUCTIONS).toContain(
      "only after the user approved the exact text"
    );
    expect(MCP_INSTRUCTIONS).toContain(
      "Confirm with the user before closing, reopening or reassigning"
    );
  });

  it("say what search covers", () => {
    expect(MCP_INSTRUCTIONS).toContain(
      "- Search matches subject, customer name/email and ticket number only, not message bodies."
    );
  });

  it("only name tools that exist in this phase", () => {
    const named = [...MCP_INSTRUCTIONS.matchAll(/`([a-z_]+)`/g)].map(
      (m) => m[1]
    );
    for (const name of named) {
      expect([
        "whoami",
        "get_ticket_config",
        "save_reply_draft",
        "close_ticket",
        "reply_to_customer",
        "get_action_status",
      ]).toContain(name);
    }
  });
});
