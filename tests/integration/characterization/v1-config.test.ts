import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Only auth is mocked (as agreed): requireApiKey either resolves or throws the
// 401 Response the real guard throws.
const requireApiKey = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-auth", () => ({ requireApiKey }));

import { GET } from "@/app/api/v1/config/route";
import { seedV1Config } from "../fixtures";
import { recordResponse, useSeededDatabase } from "./helpers";

const get = async () =>
  recordResponse(
    await GET(new NextRequest("http://localhost:3000/api/v1/config"))
  );

describe("GET /api/v1/config (characterization)", () => {
  useSeededDatabase(seedV1Config);
  beforeEach(() => {
    requireApiKey.mockReset();
    requireApiKey.mockResolvedValue({ id: "key-1", name: "Test key" });
  });

  it("returns categories, priorities, statuses, custom fields and tags", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r).toMatchSnapshot();
    expect(requireApiKey).toHaveBeenCalledTimes(1);
  });

  it("passes through the 401 Response thrown by requireApiKey", async () => {
    requireApiKey.mockRejectedValue(
      new Response(JSON.stringify({ error: "Missing API key." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );
    expect(await get()).toMatchSnapshot();
  });
});
