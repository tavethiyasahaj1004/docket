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

describe("permittedToolNames", () => {
  it("lists both tools, in registry order, for read scopes", () => {
    expect(
      permittedToolNames(principal(["tickets:read", "customers:read"]))
    ).toEqual(["whoami", "get_ticket_config"]);
  });

  it("lists only whoami without tickets:read", () => {
    expect(permittedToolNames(principal(["customers:read"]))).toEqual([
      "whoami",
    ]);
    expect(permittedToolNames(principal([]))).toEqual(["whoami"]);
  });

  it("lists nothing for an ineligible role", () => {
    for (const role of ["", "user", "customer", "agent,admin", "Admin"]) {
      expect(permittedToolNames(principal(["tickets:read"], role))).toEqual([]);
    }
  });

  it("admins are eligible too", () => {
    expect(permittedToolNames(principal(["tickets:read"], "admin"))).toEqual([
      "whoami",
      "get_ticket_config",
    ]);
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
  });

  it("re-checks the role on every call", () => {
    expect(canUseTool(principal(["tickets:read"], "customer"), "whoami")).toBe(
      false
    );
  });
});
