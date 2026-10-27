import { createId } from "@paralleldrive/cuid2";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { parseTicketRef } from "@/lib/mcp/ticket-ref";

describe("parseTicketRef", () => {
  it("parses numbers in every accepted spelling", () => {
    for (const value of [1042, "1042", "#1042", " #1042 ", "  1042"]) {
      expect(parseTicketRef(value), String(value)).toEqual({
        kind: "number",
        number: 1042,
        id: null,
      });
    }
  });

  it("parses a cuid2 id", () => {
    const id = createId();
    expect(id).toMatch(/^[a-z0-9]{20,32}$/);
    expect(parseTicketRef(id)).toEqual({ kind: "id", id });
    expect(parseTicketRef(` ${id} `)).toEqual({ kind: "id", id });
  });

  it("tries numbers first, and keeps an all-digit long id as a fallback", () => {
    const digits = "9".repeat(22);
    expect(parseTicketRef(digits)).toEqual({ kind: "id", id: digits });
    // Fits in int4: the number wins, and the id reading is not offered.
    expect(parseTicketRef("2147483647")).toMatchObject({ kind: "number" });
  });

  it("rejects everything else", () => {
    for (const value of [
      "",
      "   ",
      "#",
      "abc",
      "1.5",
      "-4",
      "0",
      "#0",
      "t-101",
      "TICKET1234567890123456",
      "short",
      "x".repeat(33),
      2_147_483_648,
      1.5,
      -1,
      null,
      undefined,
      {},
      [],
      true,
    ]) {
      expect(parseTicketRef(value), String(value)).toBeNull();
    }
  });
});
