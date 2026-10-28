import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/stats/volume/route";
import { seedVolumeWorld } from "../fixtures";
import {
  freezeDate,
  recordOutcome,
  unfreezeDate,
  useSeededDatabase,
} from "./helpers";

const get = (query: string) =>
  recordOutcome(() =>
    GET(new NextRequest(`http://localhost:3000/api/stats/volume${query}`))
  );

const lengthOf = (r: Awaited<ReturnType<typeof get>>) =>
  r.kind === "response"
    ? (r.body as { days: unknown[] }).days.length
    : undefined;

describe("GET /api/stats/volume (characterization)", () => {
  useSeededDatabase(seedVolumeWorld);
  beforeAll(() => freezeDate());
  afterAll(() => unfreezeDate());

  it("defaults to 7 days when ?days is absent", async () => {
    const r = await get("");
    expect(lengthOf(r)).toBe(7);
    expect(r).toMatchSnapshot();
  });

  it("clamps days=3 up to 7", async () => {
    const r = await get("?days=3");
    expect(lengthOf(r)).toBe(7);
    expect(r).toEqual(await get(""));
  });

  it("days=7 is the same as the default", async () => {
    expect(await get("?days=7")).toEqual(await get(""));
  });

  it("days=14 returns 14 days", async () => {
    const r = await get("?days=14");
    expect(lengthOf(r)).toBe(14);
    expect(r).toMatchSnapshot();
  });

  it("days=30 returns 30 days", async () => {
    const r = await get("?days=30");
    expect(lengthOf(r)).toBe(30);
    expect(r).toMatchSnapshot();
  });

  it("clamps days=100 down to 30", async () => {
    const r = await get("?days=100");
    expect(lengthOf(r)).toBe(30);
    expect(r).toEqual(await get("?days=30"));
  });

  it("clamps zero and negative days up to 7", async () => {
    expect(await get("?days=0")).toEqual(await get(""));
    expect(await get("?days=-5")).toEqual(await get(""));
  });

  it("follows parseInt semantics: 15abc gives 15, 7.9 gives 7", async () => {
    expect(lengthOf(await get("?days=15abc"))).toBe(15);
    expect(lengthOf(await get("?days=7.9"))).toBe(7);
  });

  it("RECORDS what ?days=abc does today (NaN edge case; not fixed)", async () => {
    expect(await get("?days=abc")).toMatchSnapshot();
  });

  it("RECORDS what an empty ?days= does today (parseInt of empty string is NaN too)", async () => {
    expect(await get("?days=")).toMatchSnapshot();
  });

  it("excludes merged tickets", async () => {
    const r = await get("?days=30");
    if (r.kind !== "response") {
      throw new Error("expected a response");
    }
    const days = (r.body as { days: Array<{ date: string; count: number }> })
      .days;
    const byDate = Object.fromEntries(days.map((d) => [d.date, d.count]));
    // 2026-03-15 has 2 real tickets + 1 merged shell; 2026-03-14 has 1 real + 1 merged.
    expect(byDate["2026-03-15"]).toBe(2);
    expect(byDate["2026-03-14"]).toBe(1);
    // total in the 30-day window = fixture offsets 0..29 only
    expect(days.reduce((n, d) => n + d.count, 0)).toBe(10);
  });
});
