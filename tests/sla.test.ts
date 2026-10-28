import { describe, expect, it } from "vitest";
import { computeWaitingTimeSeconds } from "@/lib/sla";

const NOW = new Date("2026-01-01T12:00:00Z");

describe("computeWaitingTimeSeconds", () => {
  it("uses time since waitingSince for an open ticket", () => {
    const seconds = computeWaitingTimeSeconds(
      {
        closedAt: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        waitingSince: new Date("2026-01-01T10:00:00Z"),
      },
      NOW
    );
    expect(seconds).toBe(2 * 3600);
  });

  it("falls back to createdAt when waitingSince is null", () => {
    const seconds = computeWaitingTimeSeconds(
      {
        closedAt: null,
        createdAt: new Date("2026-01-01T09:00:00Z"),
        waitingSince: null,
      },
      NOW
    );
    expect(seconds).toBe(3 * 3600);
  });

  it("uses createdAt → closedAt for a resolved ticket, ignoring now", () => {
    const seconds = computeWaitingTimeSeconds(
      {
        closedAt: new Date("2026-01-01T01:00:00Z"),
        createdAt: new Date("2026-01-01T00:00:00Z"),
        waitingSince: null,
      },
      NOW
    );
    expect(seconds).toBe(3600);
  });

  it("orders shorter waits before longer ones — Ascending = shortest first", () => {
    const shortWait = computeWaitingTimeSeconds(
      {
        closedAt: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        waitingSince: new Date("2026-01-01T11:50:00Z"),
      },
      NOW
    );
    const longWait = computeWaitingTimeSeconds(
      {
        closedAt: null,
        createdAt: new Date("2025-12-30T00:00:00Z"),
        waitingSince: new Date("2025-12-30T00:00:00Z"),
      },
      NOW
    );
    expect(shortWait).toBeLessThan(longWait);
  });
});
