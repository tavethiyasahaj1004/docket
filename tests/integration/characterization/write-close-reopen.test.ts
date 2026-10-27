import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { tid, USERS } from "../fixtures";
import { freezeDate, unfreezeDate } from "./helpers";

vi.mock("@/lib/auth", async () =>
  (await import("./write-helpers")).authModule()
);
vi.mock("@/lib/worker/enqueue", async () =>
  (await import("./write-helpers")).enqueueModule()
);
vi.mock("@/lib/realtime", async (importOriginal) =>
  (await import("./write-helpers")).realtimeModule(
    await importOriginal<Record<string, unknown>>()
  )
);
vi.mock("@/lib/push", async (importOriginal) =>
  (await import("./write-helpers")).pushModule(
    await importOriginal<Record<string, unknown>>()
  )
);

import { PATCH as CLOSE } from "@/app/api/tickets/[id]/close/route";
import { PATCH as REOPEN } from "@/app/api/tickets/[id]/reopen/route";
import {
  actions,
  adminSession,
  agentSession,
  captureEffects,
  ctx,
  deleteStatusBy,
  events,
  getSession,
  jobs,
  jsonRequest,
  resetMocks,
  seedWriteWorld,
} from "./write-helpers";

type Handler = typeof CLOSE;

async function patch(
  handler: Handler,
  verb: "close" | "reopen",
  id: string,
  body: unknown,
  opts: { expectEmail?: boolean; ticketIds?: string[] } = {}
) {
  return captureEffects({
    ticketIds: opts.ticketIds ?? [id],
    expectEmail: opts.expectEmail ?? false,
    invoke: () =>
      handler(
        jsonRequest(`/api/tickets/${id}/${verb}`, "PATCH", body),
        ctx(id)
      ),
  });
}

const close = (id: string, body?: unknown, o?: { expectEmail?: boolean }) =>
  patch(CLOSE, "close", id, body, o);
const reopen = (id: string, body?: unknown) =>
  patch(REOPEN, "reopen", id, body);

