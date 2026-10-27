import { describe, expect, it } from "vitest";
import type { McpPrincipal } from "@/lib/mcp/auth";
import {
  FORBIDDEN_OUTPUT_PATTERNS,
  toTicketConfigDto,
  toWhoamiDto,
} from "@/lib/mcp/dto";
import { MCP_TAG_LIMIT } from "@/lib/mcp/limits";
import type { getPublicTicketConfig } from "@/lib/ticket-config";

type Config = Awaited<ReturnType<typeof getPublicTicketConfig>>;

function config(tagCount = 3): Config {
  return {
    statuses: [
      {
        slug: "open",
        label: "Open",
        color: "#ff0000",
        isDefault: true,
        isClosedState: false,
      },
      {
        slug: "closed",
        label: "Closed",
        color: "#00ff00",
        isDefault: false,
        isClosedState: true,
      },
    ],
    priorities: [
      { slug: "low", label: "Low", color: "#111111", isDefault: true },
    ],
    categories: [{ slug: "billing", label: "Billing", color: "#222222" }],
    customFields: [
      {
        key: "plan",
        label: "Plan",
        type: "select",
        options: ["free", "pro"],
        required: false,
      },
      {
        key: "note",
        label: "Note",
        type: "text",
        options: undefined,
        required: true,
      },
    ],
    tags: Array.from({ length: tagCount }, (_, i) => ({
      id: `tag-${i}`,
      name: `tag ${i}`,
    })),
  };
}

const principal: McpPrincipal = {
  userId: "u1",
  name: "Alice Agent",
  email: "alice@example.test",
  role: "agent",
  scopes: ["tickets:read", "customers:read"],
  authMethod: "pat",
  credentialId: "cred-1",
  credentialName: "laptop",
  credentialExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
};

function assertClean(value: unknown) {
  const text = JSON.stringify(value);
  for (const pattern of FORBIDDEN_OUTPUT_PATTERNS) {
    if (typeof pattern === "string") {
      expect(text, `contains ${pattern}`).not.toContain(pattern);
    } else {
      expect(text, `matches ${pattern}`).not.toMatch(pattern);
    }
  }
}

describe("toWhoamiDto", () => {
  it("has the documented shape", () => {
    expect(toWhoamiDto(principal, ["whoami", "get_ticket_config"])).toEqual({
      user: {
        id: "u1",
        name: "Alice Agent",
        email: "alice@example.test",
        role: "agent",
      },
      scopes: ["tickets:read", "customers:read"],
      authMethod: "pat",
      credential: {
        id: "cred-1",
        name: "laptop",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
      tools: ["whoami", "get_ticket_config"],
    });
  });

  it("contains no forbidden material", () => {
    assertClean(toWhoamiDto(principal, ["whoami"]));
  });
});

describe("toTicketConfigDto", () => {
  it("drops colors and copies only allowlisted fields", () => {
    const dto = toTicketConfigDto(config(), { includeTags: true });
    expect(JSON.stringify(dto)).not.toContain("color");
    expect(dto.statuses[0]).toEqual({
      slug: "open",
      label: "Open",
      isDefault: true,
      isClosedState: false,
    });
    expect(dto.categories).toEqual([{ slug: "billing", label: "Billing" }]);
    expect(dto.customFields[0]).toEqual({
      key: "plan",
      label: "Plan",
      type: "select",
      options: ["free", "pro"],
      required: false,
    });
    expect("options" in dto.customFields[1]).toBe(false);
    expect(dto.tagsTruncated).toBe(false);
    assertClean(dto);
  });

  it("caps tags at 200 and flags truncation", () => {
    const exact = toTicketConfigDto(config(MCP_TAG_LIMIT), {
      includeTags: true,
    });
    expect(exact.tags).toHaveLength(MCP_TAG_LIMIT);
    expect(exact.tagsTruncated).toBe(false);

    const over = toTicketConfigDto(config(MCP_TAG_LIMIT + 1), {
      includeTags: true,
    });
    expect(over.tags).toHaveLength(MCP_TAG_LIMIT);
    expect(over.tagsTruncated).toBe(true);
    assertClean(over);
  });

  it("returns no tags and no truncation when tags are excluded", () => {
    const dto = toTicketConfigDto(config(500), { includeTags: false });
    expect(dto.tags).toEqual([]);
    expect(dto.tagsTruncated).toBe(false);
  });
});

describe("FORBIDDEN_OUTPUT_PATTERNS", () => {
  it("would catch leaked material", () => {
    const leaks = [
      "customerToken",
      "storageKey",
      "/api/files/x",
      "a?token=b",
      "apiKeyId",
      '{"type":"doc"}',
      "keyHash",
      "key_hash",
      "dkm_abc",
    ];
    for (const leak of leaks) {
      const hit = FORBIDDEN_OUTPUT_PATTERNS.some((p) =>
        typeof p === "string" ? leak.includes(p) : p.test(leak)
      );
      expect(hit, leak).toBe(true);
    }
  });
});
