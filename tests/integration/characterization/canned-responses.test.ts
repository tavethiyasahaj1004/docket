import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/canned-responses/route";
import { seedCannedResponses, USERS } from "../fixtures";
import { recordResponse, useSeededDatabase } from "./helpers";

// The REAL requireAgentFromRequest runs: it reads the x-user-* headers the
// proxy injects after validating the session. Nothing is mocked.
const agentHeaders = {
  "x-user-id": USERS.alice.id,
  "x-user-name": "Alice Agent",
  "x-user-email": USERS.alice.email,
  "x-user-role": "agent",
};

async function get(
  query: string,
  headers: Record<string, string> = agentHeaders
) {
  const request = new NextRequest(
    `http://localhost:3000/api/canned-responses${query}`,
    { headers }
  );
  return recordResponse(await GET(request));
}

const titles = (r: { body: unknown }) =>
  (r.body as Array<{ title: string }>).map((x) => x.title);

describe("GET /api/canned-responses (characterization)", () => {
  useSeededDatabase(seedCannedResponses);

  it("returns every response ordered by title when q is absent", async () => {
    const r = await get("");
    expect(r.status).toBe(200);
    expect(r).toMatchSnapshot();
  });

  it("filters by title with ?q= (substring)", async () => {
    expect(await get("?q=greeting")).toMatchSnapshot();
  });

  it("is case-insensitive", async () => {
    const lower = await get("?q=greeting");
    const upper = await get("?q=GREETING");
    expect(titles(upper)).toEqual(titles(lower));
    expect(upper).toMatchSnapshot();
  });

  it("trims q, and treats empty or whitespace-only q as no filter", async () => {
    const padded = await get("?q=%20%20zeb%20%20");
    expect(titles(padded)).toEqual(["Zebra reply"]);
    expect(padded).toMatchSnapshot();
    const all = await get("");
    expect(titles(await get("?q="))).toEqual(titles(all));
    expect(titles(await get("?q=%20%20"))).toEqual(titles(all));
  });

  it("records today's LIKE wildcard behaviour for a percent in q (not escaped)", async () => {
    const r = await get("?q=%25");
    // The percent is passed through unescaped, so it matches every title.
    expect(titles(r)).toEqual(titles(await get("")));
    expect(r).toMatchSnapshot();
  });

  it("records today's LIKE wildcard behaviour for an underscore in q (not escaped)", async () => {
    const r = await get("?q=_");
    // The underscore matches any single character, so it matches every title.
    expect(titles(r)).toEqual(titles(await get("")));
    expect(r).toMatchSnapshot();
  });

  it("records an underscore acting as a single-character wildcard between letters", async () => {
    // "s_ake" matches "snake_case tips" because the underscore stands for "n".
    const r = await get("?q=s_ake");
    expect(titles(r)).toEqual(["snake_case tips"]);
    expect(r).toMatchSnapshot();
  });

  it("records 100 followed by a percent matching every title containing 100", async () => {
    expect(await get("?q=100%25")).toMatchSnapshot();
  });

  it("returns an empty array when nothing matches", async () => {
    const r = await get("?q=nomatch");
    expect(r).toEqual({ status: 200, body: [] });
  });

  it("returns 403 when the proxy headers are absent (unauthenticated)", async () => {
    expect(await get("", {})).toMatchSnapshot();
  });

  it("returns 403 for a role that is not agent/admin", async () => {
    expect(
      await get("", { ...agentHeaders, "x-user-role": "user" })
    ).toMatchSnapshot();
  });

  it("allows an admin", async () => {
    const r = await get("?q=alpha", {
      ...agentHeaders,
      "x-user-role": "admin",
    });
    expect(r.status).toBe(200);
    expect(r).toMatchSnapshot();
  });
});
