import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Only auth/navigation are mocked (see tickets-list.test.ts).
const session = vi.hoisted(() => ({
  current: {
    id: "user-alice",
    name: "Alice Agent",
    email: "alice@example.test",
    role: "agent",
  },
}));
vi.mock("@/lib/authz", () => ({
  requireAgent: vi.fn(async () => session.current),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import AgentTicketDetailPage from "@/app/(agent)/tickets/[ticketNumber]/page";
import { seedWorld, USERS } from "../fixtures";
import { freezeDate, unfreezeDate, useSeededDatabase } from "./helpers";
import { captureTree, pick } from "./render-tree";

const ALICE = session.current;
const BOB = {
  id: USERS.bob.id,
  name: "Bob Admin",
  email: USERS.bob.email,
  role: "admin",
};

type Params = Record<string, string>;

async function renderThread(
  ticketNumber: string,
  searchParams: Params = {},
  agent = ALICE
) {
  session.current = agent;
  const tree = await AgentTicketDetailPage({
    params: Promise.resolve({ ticketNumber }),
    searchParams: Promise.resolve(searchParams),
  });
  return captureTree(tree);
}

/** Everything the thread queries produced, in render order. */
function threadView(capture: Awaited<ReturnType<typeof renderThread>>) {
  return {
    asyncCalls: capture.asyncCalls,
    text: capture.text,
    components: pick(
      capture,
      "TicketDetailRealtime",
      "TicketNavLink",
      "CustomerProfilePopover",
      "RichTextContent",
      "DeletableTicketAttachments",
      "SplitCommentButton",
      "AgentReplyForm",
      "TicketInfoSidebar",
      "LocalDateTime"
    ),
    links: capture.components
      .map((c) => (c.props as { href?: unknown } | null)?.href)
      .filter((h): h is string => typeof h === "string"),
  };
}

/** Compact view of the prev/next navigation + whether the reply form shows. */
function navView(capture: Awaited<ReturnType<typeof renderThread>>) {
  return {
    nav: pick(capture, "TicketNavLink").map((c) => c.props),
    hasReplyForm: pick(capture, "AgentReplyForm").length > 0,
    text: capture.text.slice(0, 6),
  };
}

async function outcome(run: () => Promise<unknown>) {
  try {
    await run();
    return "rendered";
  } catch (e) {
    return (e as Error).message;
  }
}

describe("agent ticket detail page / thread (characterization)", () => {
  useSeededDatabase(seedWorld);
  beforeAll(() => freezeDate());
  afterAll(() => unfreezeDate());
  beforeEach(() => {
    session.current = ALICE;
  });

  it("walks the page (it is itself the async server component)", async () => {
    const c = await renderThread("103");
    expect(c.components.length).toBeGreaterThan(10);
  });

  it("full thread of #103: public replies, internal notes, attachments, activity, sidebar data", async () => {
    expect(threadView(await renderThread("103"))).toMatchSnapshot();
  });

  it("splits attachments into ticket-level vs per-comment", async () => {
    const c = await renderThread("103");
    const groups = pick(c, "DeletableTicketAttachments").map((a) =>
      (a.props as { items: Array<{ id: string }> }).items.map((i) => i.id)
    );
    // ticket-level first (in the description card), then per-comment in thread order
    expect(groups).toEqual([["att-1", "att-2"], ["att-3", "att-4"], ["att-5"]]);
  });

  it("orders comments ascending by createdAt and activity descending", async () => {
    const c = await renderThread("103");
    const sidebar = pick(c, "TicketInfoSidebar")[0].props as {
      activity: Array<{ id: string }>;
    };
    expect(sidebar.activity.map((a) => a.id)).toEqual([
      "act-5",
      "act-4",
      "act-3",
      "act-2",
      "act-1",
    ]);
    const contents = pick(c, "RichTextContent").map(
      (r) => (r.props as { content: string }).content
    );
    expect(
      contents.map((x) =>
        x.startsWith("{") ? JSON.parse(x).content[0].content[0].text : x
      )
    ).toEqual([
      "Description of snake_case error in export",
      "Customer first message",
      "Public agent reply",
      "Internal note: check the export job",
      "Customer follow-up with files",
      "Legacy plain text reply",
    ]);
  });

  it("as an admin with different preferences (sendReplyOnEnter, no draft)", async () => {
    expect(threadView(await renderThread("103", {}, BOB))).toMatchSnapshot();
  });

  it("a ticket with no thread, links, and a merged-from notice", async () => {
    expect(
      threadView(await renderThread("101", { mergedFrom: "120" }))
    ).toMatchSnapshot();
  });

  it("ignores a malformed mergedFrom", async () => {
    const c = await renderThread("101", { mergedFrom: "abc" });
    expect(c.text.some((t) => t.includes("was merged into this ticket"))).toBe(
      false
    );
  });

  it("closed ticket has no reply form", async () => {
    const c = await renderThread("107");
    expect(navView(c)).toMatchSnapshot();
    expect(navView(c).hasReplyForm).toBe(false);
  });

  describe("previous/next within the list the agent came from", () => {
    const cases: Array<[string, string, Params]> = [
      ["default sort (updatedAt desc), middle", "110", {}],
      ["default sort, first of the list", "101", {}],
      ["default sort, last of the list", "109", {}],
      ["sort=id asc", "105", { sort: "id", order: "asc" }],
      ["sort=id desc", "105", { sort: "id", order: "desc" }],
      ["sort=updatedAt asc", "110", { sort: "updatedAt", order: "asc" }],
      [
        "filtered: status=open, sort=id asc",
        "105",
        { status: "open", sort: "id", order: "asc" },
      ],
      ["filtered: view=awaiting", "102", { view: "awaiting" }],
      ["filtered: view=open", "103", { view: "open" }],
      ["filtered: tag=vip", "110", { tag: "vip" }],
      ["filtered: q search", "104", { q: "o" }],
      ["filtered: mine=1 (alice)", "105", { mine: "1" }],
      ["current ticket outside the filtered set", "109", { status: "closed" }],
    ];
    it.each(cases)("%s", async (_n, num, params) => {
      expect(navView(await renderThread(num, params))).toMatchSnapshot();
    });
  });

  // Only CLOSED current tickets are characterized here. For an OPEN current
  // ticket the SQL value (now() - waitingSince, fractional) and the JS value
  // (rounded, computed a few ms earlier) are never exactly equal, so whether the
  // ticket shows ITSELF as its own prev/next depends on sub-second timing:
  // genuinely nondeterministic today, therefore not snapshotted.
  //
  // waitingTime compares a JS-computed value (new Date()) with SQL now(), so
  // Date must NOT be frozen here or the two clocks disagree and the result
  // would describe an artifact instead of real behaviour. The ordering is
  // independent of the actual run date because every fixture ticket predates it.
  describe("previous/next with sort=waitingTime (real clock)", () => {
    const cases: Array<[string, string, Params]> = [
      ["asc, closed ticket", "107", { sort: "waitingTime", order: "asc" }],
      ["desc, closed ticket", "107", { sort: "waitingTime", order: "desc" }],
    ];
    it.each(cases)("%s", async (_n, num, params) => {
      unfreezeDate();
      try {
        expect(navView(await renderThread(num, params))).toMatchSnapshot();
      } finally {
        freezeDate();
      }
    });
  });

  describe("redirects and 404s", () => {
    it("a merged ticket redirects to its target with ?mergedFrom=", async () => {
      expect(await outcome(() => renderThread("120"))).toMatchSnapshot();
    });
    it("the other merged ticket", async () => {
      expect(await outcome(() => renderThread("121"))).toMatchSnapshot();
    });
    it("unknown ticket number -> notFound", async () => {
      expect(await outcome(() => renderThread("999"))).toMatchSnapshot();
    });
    for (const bad of ["abc", "0", "-5", "", "1.5e3"]) {
      it(`malformed segment ${JSON.stringify(bad)}`, async () => {
        expect(await outcome(() => renderThread(bad))).toMatchSnapshot();
      });
    }
    it("a segment with trailing junk parses via parseInt (103abc renders #103)", async () => {
      const r = await outcome(() => renderThread("103abc"));
      expect(r).toBe("rendered");
    });
  });
});
