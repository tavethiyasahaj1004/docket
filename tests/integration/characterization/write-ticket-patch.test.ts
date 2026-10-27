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

import { NextRequest } from "next/server";
import { PATCH } from "@/app/api/tickets/[id]/route";
import {
  actions,
  adminSession,
  agentSession,
  captureEffects,
  ctx,
  type Effects,
  events,
  getSession,
  jsonRequest,
  resetMocks,
  seedWriteWorld,
} from "./write-helpers";

async function patch(id: string, body: unknown) {
  return captureEffects({
    ticketIds: [id],
    invoke: () =>
      PATCH(jsonRequest(`/api/tickets/${id}`, "PATCH", body), ctx(id)),
  });
}

/** Deliveries by event -> the ticket status/category/priority they carry. */
function webhookTicketFields(effects: Effects) {
  return Object.fromEntries(
    effects.deliveries.map((d) => {
      const data = (d.payload as { data: { ticket: Record<string, string> } })
        .data.ticket;
      return [
        d.event as string,
        {
          status: data.status,
          category: data.category,
          priority: data.priority,
        },
      ];
    })
  );
}

describe("PATCH /api/tickets/[id] (characterization)", () => {
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

  describe("status", () => {
    it("open -> another open status: status_changed activity + ticket.status_changed webhook", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await patch(tid(104), {
        status: "in_progress",
      });
      expect(effects.response).toEqual({
        status: 200,
        body: { ok: true, changed: true },
      });
      expect(effects.tickets[0]).toMatchObject({
        status: "in_progress",
        closedAt: null,
      });
      expect(actions(effects)).toEqual(["status_changed"]);
      expect(effects.activity[0]).toMatchObject({
        actorId: USERS.alice.id,
        metadata: { from: "open", to: "in_progress" },
      });
      expect(events(effects)).toEqual(["ticket.status_changed"]);
      expect(effects.emails).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(normalized).toMatchSnapshot();
    });

    it("open -> closed (generic close): ticket_closed + ticket.closed, but NO email, NO flag/SLA reset", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await patch(tid(101), {
        status: "closed",
      });
      expect(effects.response.body).toEqual({ ok: true, changed: true });
      expect(actions(effects)).toEqual(["ticket_closed"]);
      expect(events(effects)).toEqual(["ticket.closed"]);
      expect(effects.emails).toEqual([]);
      expect(effects.calls.some((c) => c.job === "email.send")).toBe(false);
      // unlike the dedicated /close route: still awaiting, SLA untouched
      expect(effects.tickets[0]).toMatchObject({
        status: "closed",
        awaitingReply: true,
        pendingReplies: 0,
        slaActiveSeconds: 0,
      });
      expect(effects.tickets[0].closedAt).toEqual(effects.tickets[0].updatedAt);
      expect(effects.tickets[0].waitingSince).not.toBeNull();
      expect(normalized).toMatchSnapshot();
    });

    it("closed -> open status: closedAt cleared, status_changed activity, ticket.reopened webhook", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await patch(tid(108), {
        status: "open",
      });
      expect(effects.tickets[0]).toMatchObject({
        status: "open",
        closedAt: null,
      });
      // closing logs ticket_closed, but re-opening logs a plain status_changed
      expect(actions(effects)).toEqual(["status_changed"]);
      expect(events(effects)).toEqual(["ticket.reopened"]);
      expect(effects.emails).toEqual([]);
      expect(normalized).toMatchSnapshot();
    });

    it("invalid status -> 400 and nothing written", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await patch(tid(104), {
        status: "bogus",
      });
      expect(effects.response).toEqual({
        status: 400,
        body: { error: "Invalid status." },
      });
      expect(effects.ticketDiff).toEqual({});
      expect(normalized).toMatchSnapshot();
    });
  });

  describe("category / priority / assignment", () => {
    it("category change: category_changed + ticket.category_changed (previousCategory)", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await patch(tid(104), {
        category: "bug",
      });
      expect(effects.tickets[0]).toMatchObject({ category: "bug" });
      expect(actions(effects)).toEqual(["category_changed"]);
      expect(events(effects)).toEqual(["ticket.category_changed"]);
      expect(
        (effects.deliveries[0].payload as { data: Record<string, unknown> })
          .data.previousCategory
      ).toBe("billing");
      expect(normalized).toMatchSnapshot();
    });

    it("priority change: priority_changed + ticket.priority_changed (previousPriority)", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(adminSession);
      const { effects, normalized } = await patch(tid(104), {
        priority: "urgent",
      });
      expect(effects.tickets[0]).toMatchObject({ priority: "urgent" });
      expect(actions(effects)).toEqual(["priority_changed"]);
      expect(events(effects)).toEqual(["ticket.priority_changed"]);
      expect(effects.activity[0]).toMatchObject({
        actorRole: "admin",
        metadata: { from: "low", to: "urgent" },
      });
      expect(normalized).toMatchSnapshot();
    });

    it("assign an unassigned ticket, then unassign it (assignedAgentId: null)", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const assign = await patch(tid(104), { assignedAgentId: USERS.bob.id });
      expect(assign.effects.tickets[0]).toMatchObject({
        assignedAgentId: USERS.bob.id,
      });
      expect(actions(assign.effects)).toEqual(["assigned"]);
      expect(assign.effects.activity[0]).toMatchObject({
        metadata: { agentId: USERS.bob.id },
      });
      expect(events(assign.effects)).toEqual(["ticket.assigned"]);

      const unassign = await patch(tid(104), { assignedAgentId: null });
      expect(unassign.effects.tickets[0]).toMatchObject({
        assignedAgentId: null,
      });
      expect(actions(unassign.effects)).toEqual(["unassigned"]);
      expect(unassign.effects.activity[0]).toMatchObject({ metadata: null });
      expect(events(unassign.effects)).toEqual(["ticket.unassigned"]);
      expect(
        (
          unassign.effects.deliveries[0].payload as {
            data: Record<string, unknown>;
          }
        ).data.assignedAgentId
      ).toBeNull();
      expect({
        assign: assign.normalized,
        unassign: unassign.normalized,
      }).toMatchSnapshot();
    });

    it("reassign to another agent is a plain 'assigned' (no unassigned step)", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await patch(tid(101), {
        assignedAgentId: USERS.bob.id,
      });
      expect(actions(effects)).toEqual(["assigned"]);
      expect(events(effects)).toEqual(["ticket.assigned"]);
      expect(normalized).toMatchSnapshot();
    });

    it("assignee is not validated beyond the FK: a banned agent and a plain user are accepted", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const banned = await patch(tid(104), {
        assignedAgentId: USERS.carol.id,
      });
      const plain = await patch(tid(104), { assignedAgentId: USERS.dave.id });
      expect(banned.effects.tickets[0]).toMatchObject({
        assignedAgentId: USERS.carol.id,
      });
      expect(plain.effects.tickets[0]).toMatchObject({
        assignedAgentId: USERS.dave.id,
      });
      expect(actions(banned.effects)).toEqual(["assigned"]);
      expect(actions(plain.effects)).toEqual(["assigned"]);
    });

    it("unknown or empty-string assignee is NOT caught: the FK violation escapes the handler (no 4xx)", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const outcomes: Record<string, unknown> = {};
      for (const [label, value] of [
        ["unknown", "user-nobody"],
        ["emptyString", ""],
      ] as const) {
        const r = await captureEffects({
          ticketIds: [tid(104)],
          invoke: async () => {
            try {
              return await PATCH(
                jsonRequest(`/api/tickets/${tid(104)}`, "PATCH", {
                  assignedAgentId: value,
                }),
                ctx(tid(104))
              );
            } catch (error) {
              const e = error as Error & {
                cause?: { code?: string; constraint_name?: string };
              };
              return Response.json(
                {
                  thrown: true,
                  name: e.name,
                  pgCode: e.cause?.code,
                  constraint: e.cause?.constraint_name,
                },
                { status: 599 }
              );
            }
          },
        });
        expect(r.effects.response.status).toBe(599);
        expect(r.effects.ticketDiff).toEqual({});
        expect(r.effects.activity).toEqual([]);
        expect(r.effects.deliveries).toEqual([]);
        outcomes[label] = r.normalized.response;
      }
      expect(outcomes).toMatchSnapshot();
    });
  });

  describe("combined / partial / no-op bodies", () => {
    it("status + category + priority + assignee in one request: four events, payloads built from the PRE-change ticket", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await patch(tid(104), {
        status: "in_progress",
        category: "bug",
        priority: "urgent",
        assignedAgentId: USERS.alice.id,
      });
      expect(effects.response.body).toEqual({ ok: true, changed: true });
      expect(effects.tickets[0]).toMatchObject({
        status: "in_progress",
        category: "bug",
        priority: "urgent",
        assignedAgentId: USERS.alice.id,
      });
      expect(actions(effects).sort()).toEqual([
        "assigned",
        "category_changed",
        "priority_changed",
        "status_changed",
      ]);
      // Webhook jobs are enqueued in code order (status, category, priority,
      // assignment): map each queued delivery id back to its event.
      const eventByDelivery = new Map(
        effects.deliveries.map((d) => [d.id, d.event])
      );
      expect(
        effects.calls
          .filter((c) => c.job === "webhook.send")
          .map((c) =>
            eventByDelivery.get(
              (c.payload as { deliveryId: string }).deliveryId
            )
          )
      ).toEqual([
        "ticket.status_changed",
        "ticket.category_changed",
        "ticket.priority_changed",
        "ticket.assigned",
      ]);
      // Stale payloads: only the status event carries the NEW status; the
      // category/priority/assignment events still say status=open (old), and
      // the status event still carries the OLD category/priority.
      expect(webhookTicketFields(effects)).toEqual({
        "ticket.status_changed": {
          status: "in_progress",
          category: "billing",
          priority: "low",
        },
        "ticket.category_changed": {
          status: "open",
          category: "bug",
          priority: "low",
        },
        "ticket.priority_changed": {
          status: "open",
          category: "billing",
          priority: "urgent",
        },
        "ticket.assigned": {
          status: "open",
          category: "billing",
          priority: "low",
        },
      });
      expect(normalized).toMatchSnapshot();
    });

    it("valid status + invalid category -> 400, but the status change is ALREADY persisted (with its activity + webhook)", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await patch(tid(104), {
        status: "in_progress",
        category: "nope",
      });
      expect(effects.response).toEqual({
        status: 400,
        body: { error: "Invalid category." },
      });
      expect(effects.tickets[0]).toMatchObject({ status: "in_progress" });
      expect(actions(effects)).toEqual(["status_changed"]);
      expect(events(effects)).toEqual(["ticket.status_changed"]);
      expect(normalized).toMatchSnapshot();
    });

    it("valid category + invalid priority -> 400, category already persisted; later fields never run", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await patch(tid(104), {
        category: "bug",
        priority: "nope",
        assignedAgentId: USERS.bob.id,
      });
      expect(effects.response).toEqual({
        status: 400,
        body: { error: "Invalid priority." },
      });
      expect(effects.tickets[0]).toMatchObject({
        category: "bug",
        priority: "low",
        assignedAgentId: null,
      });
      expect(actions(effects)).toEqual(["category_changed"]);
      expect(normalized).toMatchSnapshot();
    });

    it("no-op bodies (same values / empty / null on unassigned) -> changed:false, nothing written", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const same = await patch(tid(101), {
        status: "open",
        category: "bug",
        priority: "high",
        assignedAgentId: USERS.alice.id,
      });
      const empty = await patch(tid(101), {});
      const nullOnUnassigned = await patch(tid(104), {
        assignedAgentId: null,
      });
      const unknownKey = await patch(tid(101), { subject: "new subject" });
      for (const r of [same, empty, nullOnUnassigned, unknownKey]) {
        expect(r.effects.response).toEqual({
          status: 200,
          body: { ok: true, changed: false },
        });
        expect(r.effects.ticketDiff).toEqual({});
        expect(r.effects.activity).toEqual([]);
        expect(r.effects.deliveries).toEqual([]);
        expect(r.effects.calls).toEqual([]);
      }
      expect({
        same: same.normalized,
        empty: empty.normalized.response,
        nullOnUnassigned: nullOnUnassigned.normalized.response,
        unknownKey: unknownKey.normalized.response,
      }).toMatchSnapshot();
    });
  });

  describe("errors", () => {
    it("merged shell -> 409 (not forwarded); unknown -> 404", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const merged = await patch(tid(120), { status: "open" });
      const mergedNoop = await patch(tid(120), {});
      const unknown = await patch("does-not-exist", { status: "open" });
      expect(merged.effects.response.status).toBe(409);
      expect(mergedNoop.effects.response.status).toBe(409);
      expect(unknown.effects.response).toEqual({
        status: 404,
        body: { error: "Not found." },
      });
      for (const r of [merged, mergedNoop, unknown]) {
        expect(r.effects.ticketDiff).toEqual({});
        expect(r.effects.deliveries).toEqual([]);
      }
      expect({
        merged: merged.normalized.response,
        unknown: unknown.normalized.response,
      }).toMatchSnapshot();
    });

    it("no session / non-agent role -> 401 (auth before existence)", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(null);
      const anon = await patch(tid(101), { status: "closed" });
      const anonUnknown = await patch("does-not-exist", { status: "closed" });
      getSession.mockResolvedValue({
        user: { id: USERS.dave.id, role: "user", name: USERS.dave.name },
      });
      const plain = await patch(tid(101), { status: "closed" });
      expect(anon.effects.response).toEqual({
        status: 401,
        body: { error: "Unauthorized." },
      });
      expect(anonUnknown.effects.response.status).toBe(401);
      expect(plain.effects.response.status).toBe(401);
      expect(plain.effects.ticketDiff).toEqual({});
      expect({
        anon: anon.normalized.response,
        plain: plain.normalized.response,
      }).toMatchSnapshot();
    });

    it("invalid JSON body -> 400, checked before the ticket is looked up", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const bad = (id: string) =>
        captureEffects({
          ticketIds: [tid(101)],
          invoke: () =>
            PATCH(
              new NextRequest(`http://localhost:3000/api/tickets/${id}`, {
                method: "PATCH",
                body: "not json",
              }),
              ctx(id)
            ),
        });
      const known = await bad(tid(101));
      const unknown = await bad("does-not-exist");
      const merged = await bad(tid(120));
      for (const r of [known, unknown, merged]) {
        expect(r.effects.response).toEqual({
          status: 400,
          body: { error: "Invalid request body." },
        });
      }
      expect(known.normalized.response).toMatchSnapshot();
    });
  });
});
