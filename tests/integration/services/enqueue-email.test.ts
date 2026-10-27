import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { emailOutbox } from "@/db/schema";
import { db } from "@/lib/db";
import { freezeDate, unfreezeDate } from "../characterization/helpers";
import {
  emailEnqueueError,
  enqueueMode,
  resetMocks,
  seedWriteWorld,
} from "../characterization/write-helpers";

vi.mock("@/lib/worker/enqueue", async () =>
  (await import("../characterization/write-helpers")).enqueueModule()
);

import { enqueueEmail, getQueuedOutboxId } from "@/lib/email";

const message = {
  to: "customer@example.test",
  subject: "Hello",
  html: "<p>Hi</p>",
  text: "Hi",
};

const rows = () => db.select().from(emailOutbox);

describe("enqueueEmail outcome", () => {
  beforeAll(() => freezeDate());
  afterAll(() => unfreezeDate());
  beforeEach(() => {
    resetMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    return () => {
      vi.restoreAllMocks();
    };
  });

  it("returns { outboxId } for the queued row", async () => {
    await seedWriteWorld();
    const result = await enqueueEmail({ ...message, category: "ticket" });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(result).toEqual({ outboxId: stored[0].id });
    expect(stored[0].status).toBe("queued");
  });

  it("account emails are always queued", async () => {
    await seedWriteWorld({ emailNotifications: false });
    const result = await enqueueEmail(message);
    expect(result).toEqual({ outboxId: (await rows())[0].id });
  });

  it("returns null (and writes nothing) when ticket notifications are off", async () => {
    await seedWriteWorld({ emailNotifications: false });
    await expect(
      enqueueEmail({ ...message, category: "ticket" })
    ).resolves.toBeNull();
    expect(await rows()).toHaveLength(0);
  });

  it("rethrows the SAME error object with a non-enumerable outboxId when the job fails", async () => {
    await seedWriteWorld();
    enqueueMode.email = "reject";
    let thrown: unknown;
    try {
      await enqueueEmail({ ...message, category: "ticket" });
    } catch (err) {
      thrown = err;
    }
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(thrown).toBe(emailEnqueueError);
    expect(getQueuedOutboxId(thrown)).toBe(stored[0].id);
    expect(Object.keys(thrown as object)).not.toContain("outboxId");
    expect(JSON.stringify(thrown)).toBe(JSON.stringify(emailEnqueueError));
  });

  it("getQueuedOutboxId is null for errors that never reached the outbox", () => {
    expect(getQueuedOutboxId(new Error("render failed"))).toBeNull();
    expect(getQueuedOutboxId("boom")).toBeNull();
    expect(getQueuedOutboxId(null)).toBeNull();
    expect(getQueuedOutboxId(undefined)).toBeNull();
  });
});
