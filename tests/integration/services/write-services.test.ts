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
import { emailOutbox, ticketActivity, ticketComments } from "@/db/schema";
import { db } from "@/lib/db";
import { freezeDate, unfreezeDate } from "../characterization/helpers";
import {
  callLog,
  emailEnqueueError,
  enqueueMode,
  resetMocks,
  seedWriteWorld,
} from "../characterization/write-helpers";
import { doc, tid, USERS } from "../fixtures";

vi.mock("@/lib/worker/enqueue", async () =>
  (await import("../characterization/write-helpers")).enqueueModule()
);
vi.mock("@/lib/realtime", async (importOriginal) =>
  (await import("../characterization/write-helpers")).realtimeModule(
    await importOriginal<Record<string, unknown>>()
  )
);
vi.mock("@/lib/webhooks/dispatch", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/webhooks/dispatch")>();
  return {
    ...original,
    dispatchWebhookEvent: vi.fn(original.dispatchWebhookEvent),
  };
});
vi.mock("@/lib/email/templates/ticket-replied", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/lib/email/templates/ticket-replied")
    >();
  return {
    ...original,
    ticketRepliedTemplate: vi.fn(original.ticketRepliedTemplate),
  };
});
vi.mock("@/lib/email/templates/ticket-closed", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/lib/email/templates/ticket-closed")
    >();
  return {
    ...original,
    ticketClosedTemplate: vi.fn(original.ticketClosedTemplate),
  };
});

import { ticketClosedTemplate } from "@/lib/email/templates/ticket-closed";
import { ticketRepliedTemplate } from "@/lib/email/templates/ticket-replied";
import { closeTicket } from "@/lib/tickets/services/close";
import {
  addTicketComment,
  loadCommentTarget,
} from "@/lib/tickets/services/comments";
import { reopenTicket } from "@/lib/tickets/services/reopen";
import type { EmailHandle, ServiceActor } from "@/lib/tickets/services/types";
import { dispatchWebhookEvent } from "@/lib/webhooks/dispatch";

const actor: ServiceActor = {
  id: USERS.alice.id,
  name: USERS.alice.name,
  role: "agent",
};

const BIG = 1_000_000_000;

async function reply(
  overrides: Partial<Parameters<typeof addTicketComment>[0]> = {}
) {
  const target = await loadCommentTarget(tid(101));
  if (!target) {
    throw new Error("seed ticket missing");
  }
  return addTicketComment({
    ticketId: tid(101),
    target,
    actor,
    content: doc("Thanks, on it."),
    contentText: "Thanks, on it.",
    isInternal: false,
    attachments: [],
    maxPerTicketSizeBytes: BIG,
    ...overrides,
  });
}

async function okReply(
  overrides: Partial<Parameters<typeof addTicketComment>[0]> = {}
) {
  const result = await reply(overrides);
  if (result.status !== "ok") {
    throw new Error(`expected ok, got ${result.status}`);
  }
  return result;
}

async function okClose(
  overrides: Partial<Parameters<typeof closeTicket>[0]> = {}
) {
  const result = await closeTicket({ ticketId: tid(101), actor, ...overrides });
  if (result.status !== "closed") {
    throw new Error(`expected closed, got ${result.status}`);
  }
  return result;
}

const outboxRows = () => db.select().from(emailOutbox);
const activityOf = (id: string) =>
  db.select().from(ticketActivity).where(eq(ticketActivity.id, id));

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => freezeDate());
afterAll(() => unfreezeDate());
beforeEach(() => {
  resetMocks();
  vi.mocked(dispatchWebhookEvent).mockClear();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => {
    vi.restoreAllMocks();
  };
});

