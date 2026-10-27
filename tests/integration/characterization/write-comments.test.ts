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
vi.mock("@/lib/storage", async (importOriginal) =>
  (await import("./write-helpers")).storageModule(
    await importOriginal<Record<string, unknown>>()
  )
);

import { POST } from "@/app/api/tickets/[id]/comments/route";
import { ticketReplyDrafts } from "@/db/schema";
import {
  actions,
  adminSession,
  agentSession,
  type CommentFields,
  calls,
  captureEffects,
  commentRequest,
  ctx,
  events,
  getSession,
  jobs,
  makeFile,
  resetMocks,
  seedWriteWorld,
} from "./write-helpers";

const REPLY = doc("Thanks for reaching out, we are on it.");

async function post(
  id: string,
  fields: CommentFields,
  opts: { expectEmail?: boolean; ticketIds?: string[] } = {}
) {
  return captureEffects({
    ticketIds: opts.ticketIds ?? [id],
    expectEmail: opts.expectEmail ?? false,
    invoke: () => POST(commentRequest(id, fields), ctx(id)),
  });
}

describe("POST /api/tickets/[id]/comments (characterization)", () => {
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

  describe("agent branch", () => {
    it("public reply on an awaiting ticket: resets flags, deletes the draft, fires webhook + email + realtime", async () => {
      await seedWriteWorld({
        extra: async (db) => {
          await db.insert(ticketReplyDrafts).values({
            ticketId: tid(101),
            userId: USERS.alice.id,
            content: doc("alice half-written reply"),
            isInternal: false,
            createdAt: FIXED_NOW,
            updatedAt: FIXED_NOW,
          });
        },
      });
      getSession.mockResolvedValue(agentSession);

      const { effects, normalized } = await post(
        tid(101),
        { content: REPLY },
        { expectEmail: true }
      );

      expect(effects.response.status).toBe(201);
      expect(effects.tickets[0]).toMatchObject({
        awaitingReply: false,
        pendingReplies: 0,
        firstRespondedAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      });
      expect(effects.comments).toHaveLength(1);
      expect(effects.comments[0]).toMatchObject({
        authorRole: "agent",
        isInternal: false,
      });
      expect(actions(effects)).toEqual(["comment_added"]);
      expect(events(effects)).toEqual(["ticket.replied"]);
      expect(effects.emails).toHaveLength(1);
      expect(effects.emails[0].to).toBe("ann@example.test");
      // only bob's draft is left: alice's own draft was deleted
      expect(effects.drafts.map((d) => d.userId)).toEqual([USERS.bob.id]);
      expect(
        calls(effects, "realtime.publishTicketCommentCreated")
      ).toHaveLength(1);
      expect(effects.notifications).toEqual([]);
      expect(calls(effects, "push.publishPushToUsers")).toEqual([]);
      expect(jobs(effects, "email.send")).toHaveLength(1);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(normalized).toMatchSnapshot();
    });

    it("admin public reply is attributed to the admin role", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(adminSession);
      const { effects, normalized } = await post(
        tid(105),
        { content: REPLY },
        { expectEmail: true }
      );
      expect(effects.response.status).toBe(201);
      expect(effects.comments[0]).toMatchObject({
        authorRole: "admin",
        authorId: USERS.bob.id,
      });
      expect(normalized).toMatchSnapshot();
    });

    it("public reply with 2 attachments uploads both and links them", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await post(
        tid(101),
        {
          content: REPLY,
          files: [
            makeFile("screenshot.png", "image/png", 11),
            makeFile("notes.txt", "text/plain", 5),
          ],
        },
        { expectEmail: true }
      );
      expect(effects.response.status).toBe(201);
      expect(effects.attachments).toHaveLength(2);
      expect(calls(effects, "storage.upload")).toHaveLength(2);
      expect(calls(effects, "storage.delete")).toEqual([]);
      expect(normalized).toMatchSnapshot();
    });

    it("attachment-only reply (no text) is accepted; previews use a marker", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await post(
        tid(101),
        { content: "", files: [makeFile("a.png", "image/png")] },
        { expectEmail: true }
      );
      expect(effects.response.status).toBe(201);
      expect(effects.emails[0].text).toContain("(sent an attachment)");
      expect(normalized).toMatchSnapshot();
    });

    it("internal note: no webhook, no email, flags and SLA untouched, draft deleted", async () => {
      await seedWriteWorld({
        extra: async (db) => {
          await db.insert(ticketReplyDrafts).values({
            ticketId: tid(101),
            userId: USERS.alice.id,
            content: doc("alice internal draft"),
            isInternal: true,
            createdAt: FIXED_NOW,
            updatedAt: FIXED_NOW,
          });
        },
      });
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await post(tid(101), {
        content: doc("internal: check the logs"),
        isInternal: "true",
      });
      expect(effects.response.status).toBe(201);
      expect(effects.comments[0]).toMatchObject({ isInternal: true });
      expect(actions(effects)).toEqual(["internal_note_added"]);
      expect(effects.deliveries).toEqual([]);
      expect(effects.emails).toEqual([]);
      // only updatedAt moves
      expect(Object.keys(effects.ticketDiff[tid(101)])).toEqual(["updatedAt"]);
      expect(effects.drafts.map((d) => d.userId)).toEqual([USERS.bob.id]);
      // internal notes still live-refresh viewers
      expect(
        calls(effects, "realtime.publishTicketCommentCreated")
      ).toHaveLength(1);
      expect(jobs(effects, "webhook.send")).toEqual([]);
      expect(normalized).toMatchSnapshot();
    });

    it("isInternal other than the string 'true' is a public reply", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await post(
        tid(101),
        { content: REPLY, isInternal: "1" },
        { expectEmail: true }
      );
      expect(effects.comments[0]).toMatchObject({ isInternal: false });
      expect(events(effects)).toEqual(["ticket.replied"]);
      expect(normalized).toMatchSnapshot();
    });

    it("reply with ticket email notifications OFF: webhook still fires, zero outbox rows", async () => {
      await seedWriteWorld({ emailNotifications: false });
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await post(tid(101), {
        content: REPLY,
      });
      expect(effects.response.status).toBe(201);
      expect(effects.emails).toEqual([]);
      expect(jobs(effects, "email.send")).toEqual([]);
      expect(events(effects)).toEqual(["ticket.replied"]);
      expect(normalized).toMatchSnapshot();
    });

    it("reply through a merged shell id is forwarded to the target ticket", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await post(
        tid(120),
        { content: REPLY },
        { expectEmail: true, ticketIds: [tid(120), tid(101)] }
      );
      expect(effects.response.status).toBe(201);
      expect(effects.comments[0]).toMatchObject({ ticketId: tid(101) });
      // the shell itself is untouched
      expect(effects.ticketDiff[tid(120)]).toBeUndefined();
      expect(effects.ticketDiff[tid(101)]).toBeDefined();
      expect(normalized).toMatchSnapshot();
    });
  });

  describe("agent branch: errors", () => {
    it("closed ticket -> 400", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await post(tid(108), {
        content: REPLY,
      });
      expect(effects.response).toEqual({
        status: 400,
        body: { error: "Cannot comment on a closed ticket." },
      });
      expect(effects.comments).toEqual([]);
      expect(normalized).toMatchSnapshot();
    });

    it("unknown ticket -> 404", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await post("does-not-exist", {
        content: REPLY,
      });
      expect(effects.response.status).toBe(404);
      expect(effects.response.body).toEqual({ error: "Ticket not found." });
      expect(normalized).toMatchSnapshot();
    });

    it("no session and no token -> 401", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(null);
      const { effects, normalized } = await post(tid(101), {
        content: REPLY,
      });
      expect(effects.response).toEqual({
        status: 401,
        body: { error: "Unauthorized." },
      });
      expect(normalized).toMatchSnapshot();
    });

    it("a plain 'user' role session -> 401", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue({
        user: { id: USERS.dave.id, role: "user", name: USERS.dave.name },
      });
      const { effects } = await post(tid(101), { content: REPLY });
      expect(effects.response.status).toBe(401);
      expect(effects.comments).toEqual([]);
    });

    it("empty content and no attachments -> 400 (checked before auth)", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(null);
      const emptyDoc = JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph" }],
      });
      const blank = await post(tid(101), { content: "   " });
      const emptyTiptap = await post(tid(101), { content: emptyDoc });
      const missing = await post(tid(101), {});
      expect(blank.effects.response).toEqual({
        status: 400,
        body: { error: "Add a message or an attachment." },
      });
      expect(emptyTiptap.effects.response.status).toBe(400);
      expect(missing.effects.response.status).toBe(400);
      // 400 for empty content wins over the missing session (no 401)
      expect(blank.normalized).toMatchSnapshot();
    });

    it("attachment validation: too many, bad mime type", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const tooMany = await post(tid(101), {
        content: REPLY,
        files: Array.from({ length: 6 }, (_, i) =>
          makeFile(`f${i}.png`, "image/png")
        ),
      });
      const badMime = await post(tid(101), {
        content: REPLY,
        files: [makeFile("run.exe", "application/x-msdownload")],
      });
      expect(tooMany.effects.response.status).toBe(400);
      expect(badMime.effects.response.status).toBe(400);
      expect(tooMany.effects.calls).toEqual([]);
      expect({
        tooMany: tooMany.normalized.response,
        badMime: badMime.normalized.response,
      }).toMatchSnapshot();
    });
  });

  describe("customer (token) branch", () => {
    it("reply on an assigned, already-awaiting ticket: pendingReplies+1, notifies the assignee, pushes, webhook, no customer email", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(null);
      const { effects, normalized } = await post(tid(101), {
        content: doc("Any update on this?"),
        token: "token-101",
      });
      expect(effects.response.status).toBe(201);
      expect(effects.tickets[0]).toMatchObject({
        awaitingReply: true,
        pendingReplies: 1,
        firstRespondedAt: null,
      });
      expect(effects.comments[0]).toMatchObject({
        authorRole: "customer",
        authorId: null,
        authorName: "Ann Adams",
        isInternal: false,
      });
      expect(actions(effects)).toEqual(["comment_added"]);
      expect(events(effects)).toEqual(["ticket.replied"]);
      expect(effects.emails).toEqual([]);
      expect(effects.notifications.map((n) => n.userId)).toEqual([
        USERS.alice.id,
      ]);
      expect(effects.notifications[0]).toMatchObject({
        type: "customer_replied",
        title: "Ann Adams replied to #101",
      });
      expect(calls(effects, "push.publishPushToUsers")).toHaveLength(1);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(normalized).toMatchSnapshot();
    });

    it("reply on an unassigned ticket that was not awaiting: starts awaiting, notifies every active agent/admin", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(null);
      const { effects, normalized } = await post(tid(104), {
        content: doc("Hello? Still no news."),
        token: "token-104",
      });
      expect(effects.response.status).toBe(201);
      expect(effects.tickets[0]).toMatchObject({
        awaitingReply: true,
        pendingReplies: 1,
      });
      // alice (agent) + bob (admin); banned carol/erin and plain dave excluded
      expect(effects.notifications.map((n) => n.userId).sort()).toEqual([
        USERS.alice.id,
        USERS.bob.id,
      ]);
      expect(effects.emails).toEqual([]);
      expect(normalized).toMatchSnapshot();
    });

    it("token beats a session: a customer reply from a browser that also holds an agent session is still a customer reply", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(agentSession);
      const { effects, normalized } = await post(tid(101), {
        content: REPLY,
        token: "token-101",
      });
      expect(effects.response.status).toBe(201);
      expect(effects.comments[0]).toMatchObject({
        authorRole: "customer",
        authorId: null,
      });
      expect(getSession).not.toHaveBeenCalled();
      expect(normalized).toMatchSnapshot();
    });

    it("isInternal is ignored for customers", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(null);
      const { effects } = await post(tid(101), {
        content: REPLY,
        token: "token-101",
        isInternal: "true",
      });
      expect(effects.comments[0]).toMatchObject({ isInternal: false });
      expect(events(effects)).toEqual(["ticket.replied"]);
    });

    it("merged shell id + the shell's token is forwarded to the target with the target's token", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(null);
      const { effects, normalized } = await post(
        tid(120),
        { content: REPLY, token: "token-120" },
        { ticketIds: [tid(120), tid(101)] }
      );
      expect(effects.response.status).toBe(201);
      expect(effects.comments[0]).toMatchObject({
        ticketId: tid(101),
        authorRole: "customer",
      });
      expect(normalized).toMatchSnapshot();
    });

    it("wrong token -> 404; closed ticket -> 400", async () => {
      await seedWriteWorld();
      getSession.mockResolvedValue(null);
      const wrong = await post(tid(101), {
        content: REPLY,
        token: "token-999",
      });
      const closed = await post(tid(108), {
        content: REPLY,
        token: "token-108",
      });
      expect(wrong.effects.response).toEqual({
        status: 404,
        body: { error: "Ticket not found." },
      });
      expect(closed.effects.response).toEqual({
        status: 400,
        body: { error: "Cannot reply to a closed ticket." },
      });
      expect({
        wrong: wrong.normalized.response,
        closed: closed.normalized.response,
      }).toMatchSnapshot();
    });
  });
});