describe("PATCH /api/tickets/[id]/close + /reopen (characterization)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => freezeDate());
  afterAll(() => unfreezeDate());
  beforeEach(() => {
    resetMocks();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    return () => {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    };
  });

  describe("close", () => {
    it("agent closes an open awaiting ticket: status, closedAt, flags, SLA, activity, webhook, email", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await close(tid(101), undefined, {
        expectEmail: true,
      });
      expect(effects.response).toEqual({
        status: 200,
        body: { status: "closed" },
      });
      expect(effects.tickets[0]).toMatchObject({
        status: "closed",
        closedAt: effects.tickets[0].updatedAt,
        awaitingReply: false,
        pendingReplies: 0,
        slaActiveSeconds: 14_400,
      });
      expect(effects.activity).toHaveLength(1);
      expect(effects.activity[0]).toMatchObject({
        action: "ticket_closed",
        actorId: USERS.alice.id,
        actorRole: "agent",
        metadata: { from: "open", to: "closed" },
      });
      expect(events(effects)).toEqual(["ticket.closed"]);
      expect(effects.emails).toHaveLength(1);
      expect(effects.emails[0]).toMatchObject({ to: "ann@example.test" });
      expect(String(effects.emails[0].subject)).toContain("#101");
      expect(jobs(effects, "email.send")).toHaveLength(1);
      expect(effects.notifications).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(normalized).toMatchSnapshot();
    });

    it("agent closes an open ticket that was not awaiting (no SLA span to flush)", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(adminSession);
      const { effects, normalized } = await close(tid(104), undefined, {
        expectEmail: true,
      });
      expect(effects.response.status).toBe(200);
      expect(effects.activity[0]).toMatchObject({ actorRole: "admin" });
      expect(normalized).toMatchSnapshot();
    });

    it("customer closes through the portal token: actor is the customer, same webhook + email", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(null);
      const { effects, normalized } = await close(
        tid(101),
        { token: "token-101" },
        { expectEmail: true }
      );
      expect(effects.response).toEqual({
        status: 200,
        body: { status: "closed" },
      });
      expect(effects.activity[0]).toMatchObject({
        action: "ticket_closed",
        actorId: null,
        actorName: "Ann Adams",
        actorRole: "customer",
      });
      expect(events(effects)).toEqual(["ticket.closed"]);
      expect(effects.emails).toHaveLength(1);
      expect(normalized).toMatchSnapshot();
    });

    it("a session beats a token on close (opposite of /comments): the actor is the agent", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await close(
        tid(101),
        { token: "token-101" },
        { expectEmail: true }
      );
      expect(effects.activity[0]).toMatchObject({
        actorId: USERS.alice.id,
        actorRole: "agent",
      });
      expect(normalized).toMatchSnapshot();
    });

    it("an agent session can close with a wrong token in the body (token ignored)", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects } = await close(
        tid(101),
        { token: "token-nope" },
        { expectEmail: true }
      );
      expect(effects.response.status).toBe(200);
    });

    it("notifications OFF: still closes and fires the webhook, but zero outbox rows", async () => {
      await seedWriteWorld({ emailNotifications: false });
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await close(tid(101));
      expect(effects.response.status).toBe(200);
      expect(events(effects)).toEqual(["ticket.closed"]);
      expect(effects.emails).toEqual([]);
      expect(jobs(effects, "email.send")).toEqual([]);
      expect(normalized).toMatchSnapshot();
    });

    it("errors: already closed 400, merged 409, unknown 404, no auth 401", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const already = await close(tid(108));
      const merged = await close(tid(120), undefined, undefined);
      const unknown = await close("does-not-exist");
      getSession.mockResolvedValue(null);
      const anon = await close(tid(101));
      const anonUnknown = await close("does-not-exist");
      expect(already.effects.response).toEqual({
        status: 400,
        body: { error: "Ticket is already closed." },
      });
      expect(merged.effects.response.status).toBe(409);
      expect(unknown.effects.response).toEqual({
        status: 404,
        body: { error: "Ticket not found." },
      });
      expect(anon.effects.response).toEqual({
        status: 401,
        body: { error: "Unauthorized." },
      });
      // auth is checked before existence
      expect(anonUnknown.effects.response.status).toBe(401);
      for (const r of [already, merged, unknown, anon, anonUnknown]) {
        expect(r.effects.deliveries).toEqual([]);
        expect(r.effects.emails).toEqual([]);
        expect(r.effects.activity).toEqual([]);
      }
      expect({
        already: already.normalized,
        merged: merged.normalized.response,
        unknown: unknown.normalized.response,
        anon: anon.normalized.response,
        anonUnknown: anonUnknown.normalized.response,
      }).toMatchSnapshot();
    });

    it("customer-token errors: wrong token 404, unknown id 404, closed 400, merged shell 409 (not forwarded)", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(null);
      const wrong = await close(tid(101), { token: "token-999" });
      const unknown = await close("does-not-exist", { token: "token-101" });
      const closed = await close(tid(108), { token: "token-108" });
      const merged = await close(tid(120), { token: "token-120" });
      expect(wrong.effects.response.status).toBe(404);
      expect(unknown.effects.response.status).toBe(404);
      expect(closed.effects.response.status).toBe(400);
      expect(merged.effects.response.status).toBe(409);
      expect({
        wrong: wrong.normalized.response,
        unknown: unknown.normalized.response,
        closed: closed.normalized.response,
        merged: merged.normalized.response,
      }).toMatchSnapshot();
    });

    it("no closed status configured -> 400 and nothing written", async () => {
      await seedWriteWorld({
        extra: (db) => deleteStatusBy(db, "closed"),
      });
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await close(tid(101));
      expect(effects.response).toEqual({
        status: 400,
        body: { error: "No closed status is configured." },
      });
      expect(effects.ticketDiff).toEqual({});
      expect(normalized).toMatchSnapshot();
    });
  });

  describe("reopen", () => {
    it("agent reopens a closed ticket: default status, flags cleared, SLA restarted, webhook, NO email", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await reopen(tid(108));
      expect(effects.response).toEqual({
        status: 200,
        body: { status: "open" },
      });
      expect(effects.tickets[0]).toMatchObject({
        status: "open",
        closedAt: null,
        awaitingReply: false,
        pendingReplies: 0,
      });
      expect(effects.activity).toHaveLength(1);
      expect(effects.activity[0]).toMatchObject({
        action: "ticket_reopened",
        metadata: { from: "closed", to: "open" },
      });
      expect(events(effects)).toEqual(["ticket.reopened"]);
      expect(effects.emails).toEqual([]);
      expect(effects.notifications).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(normalized).toMatchSnapshot();
    });

    it("agent reopens a closed ticket that still had awaitingReply=true: it is cleared", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await reopen(tid(107));
      expect(effects.tickets[0]).toMatchObject({
        awaitingReply: false,
        pendingReplies: 0,
      });
      expect(normalized).toMatchSnapshot();
    });

    it("customer reopens through the portal token: awaiting + pendingReplies=1, no agent notification", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(null);
      const { effects, normalized } = await reopen(tid(108), {
        token: "token-108",
      });
      expect(effects.response).toEqual({
        status: 200,
        body: { status: "open" },
      });
      expect(effects.tickets[0]).toMatchObject({
        status: "open",
        awaitingReply: true,
        pendingReplies: 1,
      });
      expect(effects.activity[0]).toMatchObject({
        action: "ticket_reopened",
        actorRole: "customer",
        actorId: null,
        actorName: "Pat Percent",
      });
      expect(events(effects)).toEqual(["ticket.reopened"]);
      expect(actions(effects)).toEqual(["ticket_reopened"]);
      expect(effects.notifications).toEqual([]);
      expect(effects.emails).toEqual([]);
      expect(normalized).toMatchSnapshot();
    });

    it("errors: not closed 400, merged 409, unknown 404, no auth 401", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const open = await reopen(tid(101));
      const merged = await reopen(tid(120));
      const unknown = await reopen("does-not-exist");
      getSession.mockResolvedValue(null);
      const anon = await reopen(tid(108));
      const wrongToken = await reopen(tid(108), { token: "token-999" });
      const customerOpen = await reopen(tid(101), { token: "token-101" });
      expect(open.effects.response).toEqual({
        status: 400,
        body: { error: "Ticket is not closed." },
      });
      expect(merged.effects.response.status).toBe(409);
      expect(unknown.effects.response.status).toBe(404);
      expect(anon.effects.response.status).toBe(401);
      expect(wrongToken.effects.response.status).toBe(404);
      expect(customerOpen.effects.response.status).toBe(400);
      expect({
        open: open.normalized.response,
        merged: merged.normalized.response,
        unknown: unknown.normalized.response,
        anon: anon.normalized.response,
        wrongToken: wrongToken.normalized.response,
        customerOpen: customerOpen.normalized.response,
      }).toMatchSnapshot();
    });

    it("no default status configured -> 400 and nothing written", async () => {
      await seedWriteWorld({
        extra: (db) => deleteStatusBy(db, "default"),
      });
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await reopen(tid(108));
      expect(effects.response).toEqual({
        status: 400,
        body: { error: "No default status is configured." },
      });
      expect(effects.ticketDiff).toEqual({});
      expect(normalized).toMatchSnapshot();
    });
  });
});
