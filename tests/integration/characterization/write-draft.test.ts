import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { doc, FIXED_NOW, tid, USERS } from "../fixtures";
import { freezeDate, unfreezeDate } from "./helpers";

vi.mock("@/lib/auth", async () =>
  (await import("./write-helpers")).authModule()
);
vi.mock("@/lib/worker/enqueue", async () =>
  (await import("./write-helpers")).enqueueModule()
);

import { NextRequest } from "next/server";
import { DELETE, PUT } from "@/app/api/tickets/[id]/draft/route";
import {
  agentSession,
  captureEffects,
  ctx,
  getSession,
  jsonRequest,
  resetMocks,
  seedWriteWorld,
} from "./write-helpers";

const EMPTY_DOC = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph" }],
});

function put(id: string, body: unknown) {
  return captureEffects({
    ticketIds: [id],
    invoke: () =>
      PUT(jsonRequest(`/api/tickets/${id}/draft`, "PUT", body), ctx(id)),
  });
}

function del(id: string) {
  return captureEffects({
    ticketIds: [id],
    invoke: () =>
      DELETE(jsonRequest(`/api/tickets/${id}/draft`, "DELETE"), ctx(id)),
  });
}

describe("PUT/DELETE /api/tickets/[id]/draft (characterization)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => freezeDate());
  afterAll(() => unfreezeDate());
  beforeEach(() => {
    resetMocks();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    return () => errorSpy.mockRestore();
  });

  describe("PUT", () => {
    it("creates the caller's draft (other agents' drafts on the ticket untouched)", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await put(tid(101), {
        content: doc("my new draft"),
        isInternal: false,
      });
      expect(effects.response).toEqual({
        status: 200,
        body: { draft: { updatedAt: FIXED_NOW.toISOString() } },
      });
      expect(effects.drafts.map((d) => d.userId)).toEqual([
        USERS.alice.id,
        USERS.bob.id,
      ]);
      expect(effects.drafts[0]).toMatchObject({
        content: doc("my new draft"),
        isInternal: false,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      });
      // a draft write never touches the ticket, activity, webhooks or mail
      expect(effects.ticketDiff).toEqual({});
      expect(effects.activity).toEqual([]);
      expect(effects.deliveries).toEqual([]);
      expect(effects.calls).toEqual([]);
      expect(normalized).toMatchSnapshot();
    });

    it("updates an existing draft in place: content + isInternal replaced, createdAt kept", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await put(tid(102), {
        content: doc("edited draft"),
        isInternal: true,
      });
      expect(effects.response.status).toBe(200);
      expect(effects.drafts).toHaveLength(1);
      expect(effects.drafts[0]).toMatchObject({
        content: doc("edited draft"),
        isInternal: true,
        createdAt: new Date("2026-03-14T10:00:00.000Z"),
        updatedAt: FIXED_NOW,
      });
      expect(normalized).toMatchSnapshot();
    });

    it("the 200000-char ceiling is inclusive", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const ok = await put(tid(104), {
        content: "x".repeat(200_000),
        isInternal: false,
      });
      const tooBig = await put(tid(105), {
        content: "x".repeat(200_001),
        isInternal: false,
      });
      expect(ok.effects.response.status).toBe(200);
      expect(tooBig.effects.response).toEqual({
        status: 400,
        body: { error: "Invalid draft." },
      });
      expect(tooBig.effects.drafts).toEqual([]);
    });

    it("empty content deletes the caller's draft and answers {draft:null}", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const blank = await put(tid(102), { content: "", isInternal: false });
      expect(blank.effects.response).toEqual({
        status: 200,
        body: { draft: null },
      });
      expect(blank.effects.drafts).toEqual([]);

      await seedWriteWorld();
      const emptyDoc = await put(tid(102), {
        content: EMPTY_DOC,
        isInternal: true,
      });
      expect(emptyDoc.effects.response.body).toEqual({ draft: null });
      expect(emptyDoc.effects.drafts).toEqual([]);

      // another user's draft is never deleted by this
      const other = await put(tid(101), { content: "  ", isInternal: false });
      expect(other.effects.response.body).toEqual({ draft: null });
      expect(other.effects.drafts.map((d) => d.userId)).toEqual([USERS.bob.id]);
      expect(blank.normalized).toMatchSnapshot();
    });

    it("empty content for an unknown ticket is still 200 {draft:null} (existence is checked only for non-empty drafts)", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const empty = await put("does-not-exist", {
        content: "",
        isInternal: false,
      });
      const nonEmpty = await put("does-not-exist", {
        content: doc("hello"),
        isInternal: false,
      });
      expect(empty.effects.response).toEqual({
        status: 200,
        body: { draft: null },
      });
      expect(nonEmpty.effects.response).toEqual({
        status: 404,
        body: { error: "Ticket not found." },
      });
      expect({
        empty: empty.normalized.response,
        nonEmpty: nonEmpty.normalized.response,
      }).toMatchSnapshot();
    });

    it("invalid body -> 400 and nothing written", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const cases: Record<string, unknown> = {
        missingIsInternal: { content: doc("x") },
        stringIsInternal: { content: doc("x"), isInternal: "false" },
        numberContent: { content: 5, isInternal: false },
        missingContent: { isInternal: false },
        emptyObject: {},
      };
      const results: Record<string, unknown> = {};
      for (const [label, body] of Object.entries(cases)) {
        const r = await put(tid(104), body);
        expect(r.effects.response).toEqual({
          status: 400,
          body: { error: "Invalid draft." },
        });
        expect(r.effects.drafts).toEqual([]);
        results[label] = r.normalized.response;
      }
      const notJson = await captureEffects({
        ticketIds: [tid(104)],
        invoke: () =>
          PUT(
            new NextRequest(
              `http://localhost:3000/api/tickets/${tid(104)}/draft`,
              {
                method: "PUT",
                body: "not json",
              }
            ),
            ctx(tid(104))
          ),
      });
      expect(notJson.effects.response).toEqual({
        status: 400,
        body: { error: "Invalid request." },
      });
      results.notJson = notJson.normalized.response;
      expect(results).toMatchSnapshot();
    });

    it("merged shell -> 409 (not forwarded), even before the body is validated", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const valid = await put(tid(120), {
        content: doc("hello"),
        isInternal: false,
      });
      const invalid = await put(tid(120), {});
      for (const r of [valid, invalid]) {
        expect(r.effects.response.status).toBe(409);
        expect(r.effects.drafts).toEqual([]);
      }
      expect(valid.normalized.response).toMatchSnapshot();
    });

    it("no session / plain user -> 401", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(null);
      const anon = await put(tid(104), {
        content: doc("x"),
        isInternal: false,
      });
      getSession.mockResolvedValue({
        user: { id: USERS.dave.id, role: "user", name: USERS.dave.name },
      });
      const plain = await put(tid(104), {
        content: doc("x"),
        isInternal: false,
      });
      expect(anon.effects.response).toEqual({
        status: 401,
        body: { error: "Unauthorized." },
      });
      expect(plain.effects.response.status).toBe(401);
      expect(plain.effects.drafts).toEqual([]);
      expect(anon.normalized.response).toMatchSnapshot();
    });
  });

  describe("DELETE", () => {
    it("discards only the caller's own draft", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const own = await del(tid(102));
      expect(own.effects.response).toEqual({
        status: 200,
        body: { draft: null },
      });
      expect(own.effects.drafts).toEqual([]);
      const others = await del(tid(101));
      expect(others.effects.drafts.map((d) => d.userId)).toEqual([
        USERS.bob.id,
      ]);
      expect(own.normalized).toMatchSnapshot();
    });

    it("is idempotent: no draft -> still 200 {draft:null}; unknown ticket too", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const none = await del(tid(104));
      const unknown = await del("does-not-exist");
      expect(none.effects.response).toEqual({
        status: 200,
        body: { draft: null },
      });
      expect(unknown.effects.response).toEqual({
        status: 200,
        body: { draft: null },
      });
      expect(none.normalized.response).toMatchSnapshot();
    });

    it("merged shell -> 409; no session -> 401", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const merged = await del(tid(120));
      getSession.mockResolvedValue(null);
      const anon = await del(tid(102));
      expect(merged.effects.response.status).toBe(409);
      expect(anon.effects.response.status).toBe(401);
      // the 401 did not delete alice's draft
      expect(anon.effects.drafts).toHaveLength(1);
      expect({
        merged: merged.normalized.response,
        anon: anon.normalized.response,
      }).toMatchSnapshot();
    });
  });
});
