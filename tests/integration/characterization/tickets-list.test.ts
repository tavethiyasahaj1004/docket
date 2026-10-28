import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Only auth/navigation are mocked. requireAgent returns whichever fixture agent
// the test selects; redirect/notFound throw identifiable errors like Next does.
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

import TicketsPage from "@/app/(agent)/tickets/page";
import { seedWorld, USERS } from "../fixtures";
import { freezeDate, unfreezeDate, useSeededDatabase } from "./helpers";
import { captureTree, pick } from "./render-tree";

type Params = Record<string, string>;

const ALICE = session.current;
const BOB = {
  id: USERS.bob.id,
  name: "Bob Admin",
  email: USERS.bob.email,
  role: "admin",
};

/** Renders the page the way a request would and extracts what the data layer
 * produced: the "N tickets" text, the table rows (in order) and the tab counts. */
async function renderList(params: Params, agent = ALICE) {
  session.current = agent;
  const tree = await TicketsPage({ searchParams: Promise.resolve(params) });
  const capture = await captureTree(tree);

  const [table] = pick(capture, "TicketsTable");
  const [tabs] = pick(capture, "TicketViewTabs");
  const [pageSize] = pick(capture, "PageSizeSelect");
  const [goTo] = pick(capture, "GoToPage");
  // next/link is not a plain named function, so find links by their href prop.
  const links = capture.components
    .map((c) => (c.props as { href?: unknown } | null)?.href)
    .filter((h): h is string => typeof h === "string");
  const props = (table?.props ?? {}) as {
    rows?: Array<{ ticketNumber: number }>;
  };

  return {
    asyncCalls: capture.asyncCalls,
    text: capture.text,
    tabs: tabs?.props ?? null,
    rowNumbers: (props.rows ?? []).map((r) => r.ticketNumber),
    pagination: {
      pageSize: pageSize?.props ?? null,
      goTo: goTo?.props ?? null,
      links,
    },
    table: table?.props ?? null,
  };
}

/** A compact view for the many filter/sort cases: counts + the ordered ticket
 * numbers, plus the pagination links. The full-props snapshots are taken in
 * the dedicated "full render" cases. */
function summary(r: Awaited<ReturnType<typeof renderList>>) {
  return {
    text: r.text.filter(
      (t) =>
        /tickets?( matching your filters)?$/.test(t) ||
        t.startsWith("No tickets") ||
        t.startsWith("Try ") ||
        t.startsWith("Customers can")
    ),
    tabs: r.tabs,
    rowNumbers: r.rowNumbers,
    pagination: r.pagination,
  };
}

