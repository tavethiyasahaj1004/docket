import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { doc, tid } from "../fixtures";
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

import { PATCH as CLOSE } from "@/app/api/tickets/[id]/close/route";
import { POST as COMMENT } from "@/app/api/tickets/[id]/comments/route";
import {
  agentSession,
  captureEffects,
  commentRequest,
  ctx,
  emailEnqueueError,
  enqueueMode,
  events,
  getSession,
  jobs,
  jsonRequest,
  resetMocks,
  seedWriteWorld,
} from "./write-helpers";

const LIMIT_MS = 2000;

/** Runs `run`, failing loudly if the response takes longer than LIMIT_MS. */
async function withinLimit(run: () => Promise<Response>) {
  const started = performance.now();
  const res = await Promise.race([
    run(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), LIMIT_MS)),
  ]);
  if (!res) {
    throw new Error(`response not returned within ${LIMIT_MS}ms`);
  }
  return { res, elapsedMs: performance.now() - started };
}

const reply = () =>
  COMMENT(
    commentRequest(tid(101), { content: doc("Thanks, on it.") }),
    ctx(tid(101))
  );
const closeTicket = () =>
  CLOSE(jsonRequest(`/api/tickets/${tid(101)}/close`, "PATCH"), ctx(tid(101)));

describe("email enqueue is fire-and-forget (characterization)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => freezeDate());
  afterAll(() => unfreezeDate());
  beforeEach(() => {
    resetMocks();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    getSession.mockResolvedValue(agentSession);
    return () => {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    };
  });

  it("agent reply: the email job enqueue NEVER resolves -> still 201 within 2s, webhook job enqueued, outbox row left queued", async () => {
    await seedWriteWorld();
    enqueueMode.email = "hang";
    let elapsedMs = Number.POSITIVE_INFINITY;
    const { effects, normalized } = await captureEffects({
      ticketIds: [tid(101)],
      expectEmail: true,
      invoke: async () => {
        const r = await withinLimit(reply);
        elapsedMs = r.elapsedMs;
        return r.res;
      },
    });
    expect(effects.response.status).toBe(201);
    expect(elapsedMs).toBeLessThan(LIMIT_MS);
    expect(events(effects)).toEqual(["ticket.replied"]);
    expect(jobs(effects, "webhook.send")).toHaveLength(1);
    expect(jobs(effects, "email.send")).toHaveLength(1);
    // the outbox row was written before the (hung) queue send
    expect(effects.emails).toHaveLength(1);
    expect(effects.emails[0].status).toBe("queued");
    expect(effects.comments).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(normalized).toMatchSnapshot();
  });

  it("agent reply: the email job enqueue REJECTS -> still 201, console.error('[ticket.replied email]', err)", async () => {
    await seedWriteWorld();
    enqueueMode.email = "reject";
    const { effects, normalized } = await captureEffects({
      ticketIds: [tid(101)],
      expectEmail: true,
      invoke: async () => (await withinLimit(reply)).res,
    });
    expect(effects.response.status).toBe(201);
    expect(errorSpy).toHaveBeenCalledWith(
      "[ticket.replied email]",
      emailEnqueueError
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(events(effects)).toEqual(["ticket.replied"]);
    expect(jobs(effects, "webhook.send")).toHaveLength(1);
    // outbox row exists even though the queue send failed
    expect(effects.emails).toHaveLength(1);
    expect(normalized).toMatchSnapshot();
  });

  it("agent close: the email job enqueue NEVER resolves -> still 200 within 2s, webhook job enqueued", async () => {
    await seedWriteWorld();
    enqueueMode.email = "hang";
    let elapsedMs = Number.POSITIVE_INFINITY;
    const { effects, normalized } = await captureEffects({
      ticketIds: [tid(101)],
      expectEmail: true,
      invoke: async () => {
        const r = await withinLimit(closeTicket);
        elapsedMs = r.elapsedMs;
        return r.res;
      },
    });
    expect(effects.response).toEqual({
      status: 200,
      body: { status: "closed" },
    });
    expect(elapsedMs).toBeLessThan(LIMIT_MS);
    expect(events(effects)).toEqual(["ticket.closed"]);
    expect(jobs(effects, "webhook.send")).toHaveLength(1);
    expect(effects.tickets[0]).toMatchObject({ status: "closed" });
    expect(effects.emails).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(normalized).toMatchSnapshot();
  });

  it("agent close: the email job enqueue REJECTS -> still 200, console.error('[ticket.closed email]', err)", async () => {
    await seedWriteWorld();
    enqueueMode.email = "reject";
    const { effects, normalized } = await captureEffects({
      ticketIds: [tid(101)],
      expectEmail: true,
      invoke: async () => (await withinLimit(closeTicket)).res,
    });
    expect(effects.response.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(
      "[ticket.closed email]",
      emailEnqueueError
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(events(effects)).toEqual(["ticket.closed"]);
    expect(effects.emails).toHaveLength(1);
    expect(normalized).toMatchSnapshot();
  });
});
