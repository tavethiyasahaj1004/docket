import { beforeEach, describe, expect, it, vi } from "vitest";

const insertValues = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({
  db: { insert: () => ({ values: insertValues }) },
}));

import type { McpPrincipal } from "@/lib/mcp/auth";
import {
  MCP_ERROR_DETAIL_KEYS,
  type McpErrorDetails,
  McpToolError,
} from "@/lib/mcp/errors";
import {
  MCP_ERROR_CODES,
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
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.mocked(console.warn).mockClear();
});

describe("safeHandler", () => {
  it("returns the result as text and structuredContent, and records success", async () => {
    const result = await safeHandler(ctx(), async () => ({ a: 1 }));
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: '{"a":1}' }]);
    expect(result.structuredContent).toEqual({ a: 1 });
    expect(textOf(result)).toBe(JSON.stringify(result.structuredContent));
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
    expect(result.structuredContent).toEqual({
      error: { code: "internal", message: "Internal error (ref: req-abc)" },
    });
    expect(textOf(result)).toBe(
      JSON.stringify({
        error: { code: "internal", message: "Internal error (ref: req-abc)" },
      })
    );
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
    expect(result.structuredContent).toEqual({
      error: {
        code: "invalid_input",
        message: "This tool is not available to this token.",
      },
    });
    expect(textOf(result)).toBe(JSON.stringify(result.structuredContent));
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
    expect(textOf(result)).toBe(
      JSON.stringify({
        error: { code: "internal", message: "Internal error (ref: req-abc)" },
      })
    );
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
      throw new McpToolError("not_found", "No such ticket.", {
        ticketNumber: 7,
      });
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: "not_found",
        message: "No such ticket.",
        details: { ticketNumber: 7 },
      },
    });
    expect(textOf(result)).toBe(JSON.stringify(result.structuredContent));
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

describe("error text is the serialized structuredContent", () => {
  const expectSerialized = (result: {
    content?: unknown;
    structuredContent?: unknown;
  }) => {
    const text = textOf(result);
    expect(text).toBe(JSON.stringify(result.structuredContent));
    expect(JSON.parse(text)).toEqual(result.structuredContent);
  };

  it("holds for every error code raised as an McpToolError", async () => {
    for (const code of MCP_ERROR_CODES) {
      const result = await safeHandler(ctx(), async () => {
        throw new McpToolError(code, `Message for ${code}.`, {
          field: "status",
          allowed: ["open", "closed"],
        });
      });
      expect(result.isError, code).toBe(true);
      expectSerialized(result);
      expect(result.structuredContent).toEqual({
        error: {
          code,
          message: `Message for ${code}.`,
          details: { field: "status", allowed: ["open", "closed"] },
        },
      });
    }
  });

  it("holds for the internal and unpermitted paths, and for success", async () => {
    expectSerialized(
      await safeHandler(ctx(), async () => {
        throw new Error("boom");
      })
    );
    expectSerialized(
      await safeHandler(
        ctx({ principal: { ...principal, scopes: ["customers:read"] } }),
        async () => ({ a: 1 })
      )
    );
    expectSerialized(await safeHandler(ctx(), async () => ({ a: [1, "x"] })));
  });

  it("gives an internal error only a reference id: no details, no cause", async () => {
    const result = await safeHandler(ctx(), async () => {
      throw Object.assign(new Error("db password=hunter2"), {
        details: { field: "x" },
        cause: new Error("inner"),
      });
    });
    expect(JSON.parse(textOf(result))).toEqual({
      error: { code: "internal", message: "Internal error (ref: req-abc)" },
    });
  });
});

