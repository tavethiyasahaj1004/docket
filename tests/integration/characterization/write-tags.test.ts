import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { FIXED_NOW, type TestDb, tid, USERS } from "../fixtures";
import { freezeDate, unfreezeDate } from "./helpers";

vi.mock("@/lib/auth", async () =>
  (await import("./write-helpers")).authModule()
);
vi.mock("@/lib/worker/enqueue", async () =>
  (await import("./write-helpers")).enqueueModule()
);

import { NextRequest } from "next/server";
import { DELETE as DELETE_TAG } from "@/app/api/tickets/[id]/tags/[tagId]/route";
import { POST as ADD_TAG } from "@/app/api/tickets/[id]/tags/route";
import { tags, ticketTags } from "@/db/schema";
import { db } from "@/lib/db";
import {
  actions,
  agentSession,
  captureEffects,
  ctx,
  getSession,
  jsonRequest,
  resetMocks,
  seedWriteWorld,
} from "./write-helpers";

function addTag(id: string, body: unknown) {
  return captureEffects({
    ticketIds: [id],
    invoke: () =>
      ADD_TAG(jsonRequest(`/api/tickets/${id}/tags`, "POST", body), ctx(id)),
  });
}

function removeTag(id: string, tagId: string, ticketIds = [id]) {
  return captureEffects({
    ticketIds,
    invoke: () =>
      DELETE_TAG(jsonRequest(`/api/tickets/${id}/tags/${tagId}`, "DELETE"), {
        params: Promise.resolve({ id, tagId }),
      }),
  });
}

/** vip is linked to t-101 so a merged shell (t-120) can unlink it. */
const linkVipToTicket101 = async (seedDb: TestDb) => {
  await seedDb.insert(ticketTags).values({
    id: "tt-101-vip",
    ticketId: tid(101),
    tagId: "tag-vip",
    createdAt: FIXED_NOW,
  });
};

