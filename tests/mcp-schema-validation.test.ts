import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const insertValues = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({
  db: { insert: () => ({ values: insertValues }) },
}));

import type { McpPrincipal } from "@/lib/mcp/auth";
import { createDocketMcpServer } from "@/lib/mcp/server";

// Pins what happens today when a tool call fails the tool's zod `inputSchema`.
// Observed with @modelcontextprotocol/server 2.4.0, over the SDK's in-memory
// transport:
//
// - The SDK rejects the call BEFORE `safeHandler` runs, so the tool handler
//   never executes and no trace row is written (no `db.insert`).
// - It is a TOOL error, not a JSON-RPC error: `client.callTool` resolves with
//   `isError: true`.
// - The text block is the SDK's plain text, "Input validation error: Invalid
//   arguments for tool <name>: <zod issue summary>". It is NOT the JSON
//   `{"error":{...}}` shape that `safeHandler` produces, there is no `code`
//   such as `invalid_input`, and `structuredContent` is absent.
//
// So the "text === JSON.stringify(structuredContent)" rule holds for every
// result `safeHandler` produces, but not for these SDK-level rejections. This
// test documents that; it does not change it. If an SDK upgrade changes the
// wording, update the patterns below deliberately.

const principal: McpPrincipal = {
  userId: "user-1",
  name: "Alice",
  email: "alice@example.test",
  role: "agent",
  scopes: ["tickets:read"],
  authMethod: "pat",
  credentialId: "cred-1",
  credentialName: "laptop",
  credentialExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
};

let client: Client;

beforeEach(async () => {
  insertValues.mockReset();
  insertValues.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const server = createDocketMcpServer(principal, "req-schema");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "schema-test", version: "0.0.0" });
  await server.connect(serverSide);
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
  vi.restoreAllMocks();
});

async function rejected(name: string, args: Record<string, unknown>) {
  // Must resolve: a JSON-RPC error would make callTool reject and fail here.
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])
    .map((b) => b.text)
    .join("");
  return { result, text };
}

describe("tool input schema rejection (SDK level)", () => {
  it.each([
    ["list_tickets", { pageSize: 0 }, /pageSize: .*>=1/],
    ["list_tickets", { unexpected: true }, /Unrecognized key: "unexpected"/],
    ["get_ticket", {}, /ticket: /],
  ] as const)("%s %j is a tool error with plain text", async (name, args, detail) => {
    const { result, text } = await rejected(name, { ...args });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(text).toMatch(
      /^Input validation error: Invalid arguments for tool /
    );
    expect(text).toContain(`tool ${name}:`);
    expect(text).toMatch(detail);
    expect(() => JSON.parse(text)).toThrow();
  });

  it("never reaches the tool handler or the trace table", async () => {
    await rejected("list_tickets", { pageSize: 0 });
    await rejected("list_tickets", { unexpected: true });
    await rejected("get_ticket", {});
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("does not echo the offending value", async () => {
    const { text } = await rejected("list_tickets", {
      pageSize: "SECRET-VALUE",
    });
    expect(text).not.toContain("SECRET-VALUE");
  });
});