describe("agent ticket list page (characterization)", () => {
  useSeededDatabase(seedWorld);
  beforeAll(() => freezeDate());
  afterAll(() => unfreezeDate());
  beforeEach(() => {
    session.current = ALICE;
  });

  it("walks the real server components (async calls were awaited)", async () => {
    const r = await renderList({});
    expect(r.asyncCalls).toEqual(["TicketViewTabsResults", "TicketsResults"]);
  });

  it("default list: full table props, text and tab counts", async () => {
    const r = await renderList({});
    expect(r).toMatchSnapshot();
  });

  it("default list as another agent with columns hidden and a different mine/draft view", async () => {
    const r = await renderList({}, BOB);
    expect(r).toMatchSnapshot();
  });

  it("empty result", async () => {
    expect(
      summary(await renderList({ q: "zzz-no-such-ticket" }))
    ).toMatchSnapshot();
  });

  describe("search (q)", () => {
    const cases: Array<[string, string]> = [
      ["subject substring", "log in"],
      ["customer name (case-insensitive)", "ZED"],
      ["customer email", "pat@example"],
      ["ticket number", "104"],
      ["ticket number with hash", "#103"],
      ["trimmed", "  dark  "],
      ["percent only (wildcard, not escaped)", "%"],
      ["underscore only (wildcard, not escaped)", "_"],
      ["percent after digits (100%)", "100%"],
      ["literal underscore term", "snake_case"],
      ["underscore as single-char wildcard (s_ake)", "s_ake"],
      ["underscore in an email", "una_under"],
      ["underscore matching any char (una-under)", "una_under@example.test"],
      ["numeric prefix collides with subject text (1005)", "1005"],
    ];
    it.each(cases)("%s", async (_name, q) => {
      expect(summary(await renderList({ q }))).toMatchSnapshot();
    });
  });

  describe("filters", () => {
    const cases: Array<[string, Params]> = [
      ["status=open", { status: "open" }],
      ["status=closed", { status: "closed" }],
      ["status=open,in_progress (comma list)", { status: "open,in_progress" }],
      ["status=open, (trailing comma)", { status: "open," }],
      ["status=all", { status: "all" }],
      ["category=bug", { category: "bug" }],
      ["category=all", { category: "all" }],
      ["priority=high", { priority: "high" }],
      ["priority=all", { priority: "all" }],
      ["assignee=user-alice", { assignee: "user-alice" }],
      ["assignee=unassigned", { assignee: "unassigned" }],
      ["assignee=all", { assignee: "all" }],
      ["tag=vip", { tag: "vip" }],
      ["tag=billing", { tag: "billing" }],
      ["tag=unused-tag (no tickets)", { tag: "unused-tag" }],
      ["tag=all", { tag: "all" }],
      ["awaiting=1", { awaiting: "1" }],
      ["awaiting=0 (ignored)", { awaiting: "0" }],
      ["mine=1 (alice)", { mine: "1" }],
      ["view=awaiting", { view: "awaiting" }],
      ["view=open", { view: "open" }],
      ["view=bogus (ignored)", { view: "bogus" }],
      ["range=last_day", { range: "last_day" }],
      ["range=last_week", { range: "last_week" }],
      ["range=today", { range: "today" }],
      ["range=this_month (behaves like today)", { range: "this_month" }],
      ["range=7d", { range: "7d" }],
      ["range=30d", { range: "30d" }],
      ["range=90d", { range: "90d" }],
      ["range=all", { range: "all" }],
      ["range=bogus (ignored)", { range: "bogus" }],
      [
        "range=custom from+to",
        { range: "custom", from: "2026-03-01", to: "2026-03-10" },
      ],
      ["range=custom from only", { range: "custom", from: "2026-03-11" }],
      ["range=custom to only", { range: "custom", to: "2026-03-01" }],
      [
        "range=custom with malformed dates (ignored)",
        { range: "custom", from: "03/01/2026", to: "nope" },
      ],
      [
        "from/to without range=custom (ignored)",
        { from: "2026-03-14", to: "2026-03-15" },
      ],
      [
        "combined: status+category+priority",
        { status: "open", category: "billing", priority: "normal" },
      ],
      [
        "combined: view=awaiting + mine=1 + assignee ignored order",
        { view: "awaiting", mine: "1" },
      ],
      [
        "combined: q + tag + status",
        { q: "ticket", tag: "vip", status: "open" },
      ],
    ];
    it.each(cases)("%s", async (_name, params) => {
      expect(summary(await renderList(params))).toMatchSnapshot();
    });

    it("mine=1 as bob", async () => {
      expect(summary(await renderList({ mine: "1" }, BOB))).toMatchSnapshot();
    });
  });

  describe("sort", () => {
    const keys = ["id", "updatedAt", "waitingTime"];
    for (const sort of keys) {
      for (const order of ["asc", "desc"]) {
        it(`sort=${sort} order=${order}`, async () => {
          expect(summary(await renderList({ sort, order }))).toMatchSnapshot();
        });
      }
    }
    it("unknown sort falls back to updatedAt; unknown order to desc", async () => {
      const fallback = summary(
        await renderList({ sort: "bogus", order: "sideways" })
      );
      expect(fallback.rowNumbers).toEqual(
        summary(await renderList({})).rowNumbers
      );
      expect(fallback).toMatchSnapshot();
    });
    it("sort without order defaults to desc", async () => {
      expect(summary(await renderList({ sort: "id" }))).toMatchSnapshot();
    });
  });

  describe("pagination", () => {
    it("page 2 with pageSize=2", async () => {
      expect(
        summary(await renderList({ pageSize: "2", page: "2" }))
      ).toMatchSnapshot();
    });
    it("last page with pageSize=2 (page 6)", async () => {
      expect(
        summary(await renderList({ pageSize: "2", page: "6" }))
      ).toMatchSnapshot();
    });
    it("page beyond the end is empty", async () => {
      expect(
        summary(await renderList({ pageSize: "2", page: "99" }))
      ).toMatchSnapshot();
    });
    it("page 0 / negative / garbage page fall back to 1", async () => {
      const first = summary(await renderList({}));
      expect(summary(await renderList({ page: "0" })).rowNumbers).toEqual(
        first.rowNumbers
      );
      expect(summary(await renderList({ page: "-3" })).rowNumbers).toEqual(
        first.rowNumbers
      );
      expect(summary(await renderList({ page: "abc" })).rowNumbers).toEqual(
        first.rowNumbers
      );
    });
    for (const pageSize of ["2", "10", "25", "50", "100"]) {
      it(`pageSize=${pageSize}`, async () => {
        expect(summary(await renderList({ pageSize }))).toMatchSnapshot();
      });
    }
    it("page 2 with pageSize=10", async () => {
      expect(
        summary(await renderList({ pageSize: "10", page: "2" }))
      ).toMatchSnapshot();
    });
    for (const pageSize of ["7", "0", "abc", "1000"]) {
      it(`invalid pageSize=${pageSize} falls back to 25`, async () => {
        const r = summary(await renderList({ pageSize }));
        expect(r.pagination.pageSize).toMatchObject({ pageSize: 25 });
        expect(r).toMatchSnapshot();
      });
    }
    it("pagination links carry filters and sort", async () => {
      expect(
        summary(
          await renderList({
            status: "open",
            sort: "id",
            order: "asc",
            pageSize: "2",
            page: "2",
            q: "a",
          })
        )
      ).toMatchSnapshot();
    });
  });

  describe("merged tickets", () => {
    it("never appear in any list, even when searched for directly", async () => {
      const all = await renderList({ pageSize: "100" });
      expect(all.rowNumbers).not.toContain(120);
      expect(all.rowNumbers).not.toContain(121);
      const searched = await renderList({ q: "Duplicate login problem" });
      expect(searched.rowNumbers).toEqual([]);
      expect(summary(searched)).toMatchSnapshot();
    });
  });
});
