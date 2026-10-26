import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { seedWorld, tid, USERS } from "../fixtures";
import {
  freezeDate,
  recordResponse,
  unfreezeDate,
  useSeededDatabase,
} from "./helpers";

// Only auth is mocked: the route calls auth.api.getSession({ headers }).
const getSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));

import { GET } from "@/app/api/tickets/[id]/route";

const agentSession = {
  user: { id: USERS.alice.id, role: "agent", name: "Alice Agent" },
};
const adminSession = {
  user: { id: USERS.bob.id, role: "admin", name: "Bob Admin" },
};

async function get(id: string) {
  const request = new NextRequest(`http://localhost:3000/api/tickets/${id}`);
  return recordResponse(
    await GET(request, { params: Promise.resolve({ id }) })
  );
}

describe("GET /api/tickets/[id] (characterization)", () => {
  useSeededDatabase(seedWorld);
  beforeAll(() => freezeDate());
  afterAll(() => unfreezeDate());
  beforeEach(() => getSession.mockReset());

  it("returns the agent view of a normal ticket (with tags)", async () => {
    getSession.mockResolvedValue(agentSession);
    expect(await get(tid(110))).toMatchSnapshot();
  });

  it("returns a ticket with no tags and an assignee", async () => {
    getSession.mockResolvedValue(adminSession);
    expect(await get(tid(103))).toMatchSnapshot();
  });

  it("forwards a merged ticket id to the ticket it was merged into", async () => {
    getSession.mockResolvedValue(agentSession);
    const forwarded = await get(tid(120));
    expect(forwarded).toMatchSnapshot();
    // identical body to asking for the target directly
    expect(forwarded).toEqual(await get(tid(101)));
  });

  it("forwards a second merged ticket to its target", async () => {
    getSession.mockResolvedValue(agentSession);
    expect(await get(tid(121))).toMatchSnapshot();
  });

  it("returns 404 for an unknown id", async () => {
    getSession.mockResolvedValue(agentSession);
    expect(await get("does-not-exist")).toMatchSnapshot();
  });

  it("returns 401 with no session", async () => {
    getSession.mockResolvedValue(null);
    expect(await get(tid(101))).toMatchSnapshot();
  });

  it("returns 401 for a session without a user", async () => {
    getSession.mockResolvedValue({});
    expect(await get(tid(101))).toMatchSnapshot();
  });

  it("returns 401 for a session whose role is not agent/admin", async () => {
    getSession.mockResolvedValue({ user: { id: USERS.dave.id, role: "user" } });
    expect(await get(tid(101))).toMatchSnapshot();
  });

  it("checks auth before existence (unknown id + no session -> 401)", async () => {
    getSession.mockResolvedValue(null);
    expect(await get("does-not-exist")).toMatchSnapshot();
  });
});