describe.each([
  {
    name: "addTicketComment (public agent reply)",
    label: "[ticket.replied email]",
    template: ticketRepliedTemplate,
    run: async (): Promise<{ email: EmailHandle }> => await okReply(),
  },
  {
    name: "closeTicket",
    label: "[ticket.closed email]",
    template: ticketClosedTemplate,
    run: async (): Promise<{ email: EmailHandle }> => await okClose(),
  },
])("email outcome: $name", ({ label, template, run }) => {
  it("queued -> { requested: true, outboxId } matching the outbox row", async () => {
    await seedWriteWorld();
    const { email } = await run();
    if (!email) {
      throw new Error("expected an email handle");
    }
    const outcome = await email;
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(outcome).toEqual({ requested: true, outboxId: rows[0].id });
    expect(rows[0].status).toBe("queued");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("ticket notifications off -> { requested: false } and no outbox row", async () => {
    await seedWriteWorld({ emailNotifications: false });
    const { email } = await run();
    await expect(email).resolves.toEqual({ requested: false });
    expect(await outboxRows()).toHaveLength(0);
  });

  it("enqueueJob rejects -> email_queued_without_job with the one queued row", async () => {
    await seedWriteWorld();
    enqueueMode.email = "reject";
    const { email } = await run();
    const outcome = await email;
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("queued");
    expect(outcome).toEqual({
      requested: true,
      error: "email_queued_without_job",
      outboxId: rows[0].id,
    });
    // logged exactly as the routes always did
    expect(errorSpy).toHaveBeenCalledWith(label, emailEnqueueError);
  });

  it("template render throws -> email_not_queued and zero outbox rows", async () => {
    await seedWriteWorld();
    const boom = new Error("render exploded");
    vi.mocked(template).mockRejectedValueOnce(boom);
    const { email } = await run();
    await expect(email).resolves.toEqual({
      requested: false,
      error: "email_not_queued",
    });
    expect(await outboxRows()).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(label, boom);
  });
});

describe("internal notes", () => {
  it("dispatch no webhook and send no email", async () => {
    await seedWriteWorld();
    const result = await okReply({ isInternal: true });
    expect(result.webhook).toBe("none");
    expect(result.email).toBeNull();
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    expect(await outboxRows()).toHaveLength(0);
    const [row] = await activityOf(result.activityId);
    expect(row.action).toBe("internal_note_added");
  });
});

describe("webhook outcome", () => {
  it("addTicketComment: dispatch rejects -> webhook 'failed', reply still completes", async () => {
    await seedWriteWorld();
    const boom = new Error("webhook down");
    vi.mocked(dispatchWebhookEvent).mockRejectedValueOnce(boom);
    const result = await okReply();
    expect(result.webhook).toBe("failed");
    expect(errorSpy).toHaveBeenCalledWith("[webhook.ticket_replied]", boom);
    expect(
      await db
        .select()
        .from(ticketComments)
        .where(eq(ticketComments.id, result.commentId))
    ).toHaveLength(1);
    await expect(result.email).resolves.toMatchObject({ requested: true });
  });

  it("addTicketComment: dispatch resolves -> 'dispatched'", async () => {
    await seedWriteWorld();
    const result = await okReply();
    expect(result.webhook).toBe("dispatched");
    await result.email;
  });

  it("closeTicket: dispatch rejects -> webhook 'failed', close still completes", async () => {
    await seedWriteWorld();
    const boom = new Error("webhook down");
    vi.mocked(dispatchWebhookEvent).mockRejectedValueOnce(boom);
    const result = await okClose();
    expect(result.webhook).toBe("failed");
    expect(errorSpy).toHaveBeenCalledWith("[webhook.ticket_closed]", boom);
    expect(result.slug).toBe("closed");
    await result.email;
    const [activity] = await activityOf(result.activityId);
    expect(activity.action).toBe("ticket_closed");
  });

  it("reopenTicket: dispatch rejects -> webhook 'failed', no email", async () => {
    await seedWriteWorld();
    await (await okClose()).email;
    vi.mocked(dispatchWebhookEvent).mockRejectedValueOnce(new Error("down"));
    const result = await reopenTicket({ ticketId: tid(101), actor });
    if (result.status !== "reopened") {
      throw new Error(`expected reopened, got ${result.status}`);
    }
    expect(result.webhook).toBe("failed");
    expect(result.email).toBeNull();
  });
});

describe("caller-supplied ids", () => {
  it("are used verbatim for the comment and the activity row", async () => {
    await seedWriteWorld();
    const result = await okReply({
      commentId: "comment-fixed-1",
      activityId: "activity-fixed-1",
    });
    expect(result.commentId).toBe("comment-fixed-1");
    expect(result.activityId).toBe("activity-fixed-1");
    await result.email;
    const [comment] = await db
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.id, "comment-fixed-1"));
    expect(comment.ticketId).toBe(tid(101));
    const [activity] = await activityOf("activity-fixed-1");
    expect(activity.action).toBe("comment_added");
  });

  it("closeTicket uses the supplied activityId", async () => {
    await seedWriteWorld();
    const result = await okClose({ activityId: "close-activity-1" });
    expect(result.activityId).toBe("close-activity-1");
    await result.email;
    const [activity] = await activityOf("close-activity-1");
    expect(activity.action).toBe("ticket_closed");
  });

  it("a second addTicketComment with the same commentId is 'exists' and has no side effects", async () => {
    await seedWriteWorld();
    const first = await okReply({ commentId: "comment-dup" });
    await first.email;

    const count = async () => ({
      activity: (
        await db
          .select()
          .from(ticketActivity)
          .where(eq(ticketActivity.ticketId, tid(101)))
      ).length,
      comments: (
        await db
          .select()
          .from(ticketComments)
          .where(eq(ticketComments.ticketId, tid(101)))
      ).length,
      outbox: (await outboxRows()).length,
    });
    const before = await count();
    callLog.length = 0;
    vi.mocked(dispatchWebhookEvent).mockClear();
    vi.mocked(ticketRepliedTemplate).mockClear();

    const second = await reply({ commentId: "comment-dup" });
    expect(second).toEqual({ status: "exists" });

    expect(await count()).toEqual(before);
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    expect(ticketRepliedTemplate).not.toHaveBeenCalled();
    expect(callLog).toEqual([]); // no realtime publish, no queue send
  });
});

