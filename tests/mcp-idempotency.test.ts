import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import {
  IDEMPOTENCY_INDEX,
  PlannedEntityExistsError,
  TICKET_LOCK_INDEX,
  toStoredError,
  toToolError,
  violatedIndex,
} from "@/lib/mcp/idempotency";
import { sanitizeResultJson } from "@/lib/mcp/result-json";

describe("sanitizeResultJson", () => {
  it("keeps ids, numbers, booleans, null, slugs and ISO timestamps", () => {
    const input = {
      commentId: "ckx9f0w3a0000qz1h8v2n4t6y",
      ticketNumber: 1042,
      alreadyClosed: true,
      replayed: false,
      none: null,
      status: "in_progress",
      createdAt: "2026-03-15T12:00:00.000Z",
      withOffset: "2026-03-15T12:00:00+02:00",
    };
    expect(sanitizeResultJson(input)).toEqual(input);
  });

  it("drops strings with whitespace, an @, or more than 64 characters", () => {
    expect(
      sanitizeResultJson({
        keep: "abc",
        spaced: "two words",
        newline: "line\nbreak",
        email: "ann@example.test",
        handle: "@ann",
        long: "a".repeat(65),
        empty: "",
        markup: "<b>x</b>",
      })
    ).toEqual({ keep: "abc" });
    expect(sanitizeResultJson({ edge: "a".repeat(64) })).toEqual({
      edge: "a".repeat(64),
    });
  });

  it("drops non-finite numbers, undefined, functions, bigints and symbols", () => {
    expect(
      sanitizeResultJson({
        ok: 1,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        undef: undefined,
        fn: () => 1,
        big: BigInt(1),
        sym: Symbol("x"),
      })
    ).toEqual({ ok: 1 });
  });

  it("sanitizes nested objects and arrays, dropping what is unsafe", () => {
    expect(
      sanitizeResultJson({
        ids: ["a1", "has space", 3, "b2"],
        nested: { id: "n1", body: "free text here", deeper: { x: 1 } },
      })
    ).toEqual({ ids: ["a1", 3, "b2"], nested: { id: "n1", deeper: { x: 1 } } });
  });

  it("drops keys that are not plain identifiers", () => {
    expect(
      sanitizeResultJson({ "a b": 1, "x@y": 2, "": 3, good_key: 4 })
    ).toEqual({ good_key: 4 });
  });

  it("caps depth and array length", () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    expect(sanitizeResultJson(deep)).toEqual({ a: { b: { c: {} } } });
    const many = sanitizeResultJson({
      list: Array.from({ length: 80 }, (_, i) => i),
    }) as { list: number[] };
    expect(many.list).toHaveLength(50);
  });

  it("returns {} for anything that is not a plain object", () => {
    for (const value of [null, undefined, "text", 5, true, ["a"]]) {
      expect(sanitizeResultJson(value)).toEqual({});
    }
  });

  it("never lets a message body or address through, whatever the key", () => {
    const out = JSON.stringify(
      sanitizeResultJson({
        commentId: "c1",
        content: "Dear Ann, your refund is on the way.",
        customerEmail: "ann@example.test",
        subject: "Order 1005 delayed",
      })
    );
    expect(out).toBe('{"commentId":"c1"}');
  });
});

describe("violatedIndex", () => {
  const pgError = (constraint: string, message = "duplicate key") => {
    const cause = Object.assign(new Error(message), {
      code: "23505",
      constraint_name: constraint,
    });
    return Object.assign(new Error("Failed query"), { cause });
  };

  it("tells the two partial indexes apart by constraint name", () => {
    expect(violatedIndex(pgError(IDEMPOTENCY_INDEX))).toBe("idempotency");
    expect(violatedIndex(pgError(TICKET_LOCK_INDEX))).toBe("ticket_lock");
  });

  it("reads the name from an unwrapped driver error too", () => {
    const raw = Object.assign(new Error("duplicate"), {
      code: "23505",
      constraint_name: TICKET_LOCK_INDEX,
    });
    expect(violatedIndex(raw)).toBe("ticket_lock");
  });

  it("falls back to the message when the driver gives no name", () => {
    const cause = Object.assign(
      new Error(`duplicate key value violates "${IDEMPOTENCY_INDEX}"`),
      { code: "23505" }
    );
    expect(violatedIndex(Object.assign(new Error("q"), { cause }))).toBe(
      "idempotency"
    );
  });

  it("reports other unique violations as other, and non-unique as null", () => {
    expect(violatedIndex(pgError("mcp_tool_calls_pkey"))).toBe("other");
    expect(violatedIndex(new Error("boom"))).toBeNull();
    expect(violatedIndex(null)).toBeNull();
  });
});

describe("toStoredError", () => {
  it("keeps a safe message and allowlisted details", () => {
    expect(
      toStoredError(
        "merged",
        "This ticket was merged.",
        { mergedIntoTicketNumber: 7 },
        "req-1"
      )
    ).toEqual({
      code: "merged",
      message: "This ticket was merged.",
      details: { mergedIntoTicketNumber: 7 },
    });
  });

  it("replaces a message that carries an address, and drops unknown details", () => {
    const stored = toStoredError(
      "conflict",
      "Conflict with ann@example.test",
      { secret: "x" } as never,
      "req-1"
    );
    expect(stored).toEqual({
      code: "conflict",
      message: "The request failed (conflict).",
    });
  });

  it("toToolError rebuilds a throwable error", () => {
    const err = toToolError({
      code: "in_progress",
      message: "Retry later.",
      details: { retryAfterSeconds: 3 },
    });
    expect(err.code).toBe("in_progress");
    expect(err.details).toEqual({ retryAfterSeconds: 3 });
  });
});

describe("PlannedEntityExistsError", () => {
  it("is an Error with a stable name", () => {
    const err = new PlannedEntityExistsError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PlannedEntityExistsError");
  });
});
