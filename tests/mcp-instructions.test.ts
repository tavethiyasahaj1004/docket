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

  it("mention no write tools", () => {
    for (const tool of [
      "save_reply_draft",
      "reply_to_customer",
      "close_ticket",
    ]) {
      expect(MCP_INSTRUCTIONS).not.toContain(tool);
    }
  });

  it("only name tools that exist in this phase", () => {
    const named = [...MCP_INSTRUCTIONS.matchAll(/`([a-z_]+)`/g)].map(
      (m) => m[1]
    );
    for (const name of named) {
      expect(["whoami", "get_ticket_config"]).toContain(name);
    }
  });
});
