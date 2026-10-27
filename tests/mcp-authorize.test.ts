import { describe, expect, it } from "vitest";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { canUseTool, permittedToolNames } from "@/lib/mcp/authorize";
import type { McpScope } from "@/lib/mcp-tokens";

function principal(scopes: McpScope[], role = "agent"): McpPrincipal {
  return {
    userId: "u1",
    name: "Alice",
    email: "alice@example.test",
    role,
    scopes,
    authMethod: "pat",
    credentialId: "c1",
    credentialName: "laptop",
    credentialExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

const AGENT_TOOLS = [
  "whoami",
  "get_ticket_config",
  "list_tickets",
  "get_ticket",
  "get_ticket_thread",
  "get_customer",
  "list_agents",
  "search_canned_responses",
  "get_ticket_stats",
];

describe("permittedToolNames", () => {
  it("lists the nine agent tools, in registry order, for the default scopes", () => {
    const names = permittedToolNames(
      principal(["tickets:read", "customers:read"])
    );
    expect(names).toEqual(AGENT_TOOLS);
    expect(names).toHaveLength(9);
  });

  it("lists all ten tools for an admin with the three read scopes", () => {
    const names = permittedToolNames(
      principal(["tickets:read", "customers:read", "reports:read"], "admin")
    );
    expect(names).toEqual([...AGENT_TOOLS, "get_report"]);
    expect(names).toHaveLength(10);
  });

  it("never lists get_report for an agent, even if the token carries reports:read", () => {
    const names = permittedToolNames(
      principal(["tickets:read", "customers:read", "reports:read"], "agent")
    );
    expect(names).not.toContain("get_report");
  });

  it("does not list get_customer without customers:read", () => {
    const names = permittedToolNames(principal(["tickets:read"]));
    expect(names).not.toContain("get_customer");
    expect(names).toEqual(AGENT_TOOLS.filter((n) => n !== "get_customer"));
  });

  it("lists only whoami and get_customer without tickets:read", () => {
    expect(permittedToolNames(principal(["customers:read"]))).toEqual([
      "whoami",
      "get_customer",
    ]);
    expect(permittedToolNames(principal([]))).toEqual(["whoami"]);
  });

  it("does not turn tickets:read_internal into a tool", () => {
    expect(permittedToolNames(principal(["tickets:read_internal"]))).toEqual([
      "whoami",
    ]);
  });

  it("lists nothing for an ineligible role", () => {
    for (const role of ["", "user", "customer", "agent,admin", "Admin"]) {
      expect(
        permittedToolNames(
          principal(["tickets:read", "customers:read", "reports:read"], role)
        )
      ).toEqual([]);
    }
  });
});

describe("canUseTool", () => {
  it("denies unknown tools", () => {
    expect(canUseTool(principal(["tickets:read"]), "close_ticket")).toBe(false);
  });

  it("checks the scope per tool", () => {
    const p = principal(["customers:read"]);
    expect(canUseTool(p, "whoami")).toBe(true);
    expect(canUseTool(p, "get_ticket_config")).toBe(false);
    expect(canUseTool(p, "get_customer")).toBe(true);
    expect(canUseTool(p, "list_tickets")).toBe(false);
  });

  it("requires the admin role on top of reports:read for get_report", () => {
    expect(canUseTool(principal(["reports:read"], "admin"), "get_report")).toBe(
      true
    );
    expect(canUseTool(principal(["reports:read"], "agent"), "get_report")).toBe(
      false
    );
    expect(canUseTool(principal(["tickets:read"], "admin"), "get_report")).toBe(
      false
    );
  });

  it("re-checks the role on every call", () => {
    expect(canUseTool(principal(["tickets:read"], "customer"), "whoami")).toBe(
      false
    );
  });
});
