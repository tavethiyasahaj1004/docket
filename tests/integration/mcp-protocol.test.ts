import {
  Client,
  type FetchLike,
  StreamableHTTPClientTransport,
  type VersionNegotiationMode,
} from "@modelcontextprotocol/client";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only getPublicTicketConfig is wrapped (so one test can make it throw); by
// default it runs for real against the test database.
const configMock = vi.hoisted(() => ({ throwNext: null as Error | null }));
vi.mock("@/lib/ticket-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ticket-config")>();
  return {
    ...actual,
    getPublicTicketConfig: async () => {
      if (configMock.throwNext) {
        const err = configMock.throwNext;
        configMock.throwNext = null;
        throw err;
      }
      return await actual.getPublicTicketConfig();
    },
  };
});

import { DELETE, GET, POST } from "@/app/api/mcp/route";
import { FORBIDDEN_OUTPUT_PATTERNS } from "@/lib/mcp/dto";
import { MCP_TAG_LIMIT } from "@/lib/mcp/limits";
import { hmacToolArgs } from "@/lib/mcp/safe-handler";
import { MCP_INSTRUCTIONS } from "@/lib/mcp/server";
import { seedDefaultConfig } from "./fixtures";
import { MCP_URL } from "./mcp-endpoint-helpers";
import { addToken, setupMcpWorld, USERS } from "./mcp-helpers";

const world = setupMcpWorld();
const ALICE = USERS.alice.id;
const BOB = USERS.bob.id;

// The client's fetch calls the route handlers directly: no port is opened.
const inProcessFetch: FetchLike = (input, init) => {
  const request = new NextRequest(new Request(input, init));
  const handlers = { POST, GET, DELETE } as const;
  const handler = handlers[request.method as keyof typeof handlers];
  return Promise.resolve(handler(request));
};

const clients: Client[] = [];

