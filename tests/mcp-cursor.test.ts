import { describe, expect, it } from "vitest";
import {
  compareThreadPosition,
  decodeThreadCursor,
  encodeThreadCursor,
} from "@/lib/mcp/cursor";

const ISO = "2026-03-10T10:00:00.123Z";

describe("thread cursor", () => {
  it("round-trips createdAt and id", () => {
    const cursor = encodeThreadCursor(ISO, "c-101_2");
    const decoded = decodeThreadCursor(cursor);
    expect(decoded?.id).toBe("c-101_2");
    expect(decoded?.createdAt.toISOString()).toBe(ISO);
  });

  it("is opaque base64url of `createdAt|id`", () => {
    const cursor = encodeThreadCursor(ISO, "abc");
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(cursor, "base64url").toString()).toBe(`${ISO}|abc`);
  });

  it("rejects anything we did not issue", () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    for (const bad of [
      "",
      "x".repeat(201),
      "!!!",
      "AAAA",
      "not-a-cursor",
      b64("no separator"),
      b64("|abc"),
      b64(`${ISO}|`),
      b64("not a date|abc"),
      b64("2026-03-10|abc"),
      b64("2026-03-10T10:00:00Z|abc"),
      b64(`${ISO}|has space`),
      b64(`${ISO}|semi;colon`),
      b64(`${ISO}|${"i".repeat(65)}`),
      `${encodeThreadCursor(ISO, "abc")}=`,
    ]) {
      expect(decodeThreadCursor(bad), bad).toBeNull();
    }
  });
});

describe("compareThreadPosition", () => {
  const p = (iso: string, id: string) => ({ createdAt: new Date(iso), id });

  it("orders by time, then id", () => {
    const items = [
      p("2026-01-01T00:00:02Z", "a"),
      p("2026-01-01T00:00:01Z", "z"),
      p("2026-01-01T00:00:01Z", "b"),
    ];
    expect(items.sort(compareThreadPosition).map((i) => i.id)).toEqual([
      "b",
      "z",
      "a",
    ]);
  });

  it("is zero only for the same position", () => {
    expect(
      compareThreadPosition(
        p("2026-01-01T00:00:00Z", "a"),
        p("2026-01-01T00:00:00Z", "a")
      )
    ).toBe(0);
  });
});
