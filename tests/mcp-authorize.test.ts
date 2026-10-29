import { describe, expect, it } from "vitest";
import type { McpPrincipal } from "@/lib/mcp/auth";
import {
  canUseTool,
  permittedToolNames,
  REPLY_GATED_TOOLS,
} from "@/lib/mcp/authorize";
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

const WRITE_TOOLS = [
  "save_reply_draft",
  "add_internal_note",
  "update_ticket_tags",
  "update_ticket_fields",
];

describe("tickets:write tools", () => {
  it("lists the four write tools, after the read tools, for tickets:write", () => {
    const names = permittedToolNames(
      principal(["tickets:read", "customers:read", "tickets:write"])
    );
    expect(names).toEqual([...AGENT_TOOLS, ...WRITE_TOOLS]);
    expect(names).toHaveLength(13);
  });

  it("lists them after get_report for an admin holding every issuable scope", () => {
    const names = permittedToolNames(
      principal(
        ["tickets:read", "customers:read", "tickets:write", "reports:read"],
        "admin"
      )
    );
    expect(names).toEqual([...AGENT_TOOLS, "get_report", ...WRITE_TOOLS]);
  });

  it("lists nothing extra for a read-only token", () => {
    const names = permittedToolNames(
      principal(["tickets:read", "customers:read"])
    );
    for (const tool of WRITE_TOOLS) {
      expect(names).not.toContain(tool);
      expect(
        canUseTool(principal(["tickets:read", "customers:read"]), tool)
      ).toBe(false);
    }
  });

  it("needs only tickets:write, not tickets:read", () => {
    expect(permittedToolNames(principal(["tickets:write"]))).toEqual([
      "whoami",
      ...WRITE_TOOLS,
    ]);
  });

  it("is not unlocked by tickets:manage or tickets:reply", () => {
    for (const tool of WRITE_TOOLS) {
      expect(
        canUseTool(principal(["tickets:manage", "tickets:reply"]), tool)
      ).toBe(false);
    }
  });
});

const MANAGE_TOOLS = [
  "assign_ticket",
  "set_ticket_status",
  "close_ticket",
  "reopen_ticket",
];

describe("tickets:manage and tickets:reply tools", () => {
  it("lists the manage tools and get_action_status for tickets:manage, in registry order", () => {
    expect(permittedToolNames(principal(["tickets:manage"]))).toEqual([
      "whoami",
      ...MANAGE_TOOLS,
      "get_action_status",
    ]);
  });

  it("lists reply_to_customer and get_action_status for tickets:reply", () => {
    expect(permittedToolNames(principal(["tickets:reply"]))).toEqual([
      "whoami",
      "reply_to_customer",
      "get_action_status",
    ]);
  });

  it("lists everything, once and in order, for both scopes", () => {
    expect(
      permittedToolNames(principal(["tickets:reply", "tickets:manage"]))
    ).toEqual([
      "whoami",
      ...MANAGE_TOOLS,
      "reply_to_customer",
      "get_action_status",
    ]);
  });

  it("treats get_action_status as any-of its two scopes", () => {
    const status = (scopes: McpScope[]) =>
      canUseTool(principal(scopes), "get_action_status");
    expect(status(["tickets:manage"])).toBe(true);
    expect(status(["tickets:reply"])).toBe(true);
    expect(status(["tickets:read", "tickets:write", "customers:read"])).toBe(
      false
    );
  });

  it("keeps the other tools single-scope", () => {
    const p = principal(["tickets:reply"]);
    for (const tool of MANAGE_TOOLS) {
      expect(canUseTool(p, tool)).toBe(false);
    }
    expect(canUseTool(principal(["tickets:manage"]), "reply_to_customer")).toBe(
      false
    );
  });

  it("lists them after the write tools", () => {
    const names = permittedToolNames(
      principal([
        "tickets:read",
        "customers:read",
        "tickets:write",
        "tickets:manage",
        "tickets:reply",
      ])
    );
    expect(names).toEqual([
      ...AGENT_TOOLS,
      ...WRITE_TOOLS,
      ...MANAGE_TOOLS,
      "reply_to_customer",
      "get_action_status",
    ]);
  });

  it("marks reply_to_customer as the only admin-gated tool", () => {
    expect([...REPLY_GATED_TOOLS]).toEqual(["reply_to_customer"]);
  });
});

describe("canUseTool", () => {
  it("denies unknown tools", () => {
    expect(canUseTool(principal(["tickets:read"]), "close_everything")).toBe(
      false
    );
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