async function connect(
  token: string,
  mode: VersionNegotiationMode = "auto"
): Promise<Client> {
  const client = new Client(
    { name: "protocol-test", version: "0.0.0" },
    { versionNegotiation: { mode } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: inProcessFetch,
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const text = (result: { content?: unknown }) =>
  ((result.content ?? []) as { type: string; text?: string }[])
    .map((b) => b.text ?? "")
    .join("");

async function toolCalls() {
  return await world.sql`
    SELECT * FROM mcp_tool_calls ORDER BY created_at, id`;
}

beforeEach(async () => {
  configMock.throwNext = null;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await seedDefaultConfig(world.db);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  vi.restoreAllMocks();
});

const MODES: [string, VersionNegotiationMode][] = [
  ["auto", "auto"],
  ["legacy (2025 initialize)", "legacy"],
  ["pinned 2026-07-28", { pin: "2026-07-28" }],
];

// A default agent token (tickets:read + customers:read): every read tool except
// the admin-only report.
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
const TICKETS_READ_ONLY_TOOLS = AGENT_TOOLS.filter((n) => n !== "get_customer");

describe("tools/list", () => {
  for (const [label, mode] of MODES) {
    it(`lists exactly the nine agent tools, in order, for a default token (${label})`, async () => {
      const token = await addToken(world.db, ALICE);
      const client = await connect(token.raw, mode);
      const { tools } = await client.listTools();

      expect(tools.map((t) => t.name)).toEqual(AGENT_TOOLS);
      for (const tool of tools) {
        expect(tool.annotations).toEqual({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
        expect(tool._meta).toBeUndefined();
        expect(tool.title).toBeTruthy();
        expect((tool.description ?? "").length).toBeLessThanOrEqual(1000);
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.inputSchema.additionalProperties).toBe(false);
        for (const keyword of ["anyOf", "oneOf", "allOf"]) {
          expect(tool.inputSchema).not.toHaveProperty(keyword);
        }
        expect(tool.outputSchema).toBeDefined();
      }
    });
  }

  it("lists whoami and get_customer for a customers:read-only token", async () => {
    const token = await addToken(world.db, ALICE, {
      scopes: ["customers:read"],
    });
    const client = await connect(token.raw);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["whoami", "get_customer"]);
  });

  it("never grants more than the owner's role allows", async () => {
    // An agent token that somehow carries reports:read still gets only what the
    // agent role allows.
    const token = await addToken(world.db, ALICE, {
      scopes: ["tickets:read", "reports:read"],
    });
    const client = await connect(token.raw);
    const whoami = await client.callTool({ name: "whoami", arguments: {} });
    expect((whoami.structuredContent as { scopes: string[] }).scopes).toEqual([
      "tickets:read",
    ]);
  });

  it("reports the server instructions", async () => {
    const token = await addToken(world.db, ALICE);
    const client = await connect(token.raw);
    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
  });
});

describe("unlisted tools", () => {
  it("rejects a hand-crafted call to a tool the token cannot see", async () => {
    const token = await addToken(world.db, ALICE, {
      scopes: ["customers:read"],
    });
    const client = await connect(token.raw);
    await expect(
      client.callTool({ name: "get_ticket_config", arguments: {} })
    ).rejects.toThrow(/unknown tool|not found/i);
    expect(await toolCalls()).toHaveLength(0);
  });
});

describe("whoami", () => {
  for (const [label, mode] of MODES.slice(0, 2)) {
    it(`returns the documented shape (${label})`, async () => {
      const token = await addToken(world.db, ALICE, { name: "my laptop" });
      const client = await connect(token.raw, mode);
      const result = await client.callTool({ name: "whoami", arguments: {} });

      expect(result.isError).toBeFalsy();
      const dto = result.structuredContent as Record<string, unknown>;
      const [row] = await world.sql`
        SELECT expires_at FROM mcp_access_tokens WHERE id = ${token.id}`;
      expect(dto).toEqual({
        user: {
          id: ALICE,
          name: USERS.alice.name,
          email: USERS.alice.email,
          role: "agent",
        },
        scopes: ["tickets:read", "customers:read"],
        authMethod: "pat",
        credential: {
          id: token.id,
          name: "my laptop",
          expiresAt: new Date(row.expires_at).toISOString(),
        },
        tools: AGENT_TOOLS,
      });
      expect(JSON.parse(text(result))).toEqual(dto);
      expect(text(result)).not.toContain(token.raw);
      expect(text(result)).not.toContain(token.hash);
    });
  }

  it("rejects unexpected arguments", async () => {
    const token = await addToken(world.db, ALICE);
    const client = await connect(token.raw);
    const outcome = await client
      .callTool({ name: "whoami", arguments: { extra: 1 } })
      .then(
        (r) => ({ isError: r.isError === true }),
        () => ({ isError: true })
      );
    expect(outcome.isError).toBe(true);
  });
});

describe("get_ticket_config", () => {
  async function seedTags(n: number) {
    const rows = Array.from({ length: n }, (_, i) => ({
      id: `tag-${String(i).padStart(4, "0")}`,
      name: `tag-${String(i).padStart(4, "0")}`,
    }));
    await world.db.insert((await import("@/db/schema")).tags).values(rows);
  }

  it("returns the seeded configuration without colors", async () => {
    await seedTags(3);
    const token = await addToken(world.db, ALICE);
    const client = await connect(token.raw);
    const result = await client.callTool({
      name: "get_ticket_config",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const dto = result.structuredContent as {
      statuses: unknown[];
      priorities: unknown[];
      categories: unknown[];
      customFields: unknown[];
      tags: { id: string; name: string }[];
      tagsTruncated: boolean;
    };
    expect(dto.statuses).toEqual([
      { slug: "open", label: "Open", isDefault: true, isClosedState: false },
      {
        slug: "in_progress",
        label: "In Progress",
        isDefault: false,
        isClosedState: false,
      },
      {
        slug: "closed",
        label: "Closed",
        isDefault: false,
        isClosedState: true,
      },
    ]);
    expect(dto.priorities).toEqual([
      { slug: "low", label: "Low", isDefault: false },
      { slug: "normal", label: "Normal", isDefault: true },
      { slug: "high", label: "High", isDefault: false },
      { slug: "urgent", label: "Urgent", isDefault: false },
    ]);
    expect(dto.categories.map((c) => (c as { slug: string }).slug)).toEqual([
      "bug",
      "issue",
      "feature_request",
      "billing",
      "general_query",
    ]);
    expect(dto.customFields).toEqual([]);
    expect(dto.tags.map((t) => t.name)).toEqual([
      "tag-0000",
      "tag-0001",
      "tag-0002",
    ]);
    expect(dto.tagsTruncated).toBe(false);
    expect(text(result)).not.toContain("color");
    for (const pattern of FORBIDDEN_OUTPUT_PATTERNS) {
      expect(text(result)).not.toContain(pattern as string);
    }
  });

  it("caps tags at 200 and flags truncation when 201 exist", async () => {
    await seedTags(MCP_TAG_LIMIT + 1);
    const token = await addToken(world.db, ALICE);
    const client = await connect(token.raw);
    const result = await client.callTool({
      name: "get_ticket_config",
      arguments: {},
    });
    const dto = result.structuredContent as {
      tags: unknown[];
      tagsTruncated: boolean;
    };
    expect(dto.tags).toHaveLength(MCP_TAG_LIMIT);
    expect(dto.tagsTruncated).toBe(true);
  });

  it("returns no tags when includeTags is false", async () => {
    await seedTags(5);
    const token = await addToken(world.db, ALICE);
    const client = await connect(token.raw);
    const result = await client.callTool({
      name: "get_ticket_config",
      arguments: { includeTags: false },
    });
    const dto = result.structuredContent as {
      tags: unknown[];
      tagsTruncated: boolean;
      statuses: unknown[];
    };
    expect(dto.tags).toEqual([]);
    expect(dto.tagsTruncated).toBe(false);
    expect(dto.statuses).toHaveLength(3);
  });

  it("works for an admin with the same shape", async () => {
    const token = await addToken(world.db, BOB, { scopes: ["tickets:read"] });
    const client = await connect(token.raw);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TICKETS_READ_ONLY_TOOLS);
  });
});

describe("exception suppression", () => {
  it("never sends an exception message to the client and records the failure", async () => {
    const detail =
      "connection to server at 10.1.2.3:5432 failed: password=hunter2";
    configMock.throwNext = new Error(detail);
    const token = await addToken(world.db, ALICE);
    const client = await connect(token.raw);

    const result = await client.callTool({
      name: "get_ticket_config",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    // The text block is the serialized structuredContent, and carries nothing
    // but the code and an opaque reference.
    expect(text(result)).toBe(JSON.stringify(result.structuredContent));
    expect(JSON.parse(text(result))).toEqual({
      error: {
        code: "internal",
        message: expect.stringMatching(/^Internal error \(ref: [a-z0-9]+\)$/),
      },
    });
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("10.1.2.3");
    const ref = /ref: ([a-z0-9]+)/.exec(text(result))?.[1];

    const rows = await toolCalls();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      request_id: ref,
      user_id: ALICE,
      credential_id: token.id,
      tool: "get_ticket_config",
      status: "failed",
      error_code: "internal",
    });
    // The server log gets the ref and the error class, but never the message:
    // exception text can carry query parameters, hosts or credentials.
    const logged = vi
      .mocked(console.error)
      .mock.calls.map((args) => args.map(String).join(" "))
      .join("\n");
    expect(logged).toContain(`ref=${ref}`);
    expect(logged).toContain("Error");
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("10.1.2.3");
  });
});

describe("tool-call recording", () => {
  it("writes one row per call with a keyed hash and no raw arguments", async () => {
    const token = await addToken(world.db, ALICE);
    const client = await connect(token.raw);
    await client.listTools();
    expect(await toolCalls()).toHaveLength(0);

    await client.callTool({
      name: "get_ticket_config",
      arguments: { includeTags: false },
    });
    const rows = await toolCalls();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      user_id: ALICE,
      auth_method: "pat",
      credential_id: token.id,
      tool: "get_ticket_config",
      status: "succeeded",
      error_code: null,
      attempts: 1,
      client_request_id: null,
      lock_group: null,
      result_json: null,
      body_hmac: null,
      lease_expires_at: null,
    });
    expect(row.request_id).toMatch(/^[a-z0-9]+$/);
    expect(row.args_hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(row.args_hmac).toBe(hmacToolArgs({ includeTags: false }));
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    // No raw arguments anywhere in the stored row.
    expect(JSON.stringify(row)).not.toContain("includeTags");

    await client.callTool({ name: "whoami", arguments: {} });
    expect(await toolCalls()).toHaveLength(2);
  });

  it("updates last_used_at on an authenticated call", async () => {
    const token = await addToken(world.db, ALICE);
    const client = await connect(token.raw);
    await client.callTool({ name: "whoami", arguments: {} });

    let lastUsed: string | null = null;
    for (let i = 0; i < 20 && !lastUsed; i++) {
      const [row] = await world.sql`
        SELECT last_used_at FROM mcp_access_tokens WHERE id = ${token.id}`;
      lastUsed = row.last_used_at;
      if (!lastUsed) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(lastUsed).not.toBeNull();
  });
});