describe("error details are sanitized", () => {
  const raise = (details: unknown) =>
    safeHandler(ctx(), async () => {
      throw new McpToolError("conflict", "Nope.", details as McpErrorDetails);
    });
  const detailsOf = (result: { structuredContent?: unknown }) =>
    (
      result.structuredContent as {
        error: { details?: Record<string, unknown> };
      }
    ).error.details;

  it("keeps every allowlisted key with a safe value", async () => {
    const all = {
      mergedIntoTicketNumber: 12,
      retryAfterSeconds: 30,
      commentId: "ck1abc",
      currentStatus: "closed",
      currentUpdatedAt: "2026-01-01T00:00:00.000Z",
      ticketNumber: 5,
      field: "status",
      allowed: ["open", 3],
    };
    expect(Object.keys(all).sort()).toEqual([...MCP_ERROR_DETAIL_KEYS].sort());
    const result = await raise(all);
    expect(detailsOf(result)).toEqual(all);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("keeps booleans and null but drops non-finite numbers", async () => {
    const result = await raise({
      ticketNumber: null,
      field: Number.NaN,
      currentStatus: true,
    });
    expect(detailsOf(result)).toEqual({
      ticketNumber: null,
      currentStatus: true,
    });
  });

  it("drops a key that is not on the allowlist and logs only its name", async () => {
    const result = await raise({ ticketNumber: 1, note: "SECRET-VALUE" });
    expect(detailsOf(result)).toEqual({ ticketNumber: 1 });
    expect(JSON.stringify(result)).not.toContain("SECRET-VALUE");
    expect(console.warn).toHaveBeenCalledTimes(1);
    const logged = vi.mocked(console.warn).mock.calls[0].join(" ");
    expect(logged).toContain("key=note");
    expect(logged).toContain("ref=req-abc");
    expect(logged).not.toContain("SECRET-VALUE");
  });

  it("drops an email address, wherever it sits in the string or array", async () => {
    const result = await raise({
      field: "jane@customer.test",
      currentStatus: "see jane@customer.test please",
      allowed: ["open", "jane@customer.test"],
    });
    expect(result.structuredContent).toEqual({
      error: { code: "conflict", message: "Nope." },
    });
    expect(JSON.stringify(result)).not.toContain("jane@");
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "jane@"
    );
  });

  it("drops values matching a forbidden output pattern", async () => {
    for (const bad of [
      "dkm_abcdef",
      "/api/files/x",
      "token=abc",
      "customerToken",
      "storageKey",
      '{"type":"doc"}',
    ]) {
      const result = await raise({ field: bad, ticketNumber: 2 });
      expect(detailsOf(result), bad).toEqual({ ticketNumber: 2 });
      expect(textOf(result), bad).not.toContain('"field"');
    }
  });

  it("drops a string longer than 200 characters but keeps one of 200", async () => {
    expect(detailsOf(await raise({ field: "a".repeat(200) }))).toEqual({
      field: "a".repeat(200),
    });
    const result = await raise({ field: "a".repeat(201), ticketNumber: 3 });
    expect(detailsOf(result)).toEqual({ ticketNumber: 3 });
  });

  it("drops arrays over 50 items or holding anything but strings and numbers", async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `s${i}`);
    expect(detailsOf(await raise({ allowed: fifty }))).toEqual({
      allowed: fifty,
    });
    for (const allowed of [
      [...fifty, "one-more"],
      [{ a: 1 }],
      [null],
      [["nested"]],
      [true],
    ]) {
      const result = await raise({ allowed, ticketNumber: 4 });
      expect(detailsOf(result)).toEqual({ ticketNumber: 4 });
    }
  });

  it("drops nested objects", async () => {
    const result = await raise({ field: { deep: "x" }, ticketNumber: 6 });
    expect(detailsOf(result)).toEqual({ ticketNumber: 6 });
    expect(JSON.stringify(result)).not.toContain("deep");
  });

  it("omits details entirely when nothing survives", async () => {
    const result = await raise({ bogus: 1 });
    expect(result.structuredContent).toEqual({
      error: { code: "conflict", message: "Nope." },
    });
    expect(textOf(result)).toBe(JSON.stringify(result.structuredContent));
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