describe("activityMetadata", () => {
  const extra = { via: "mcp", credentialId: "x" };

  it("closeTicket merges it next to from/to; the action is unchanged", async () => {
    await seedWriteWorld();
    const result = await okClose({ activityMetadata: extra });
    await result.email;
    const [row] = await activityOf(result.activityId);
    expect(row.action).toBe("ticket_closed");
    expect(row.metadata).toEqual({
      from: result.previousStatus,
      to: "closed",
      via: "mcp",
      credentialId: "x",
    });
  });

  it("closeTicket without it writes exactly { from, to }", async () => {
    await seedWriteWorld();
    const result = await okClose();
    await result.email;
    const [row] = await activityOf(result.activityId);
    expect(row.metadata).toEqual({ from: result.previousStatus, to: "closed" });
  });

  it("reopenTicket merges it too", async () => {
    await seedWriteWorld();
    await (await okClose()).email;
    const result = await reopenTicket({
      ticketId: tid(101),
      actor,
      activityMetadata: extra,
    });
    if (result.status !== "reopened") {
      throw new Error(`expected reopened, got ${result.status}`);
    }
    const [row] = await activityOf(result.activityId);
    expect(row.action).toBe("ticket_reopened");
    expect(row.metadata).toEqual({
      from: "closed",
      to: result.slug,
      via: "mcp",
      credentialId: "x",
    });
  });

  it("addTicketComment: merged into the row; absent (null) without it", async () => {
    await seedWriteWorld();
    const withExtra = await okReply({ activityMetadata: extra });
    await withExtra.email;
    const [a] = await activityOf(withExtra.activityId);
    expect(a.action).toBe("comment_added");
    expect(a.metadata).toEqual(extra);

    const without = await okReply();
    await without.email;
    const [b] = await activityOf(without.activityId);
    expect(b.action).toBe("comment_added");
    expect(b.metadata).toBeNull();
  });
});

describe("close / reopen status results", () => {
  it("not_found, already_closed, not_closed", async () => {
    await seedWriteWorld();
    expect(await closeTicket({ ticketId: "nope", actor })).toEqual({
      status: "not_found",
    });
    expect(await reopenTicket({ ticketId: tid(101), actor })).toEqual({
      status: "not_closed",
    });
    await (await okClose()).email;
    expect(await closeTicket({ ticketId: tid(101), actor })).toEqual({
      status: "already_closed",
    });
  });
});
