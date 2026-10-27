import { beforeEach, describe, expect, it, vi } from "vitest";

const insertValues = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({
  db: { insert: () => ({ values: insertValues }) },
}));

import type { McpPrincipal } from "@/lib/mcp/auth";
import { McpToolError } from "@/lib/mcp/errors";
import {
  MCP_RESULT_HARD_CAP_CHARS,
  MCP_RESULT_TARGET_CHARS,
} from "@/lib/mcp/limits";
import {
  describeErrorForLog,
  hmacToolArgs,
  safeHandler,
} from "@/lib/mcp/safe-handler";

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

const ctx = (over: Record<string, unknown> = {}) => ({
  tool: "get_ticket_config",
  principal,
  requestId: "req-abc",
  args: { includeTags: true },
  ...over,
});

const textOf = (r: { content?: unknown }) =>
  (r.content as { text: string }[])[0].text;

beforeEach(() => {
  insertValues.mockReset();
  insertValues.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("safeHandler", () => {
  it("returns the result as text and structuredContent, and records success", async () => {
    const result = await safeHandler(ctx(), async () => ({ a: 1 }));
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: '{"a":1}' }]);
    expect(result.structuredContent).toEqual({ a: 1 });
    expect(insertValues).toHaveBeenCalledTimes(1);
    const row = insertValues.mock.calls[0][0];
    expect(row).toMatchObject({
      requestId: "req-abc",
      userId: "user-1",
      authMethod: "pat",
      credentialId: "cred-1",
      tool: "get_ticket_config",
      status: "succeeded",
      errorCode: null,
    });
    expect(row.argsHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof row.durationMs).toBe("number");
    // Raw arguments are never stored.
    expect(Object.values(row)).not.toContainEqual({ includeTags: true });
  });

  it("logs one structured line with no bodies", async () => {
    await safeHandler(ctx(), async () => ({ secret: "customer@x.test" }));
    const log = vi.mocked(console.log).mock.calls[0][0] as string;
    expect(log).toMatch(
      /^\[mcp\] tool=get_ticket_config user=user-1 outcome=ok ms=\d+ ref=req-abc$/
    );
  });

  it("describes a query error for the log without its message or parameters", () => {
    const cause = Object.assign(new Error('relation "x" does not exist'), {
      code: "42P01",
    });
    const error = new Error(
      "Failed query: select * from customers where email = $1\nparams: jane@customer.test",
      { cause }
    );
    error.name = "DrizzleQueryError";
    const text = describeErrorForLog(error);
    expect(text.split("\n")[0]).toBe("DrizzleQueryError <- Error code=42P01");
    expect(text).not.toContain("jane@customer.test");
    expect(text).not.toContain("Failed query");
    expect(text).not.toContain("relation");
  });

  it("keeps no message line that looks like a stack frame", () => {
    const error = new Error(
      "Failed query: select 1\nparams: %a\n    at jane@customer.test%"
    );
    const text = describeErrorForLog(error);
    expect(text).not.toContain("jane@customer.test");
    expect(text).toMatch(/^Error\n\s+at /);
  });

  it("hides a thrown error message from the result", async () => {
    const secret =
      'SELECT * FROM "user" WHERE password=hunter2 at 10.0.0.5:5432';
    const result = await safeHandler(ctx(), async () => {
      throw new Error(secret);
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Internal error (ref: req-abc)");
    expect(result.structuredContent).toEqual({
      error: { code: "internal", message: "Internal error (ref: req-abc)" },
    });
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("10.0.0.5");
    // The log gets the error's class and stack frames, never its message: a
    // failed query's message embeds parameters such as customer emails.
    const errorCall = vi.mocked(console.error).mock.calls[0];
    expect(errorCall[0]).toMatch(
      /^\[mcp\] tool=get_ticket_config user=user-1 outcome=internal ms=\d+ ref=req-abc$/
    );
    expect(typeof errorCall[1]).toBe("string");
    expect(errorCall[1]).toMatch(/^Error\n\s+at /);
    expect(JSON.stringify(errorCall)).not.toContain("hunter2");
    expect(JSON.stringify(errorCall)).not.toContain("10.0.0.5");
    expect(insertValues.mock.calls[0][0]).toMatchObject({
      status: "failed",
      errorCode: "internal",
    });
  });

  it("denies a tool the principal may not use, without running it", async () => {
    const fn = vi.fn(async () => ({ a: 1 }));
    const result = await safeHandler(
      ctx({ principal: { ...principal, scopes: ["customers:read"] } }),
      fn
    );
    expect(fn).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("This tool is not available to this token.");
    expect(result.structuredContent).toEqual({
      error: {
        code: "invalid_input",
        message: "This tool is not available to this token.",
      },
    });
    expect(insertValues.mock.calls[0][0]).toMatchObject({
      status: "failed",
      errorCode: "invalid_input",
    });
  });

  it("shrinks an oversized result, and uses the shrunk one", async () => {
    const big = { blob: "x".repeat(MCP_RESULT_HARD_CAP_CHARS + 1) };
    const shrink = vi.fn(() => ({ blob: "small" }));
    const result = await safeHandler(ctx({ shrink }), async () => big);
    expect(shrink).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ blob: "small" });
  });

  it("treats a result that is still too big after shrinking as internal", async () => {
    const big = { blob: "x".repeat(MCP_RESULT_HARD_CAP_CHARS + 1) };
    const result = await safeHandler(
      ctx({ shrink: (r: typeof big) => r }),
      async () => big
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Internal error (ref: req-abc)");
    expect(JSON.stringify(result)).not.toContain("xxxxxxxx");
  });

  it("shrinks a result above the target size, below the hard cap", async () => {
    const mid = { blob: "x".repeat(MCP_RESULT_TARGET_CHARS + 100) };
    expect(JSON.stringify(mid).length).toBeLessThan(MCP_RESULT_HARD_CAP_CHARS);
    const shrink = vi.fn(() => ({ blob: "small" }));
    const result = await safeHandler(ctx({ shrink }), async () => mid);
    expect(shrink).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toEqual({ blob: "small" });
  });

  it("leaves a result at or under the target untouched", async () => {
    const fits = { blob: "x".repeat(1000) };
    const shrink = vi.fn(() => ({ blob: "small" }));
    const result = await safeHandler(ctx({ shrink }), async () => fits);
    expect(shrink).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual(fits);
  });

  it("returns a deliberate McpToolError as a tool error, with its code and message", async () => {
    vi.mocked(console.log).mockClear();
    vi.mocked(console.error).mockClear();
    const result = await safeHandler(ctx(), async () => {
      throw new McpToolError("not_found", "No such ticket.", { hint: 1 });
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("No such ticket.");
    expect(result.structuredContent).toEqual({
      error: {
        code: "not_found",
        message: "No such ticket.",
        details: { hint: 1 },
      },
    });
    expect(insertValues.mock.calls[0][0]).toMatchObject({
      status: "failed",
      errorCode: "not_found",
    });
    const log = vi.mocked(console.log).mock.calls[0][0] as string;
    expect(log).toMatch(/outcome=not_found ms=\d+ ref=req-abc$/);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("omits details when the error has none", async () => {
    const result = await safeHandler(ctx(), async () => {
      throw new McpToolError("invalid_input", "Bad.");
    });
    expect(result.structuredContent).toEqual({
      error: { code: "invalid_input", message: "Bad." },
    });
  });

  it("records the entity a call resolved to, on success and on a domain error", async () => {
    await safeHandler(ctx(), async (call) => {
      call.setTarget({ ticketId: "t1" });
      call.setTarget({ customerId: "c1" });
      return { a: 1 };
    });
    expect(insertValues.mock.calls[0][0]).toMatchObject({
      targetTicketId: "t1",
      targetCustomerId: "c1",
    });

    await safeHandler(ctx(), async (call) => {
      call.setTarget({ ticketId: "t2" });
      throw new McpToolError("invalid_input", "Bad.");
    });
    expect(insertValues.mock.calls[1][0]).toMatchObject({
      targetTicketId: "t2",
      targetCustomerId: null,
    });

    await safeHandler(ctx(), async () => ({ a: 1 }));
    expect(insertValues.mock.calls[2][0]).toMatchObject({
      targetTicketId: null,
      targetCustomerId: null,
    });
  });

  it("treats an oversized result with no shrink as internal", async () => {
    const result = await safeHandler(ctx(), async () => ({
      blob: "x".repeat(MCP_RESULT_HARD_CAP_CHARS + 1),
    }));
    expect(result.isError).toBe(true);
  });

  it("never fails the call when recording the trace fails", async () => {
    insertValues.mockRejectedValue(new Error("db down"));
    const result = await safeHandler(ctx(), async () => ({ a: 1 }));
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ a: 1 });
  });
});

describe("hmacToolArgs", () => {
  it("is stable across key order and differs for different arguments", () => {
    expect(hmacToolArgs({ a: 1, b: { c: 2, d: 3 } })).toBe(
      hmacToolArgs({ b: { d: 3, c: 2 }, a: 1 })
    );
    expect(hmacToolArgs({ a: 1 })).not.toBe(hmacToolArgs({ a: 2 }));
    expect(hmacToolArgs({})).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not expose the arguments", () => {
    expect(hmacToolArgs({ q: "secret-search" })).not.toContain("secret");
  });
});
