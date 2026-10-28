import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  allowedMcpScopesForRole,
  DEFAULT_MCP_SCOPES,
  effectiveMcpScopes,
  generateMcpToken,
  hashMcpToken,
  isEligibleMcpRole,
  isIssuableMcpScope,
  isMcpScope,
  MCP_ISSUABLE_SCOPES,
  MCP_SCOPES,
} from "@/lib/mcp-tokens";

// An MCP token is a bearer credential tied to a user. The raw secret must never
// be what is stored, and the scopes it carries must never exceed what the
// owner's role allows right now.

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("generateMcpToken", () => {
  it("is dkm_ followed by two cuid2 values", () => {
    const { raw } = generateMcpToken();
    expect(raw).toMatch(/^dkm_[a-z0-9]+$/);
    // cuid2 defaults to 24 chars each.
    expect(raw).toHaveLength("dkm_".length + 24 * 2);
  });

  it("keeps the first 12 characters as the display prefix", () => {
    const { raw, prefix } = generateMcpToken();
    expect(prefix).toBe(raw.slice(0, 12));
    expect(prefix.startsWith("dkm_")).toBe(true);
    expect(prefix.length).toBeLessThan(raw.length / 2);
  });

  it("stores a deterministic SHA-256 hex hash, never the raw secret", () => {
    const { raw, hash } = generateMcpToken();
    expect(hash).toBe(sha256(raw));
    expect(hashMcpToken(raw)).toBe(hash);
    expect(hashMcpToken(raw)).toBe(hashMcpToken(raw));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(raw);
    expect(hashMcpToken(`${raw} `)).not.toBe(hash);
  });

  it("never repeats a token or a hash across many generations", () => {
    const raws = new Set<string>();
    const hashes = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const { raw, hash } = generateMcpToken();
      raws.add(raw);
      hashes.add(hash);
    }
    expect(raws.size).toBe(300);
    expect(hashes.size).toBe(300);
  });
});

describe("isMcpScope", () => {
  it("accepts every known scope", () => {
    for (const scope of MCP_SCOPES) {
      expect(isMcpScope(scope)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const value of [
      "tickets:delete",
      "Tickets:Read",
      " tickets:read",
      "",
      "*",
      null,
      undefined,
      42,
      ["tickets:read"],
      { scope: "tickets:read" },
    ]) {
      expect(isMcpScope(value)).toBe(false);
    }
  });

  it("only defaults to read scopes", () => {
    expect([...DEFAULT_MCP_SCOPES]).toEqual(["tickets:read", "customers:read"]);
  });
});

describe("role ceilings", () => {
  it("gives agents every scope except reports:read", () => {
    const scopes = allowedMcpScopesForRole("agent");
    expect(scopes).not.toContain("reports:read");
    expect(scopes).toEqual(MCP_SCOPES.filter((s) => s !== "reports:read"));
  });

  it("gives admins every scope", () => {
    expect(allowedMcpScopesForRole("admin")).toEqual([...MCP_SCOPES]);
  });

  it("gives any other role nothing", () => {
    for (const role of [
      "user",
      "",
      "agent,admin",
      "Agent",
      " agent",
      "viewer",
    ]) {
      expect(allowedMcpScopesForRole(role)).toEqual([]);
    }
    expect(allowedMcpScopesForRole(null)).toEqual([]);
    expect(allowedMcpScopesForRole(undefined)).toEqual([]);
  });

  it("treats only exactly agent/admin as eligible", () => {
    expect(isEligibleMcpRole("agent")).toBe(true);
    expect(isEligibleMcpRole("admin")).toBe(true);
    for (const role of ["user", "", "agent,admin", "Agent", " agent", null]) {
      expect(isEligibleMcpRole(role)).toBe(false);
    }
  });
});

describe("effectiveMcpScopes", () => {
  it("intersects the token's scopes with the role ceiling, in canonical order", () => {
    expect(
      effectiveMcpScopes(["customers:read", "tickets:read"], "agent")
    ).toEqual(["tickets:read", "customers:read"]);
  });

  it("drops reports:read when an admin is demoted to agent", () => {
    const granted = ["tickets:read", "reports:read"];
    expect(effectiveMcpScopes(granted, "admin")).toEqual([
      "tickets:read",
      "reports:read",
    ]);
    expect(effectiveMcpScopes(granted, "agent")).toEqual(["tickets:read"]);
  });

  it("yields nothing for an ineligible role", () => {
    expect(effectiveMcpScopes([...MCP_SCOPES], "user")).toEqual([]);
    expect(effectiveMcpScopes([...MCP_SCOPES], "agent,admin")).toEqual([]);
  });

  it("ignores scopes the token carries that are not known", () => {
    expect(effectiveMcpScopes(["tickets:read", "bogus"], "admin")).toEqual([
      "tickets:read",
    ]);
  });
});

describe("issuable scopes", () => {
  it("issues the read scopes and tickets:write, in release 2", () => {
    expect([...MCP_ISSUABLE_SCOPES]).toEqual([
      "tickets:read",
      "customers:read",
      "tickets:write",
      "reports:read",
    ]);
  });

  it("never puts tickets:write in the defaults", () => {
    expect([...DEFAULT_MCP_SCOPES]).not.toContain("tickets:write");
  });

  it("accepts the read scopes and tickets:write, and rejects the rest", () => {
    for (const scope of [
      "tickets:read",
      "customers:read",
      "tickets:write",
      "reports:read",
    ] as const) {
      expect(isIssuableMcpScope(scope)).toBe(true);
    }
    for (const scope of [
      "tickets:manage",
      "tickets:reply",
      "tickets:read_internal",
    ] as const) {
      expect(isIssuableMcpScope(scope)).toBe(false);
    }
  });

  it("keeps the full scope catalog defined for later phases", () => {
    expect([...MCP_SCOPES]).toEqual([
      "tickets:read",
      "tickets:read_internal",
      "customers:read",
      "tickets:write",
      "tickets:manage",
      "tickets:reply",
      "reports:read",
    ]);
    // Every default is issuable.
    for (const scope of DEFAULT_MCP_SCOPES) {
      expect(isIssuableMcpScope(scope)).toBe(true);
    }
  });

  it("leaves the role ceilings untouched", () => {
    const agent = allowedMcpScopesForRole("agent");
    for (const scope of ["tickets:write", "tickets:manage", "tickets:reply"]) {
      expect(agent).toContain(scope);
    }
    expect(allowedMcpScopesForRole("admin")).toEqual([...MCP_SCOPES]);
  });
});