describe("tags routes (characterization)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

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

  describe("POST /api/tickets/[id]/tags", () => {
    it("adds a brand-new tag: name normalized, tag created, linked, tag_added activity, full tag list returned", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await addTag(tid(104), {
        name: "  Refund   REQUEST ",
      });
      expect(effects.response.status).toBe(200);
      expect(effects.response.body).toEqual([
        { id: effects.newTags[0].id, name: "refund request" },
      ]);
      expect(effects.newTags.map((t) => t.name)).toEqual(["refund request"]);
      expect(effects.ticketTags).toHaveLength(1);
      expect(actions(effects)).toEqual(["tag_added"]);
      expect(effects.activity[0]).toMatchObject({
        actorId: USERS.alice.id,
        actorRole: "agent",
        metadata: { tag: "refund request" },
        createdAt: FIXED_NOW,
      });
      // tags never touch webhooks, email, or the ticket row
      expect(effects.deliveries).toEqual([]);
      expect(effects.emails).toEqual([]);
      expect(effects.ticketDiff).toEqual({});
      expect(normalized).toMatchSnapshot();
    });

    it("links an existing pool tag without creating a new one", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await addTag(tid(104), {
        name: "Unused-Tag",
      });
      expect(effects.response.body).toEqual([
        { id: "tag-unused", name: "unused-tag" },
      ]);
      expect(effects.newTags).toEqual([]);
      expect(actions(effects)).toEqual(["tag_added"]);
      expect(normalized).toMatchSnapshot();
    });

    it("adding an already-linked tag is a no-op (no new rows, no activity), still returns the list", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await addTag(tid(110), { name: "VIP" });
      expect(effects.response.status).toBe(200);
      expect(effects.response.body).toEqual([
        { id: "tag-billing", name: "billing" },
        { id: "tag-vip", name: "vip" },
      ]);
      expect(effects.activity).toEqual([]);
      expect(effects.newTags).toEqual([]);
      expect(effects.ticketTags).toHaveLength(2);
      expect(normalized).toMatchSnapshot();
    });

    it("a merged shell id is forwarded: the tag lands on the target ticket", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await captureEffects({
        ticketIds: [tid(120), tid(101)],
        invoke: () =>
          ADD_TAG(
            jsonRequest(`/api/tickets/${tid(120)}/tags`, "POST", {
              name: "vip",
            }),
            ctx(tid(120))
          ),
      });
      expect(effects.response.body).toEqual([{ id: "tag-vip", name: "vip" }]);
      expect(effects.ticketTags).toEqual([
        expect.objectContaining({ ticketId: tid(101), tagId: "tag-vip" }),
      ]);
      expect(effects.activity[0]).toMatchObject({
        ticketId: tid(101),
        action: "tag_added",
      });
      expect(normalized).toMatchSnapshot();
    });

    it("validation: blank / whitespace / missing / 51-char name -> 400; 50 chars is accepted", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const blank = await addTag(tid(104), { name: "" });
      const spaces = await addTag(tid(104), { name: "   " });
      const missing = await addTag(tid(104), {});
      const nullName = await addTag(tid(104), { name: null });
      const tooLong = await addTag(tid(104), { name: "a".repeat(51) });
      const longPadded = await addTag(tid(104), {
        name: `  ${"a".repeat(51)}  `,
      });
      const justRight = await addTag(tid(104), { name: "b".repeat(50) });
      for (const r of [blank, spaces, missing, nullName]) {
        expect(r.effects.response).toEqual({
          status: 400,
          body: { error: "Tag name is required." },
        });
      }
      for (const r of [tooLong, longPadded]) {
        expect(r.effects.response).toEqual({
          status: 400,
          body: { error: "Tag name must be 50 characters or fewer." },
        });
        expect(r.effects.newTags).toEqual([]);
        expect(r.effects.activity).toEqual([]);
      }
      expect(justRight.effects.response.status).toBe(200);
      expect(justRight.effects.newTags[0].name).toBe("b".repeat(50));
      expect({
        blank: blank.normalized.response,
        tooLong: tooLong.normalized.response,
      }).toMatchSnapshot();
    });

    it("invalid JSON -> 400; a non-string name is NOT validated and throws out of the handler", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const badJson = await captureEffects({
        ticketIds: [tid(104)],
        invoke: () =>
          ADD_TAG(
            new NextRequest(
              `http://localhost:3000/api/tickets/${tid(104)}/tags`,
              {
                method: "POST",
                body: "not json",
              }
            ),
            ctx(tid(104))
          ),
      });
      expect(badJson.effects.response).toEqual({
        status: 400,
        body: { error: "Invalid request body." },
      });

      const numeric = await captureEffects({
        ticketIds: [tid(104)],
        invoke: async () => {
          try {
            return await ADD_TAG(
              jsonRequest(`/api/tickets/${tid(104)}/tags`, "POST", {
                name: 123,
              }),
              ctx(tid(104))
            );
          } catch (error) {
            const e = error as Error;
            return Response.json(
              { thrown: true, name: e.name, message: e.message },
              { status: 599 }
            );
          }
        },
      });
      expect(numeric.effects.response.status).toBe(599);
      expect(numeric.effects.newTags).toEqual([]);
      expect({
        badJson: badJson.normalized.response,
        numeric: numeric.normalized.response,
      }).toMatchSnapshot();
    });

    it("unknown ticket -> 404 (no tag created); validation runs before the ticket lookup", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const unknown = await addTag("does-not-exist", { name: "fresh-tag" });
      const unknownBlank = await addTag("does-not-exist", { name: "" });
      expect(unknown.effects.response).toEqual({
        status: 404,
        body: { error: "Not found." },
      });
      expect(unknownBlank.effects.response.status).toBe(400);
      const created = await db
        .select()
        .from(tags)
        .where(eq(tags.name, "fresh-tag"));
      expect(created).toEqual([]);
      expect({
        unknown: unknown.normalized.response,
        unknownBlank: unknownBlank.normalized.response,
      }).toMatchSnapshot();
    });

    it("no session / plain user -> 401", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(null);
      const anon = await addTag(tid(104), { name: "x" });
      getSession.mockResolvedValue({
        user: { id: USERS.dave.id, role: "user", name: USERS.dave.name },
      });
      const plain = await addTag(tid(104), { name: "x" });
      expect(anon.effects.response).toEqual({
        status: 401,
        body: { error: "Unauthorized." },
      });
      expect(plain.effects.response.status).toBe(401);
      expect(plain.effects.newTags).toEqual([]);
      expect(anon.normalized.response).toMatchSnapshot();
    });
  });

  describe("DELETE /api/tickets/[id]/tags/[tagId]", () => {
    it("unlinks a linked tag: tag_removed activity, tag stays in the shared pool", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await removeTag(tid(110), "tag-vip");
      expect(effects.response).toEqual({ status: 200, body: { ok: true } });
      expect(effects.ticketTags.map((t) => t.name)).toEqual(["billing"]);
      expect(actions(effects)).toEqual(["tag_removed"]);
      expect(effects.activity[0]).toMatchObject({
        actorId: USERS.alice.id,
        metadata: { tag: "vip" },
        createdAt: FIXED_NOW,
      });
      expect(effects.deliveries).toEqual([]);
      expect(effects.ticketDiff).toEqual({});
      const pool = await db.select().from(tags).where(eq(tags.id, "tag-vip"));
      expect(pool).toHaveLength(1);
      expect(normalized).toMatchSnapshot();
    });

    it("a merged shell id is forwarded to the target", async () => {
      await seedWriteWorld({ extra: linkVipToTicket101 });
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await removeTag(tid(120), "tag-vip", [
        tid(120),
        tid(101),
      ]);
      expect(effects.response).toEqual({ status: 200, body: { ok: true } });
      expect(effects.ticketTags).toEqual([]);
      expect(effects.activity[0]).toMatchObject({
        ticketId: tid(101),
        action: "tag_removed",
      });
      expect(normalized).toMatchSnapshot();
    });

    it("not linked / unknown tag / unknown ticket -> 404; wrong ticket does not unlink", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const notLinked = await removeTag(tid(104), "tag-vip");
      const unknownTag = await removeTag(tid(110), "tag-nope");
      const unknownTicket = await removeTag("does-not-exist", "tag-vip");
      const poolOnly = await removeTag(tid(110), "tag-unused");
      for (const r of [notLinked, unknownTag, unknownTicket, poolOnly]) {
        expect(r.effects.response).toEqual({
          status: 404,
          body: { error: "Tag not found on ticket." },
        });
        expect(r.effects.activity).toEqual([]);
      }
      // tag-vip is still linked to ticket 110 and 111
      const links = await db
        .select()
        .from(ticketTags)
        .where(eq(ticketTags.tagId, "tag-vip"));
      expect(links).toHaveLength(2);
      expect(notLinked.normalized.response).toMatchSnapshot();
    });

    it("no session / plain user -> 401", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(null);
      const anon = await removeTag(tid(110), "tag-vip");
      getSession.mockResolvedValue({
        user: { id: USERS.dave.id, role: "user", name: USERS.dave.name },
      });
      const plain = await removeTag(tid(110), "tag-vip");
      expect(anon.effects.response).toEqual({
        status: 401,
        body: { error: "Unauthorized." },
      });
      expect(plain.effects.response.status).toBe(401);
      expect(plain.effects.ticketTags).toHaveLength(2);
      expect(anon.normalized.response).toMatchSnapshot();
    });
  });
});
