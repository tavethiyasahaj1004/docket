import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/agents/route";
import { seedUsers } from "../fixtures";
import { recordResponse, useSeededDatabase } from "./helpers";

describe("GET /api/agents (characterization)", () => {
  useSeededDatabase(seedUsers);

  it("lists non-banned agents and admins only (no user role, no banned)", async () => {
    const res = await GET(new NextRequest("http://localhost:3000/api/agents"));
    const recorded = await recordResponse(res);
    expect(recorded).toMatchSnapshot();

    const ids = (recorded.body as Array<{ id: string }>)
      .map((a) => a.id)
      .sort();
    expect(ids).toEqual(["user-alice", "user-bob"]);
  });
});
