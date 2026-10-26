import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/stats/overview/route";
import {
  OVERVIEW_AVG_WAIT_CREATED,
  seedClosedOnlyConfig,
  seedConfigOnly,
  seedOnlyClosedTickets,
  seedOverviewWorld,
} from "../fixtures";
import { recordResponse, reseed } from "./helpers";

type Overview = {
  total: number;
  open: number;
  inProgress: number;
  closed: number;
  avgWaitMs: number | null;
};

/** avgWaitMs comes from the DB's NOW(), so the raw number is volatile. Returns
 * the response with that single field masked, plus the raw value + the real
 * time window the request ran in so the caller can bound it. */
async function getOverview() {
  const before = Date.now();
  const res = await GET(
    new NextRequest("http://localhost:3000/api/stats/overview")
  );
  const after = Date.now();
  const recorded = await recordResponse(res);
  const body = recorded.body as Overview;
  const raw = body.avgWaitMs;
  return {
    before,
    after,
    raw,
    masked: {
      status: recorded.status,
      body: {
        ...body,
        avgWaitMs:
          raw === null ? null : "<masked: DB NOW() minus mean createdAt>",
      },
    },
  };
}

// Clock skew allowance between this process and the Postgres container.
const SKEW_MS = 5000;

describe("GET /api/stats/overview (characterization)", () => {
  it("counts a mix of default / in-progress / closed / merged / unknown-status tickets", async () => {
    await reseed(seedOverviewWorld);
    const r = await getOverview();
    expect(r.masked).toMatchSnapshot();

    // avgWaitMs = mean over open+in_progress non-merged tickets of (NOW - createdAt)
    const meanCreated =
      OVERVIEW_AVG_WAIT_CREATED.reduce((a, b) => a + b, 0) /
      OVERVIEW_AVG_WAIT_CREATED.length;
    expect(r.raw).not.toBeNull();
    expect(r.raw as number).toBeGreaterThanOrEqual(
      r.before - meanCreated - SKEW_MS
    );
    expect(r.raw as number).toBeLessThanOrEqual(
      r.after - meanCreated + SKEW_MS
    );
  });

  it("has a null average wait when the config has no non-closed statuses", async () => {
    await reseed(seedClosedOnlyConfig);
    const r = await getOverview();
    expect(r.raw).toBeNull();
    expect(r.masked).toMatchSnapshot();
  });

  it("has a null average wait when statuses exist but no ticket is open", async () => {
    await reseed(seedOnlyClosedTickets);
    const r = await getOverview();
    expect(r.raw).toBeNull();
    expect(r.masked).toMatchSnapshot();
  });

  it("returns zeros and a null average with no tickets at all", async () => {
    await reseed(seedConfigOnly);
    const r = await getOverview();
    expect(r.raw).toBeNull();
    expect(r.masked).toMatchSnapshot();
  });
});
