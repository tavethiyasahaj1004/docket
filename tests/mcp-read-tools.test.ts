import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { encodeThreadCursor } from "@/lib/mcp/cursor";
import { MCP_RESULT_TARGET_CHARS } from "@/lib/mcp/limits";
import { jsonLength, largestFittingCount } from "@/lib/mcp/size";
import { getCustomerInput, shrinkCustomer } from "@/lib/mcp/tools/customers";
import { reportInput, shrinkReport, statsInput } from "@/lib/mcp/tools/stats";
import {
  cannedInput,
  listAgentsInput,
  shrinkAgents,
  shrinkCanned,
} from "@/lib/mcp/tools/team";
import { getThreadInput, shrinkThread } from "@/lib/mcp/tools/thread";
import {
  buildTicketListParams,
  getTicketInput,
  type ListTicketsArgs,
  listTicketsInput,
  shrinkTicketDetail,
  shrinkTicketList,
} from "@/lib/mcp/tools/tickets";

const ok = (
  schema: { safeParse: (v: unknown) => { success: boolean } },
  v: unknown
) => schema.safeParse(v).success;

describe("input schema bounds", () => {
  it("list_tickets", () => {
    expect(ok(listTicketsInput, {})).toBe(true);
    expect(ok(listTicketsInput, { page: 1, pageSize: 1 })).toBe(true);
    expect(ok(listTicketsInput, { page: 1000, pageSize: 50 })).toBe(true);
    for (const bad of [
      { page: 0 },
      { page: 1001 },
      { page: 1.5 },
      { pageSize: 0 },
      { pageSize: 51 },
      { query: "" },
      { query: "   " },
      { query: "x".repeat(201) },
      { status: [] },
      { status: Array.from({ length: 21 }, (_, i) => `s${i}`) },
      { view: "closed" },
      { sort: "id" },
      { order: "up" },
      { tag: "t".repeat(51) },
      { createdAfter: "2026-3-1" },
      { createdAfter: "yesterday" },
      { awaitingReply: "yes" },
      { unknown: 1 },
    ]) {
      expect(ok(listTicketsInput, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("fills list_tickets defaults", () => {
    expect(listTicketsInput.parse({})).toEqual({
      sort: "updated",
      order: "desc",
      page: 1,
      pageSize: 20,
    });
  });

  it("get_ticket and get_ticket_thread", () => {
    expect(ok(getTicketInput, { ticket: 1 })).toBe(true);
    expect(ok(getTicketInput, { ticket: "#1", maxBodyChars: 200 })).toBe(true);
    expect(ok(getTicketInput, { ticket: "x", maxBodyChars: 10_000 })).toBe(
      true
    );
    for (const bad of [
      {},
      { ticket: 0 },
      { ticket: 1.5 },
      { ticket: "" },
      { ticket: "x".repeat(41) },
      { ticket: 1, maxBodyChars: 199 },
      { ticket: 1, maxBodyChars: 10_001 },
      { ticket: 1, includeInternal: "true" },
      { ticket: 1, extra: true },
    ]) {
      expect(ok(getTicketInput, bad), JSON.stringify(bad)).toBe(false);
    }
    expect(getTicketInput.parse({ ticket: 1 })).toMatchObject({
      includeInternal: false,
      maxBodyChars: 2000,
    });

    expect(getThreadInput.parse({ ticket: 1 })).toMatchObject({
      includeInternal: false,
      includeActivity: false,
      order: "oldest_first",
      limit: 30,
      maxBodyChars: 2000,
    });
    for (const bad of [
      { ticket: 1, limit: 0 },
      { ticket: 1, limit: 101 },
      { ticket: 1, order: "random" },
      { ticket: 1, cursor: "" },
      { ticket: 1, cursor: "c".repeat(201) },
    ]) {
      expect(ok(getThreadInput, bad), JSON.stringify(bad)).toBe(false);
    }
    expect(ok(getThreadInput, { ticket: 1, limit: 100 })).toBe(true);
  });

  it("get_customer", () => {
    // The exactly-one-of rule lives in the handler, not the schema.
    expect(ok(getCustomerInput, {})).toBe(true);
    expect(ok(getCustomerInput, { email: "a@b.test" })).toBe(true);
    for (const bad of [
      { email: "not-an-email" },
      { email: `${"a".repeat(320)}@b.test` },
      { customerId: "" },
      { ticketLimit: 0 },
      { ticketLimit: 51 },
      { ticketLimit: 2.5 },
    ]) {
      expect(ok(getCustomerInput, bad), JSON.stringify(bad)).toBe(false);
    }
    expect(getCustomerInput.parse({})).toMatchObject({
      ticketLimit: 10,
      includeNote: false,
    });
  });

  it("list_agents, search_canned_responses, stats and report", () => {
    expect(ok(listAgentsInput, { query: "x".repeat(100) })).toBe(true);
    expect(ok(listAgentsInput, { query: "x".repeat(101) })).toBe(false);
    expect(cannedInput.parse({})).toMatchObject({
      limit: 10,
      maxBodyChars: 2000,
    });
    expect(ok(cannedInput, { limit: 20 })).toBe(true);
    for (const bad of [
      { limit: 0 },
      { limit: 21 },
      { query: "x".repeat(101) },
    ]) {
      expect(ok(cannedInput, bad), JSON.stringify(bad)).toBe(false);
    }
    expect(statsInput.parse({})).toEqual({ volumeDays: 7 });
    expect(ok(statsInput, { volumeDays: 30 })).toBe(true);
    for (const bad of [
      { volumeDays: 6 },
      { volumeDays: 31 },
      { volumeDays: 7.5 },
      { volumeDays: Number.NaN },
      { volumeDays: "7" },
    ]) {
      expect(ok(statsInput, bad), JSON.stringify(bad)).toBe(false);
    }
    expect(reportInput.parse({ kind: "by_tag" })).toEqual({
      kind: "by_tag",
      range: "30d",
    });
    for (const bad of [
      {},
      { kind: "by_team" },
      { kind: "by_tag", range: "7d" },
    ]) {
      expect(ok(reportInput, bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("buildTicketListParams", () => {
  const config = {
    statusSlugs: new Set(["open", "closed"]),
    prioritySlugs: new Set(["high"]),
    categorySlugs: new Set(["bug"]),
  };
  const parse = (v: Record<string, unknown>): ListTicketsArgs =>
    listTicketsInput.parse(v);

  it("maps the defaults onto the agent list's params", () => {
    expect(buildTicketListParams(parse({}), config)).toEqual({
      sort: "updatedAt",
      order: "desc",
      page: "1",
    });
  });

  it("maps every filter", () => {
    expect(
      buildTicketListParams(
        parse({
          query: " #5 ",
          status: ["open", "closed", "open"],
          view: "awaiting",
          priority: "high",
          category: "bug",
          assignee: "me",
          tag: "  Big   Customer ",
          awaitingReply: true,
          createdAfter: "2026-01-01",
          createdBefore: "2026-01-31",
          sort: "waiting_time",
          order: "asc",
          page: 3,
        }),
        config
      )
    ).toEqual({
      q: "#5",
      status: "open,closed",
      view: "awaiting",
      priority: "high",
      category: "bug",
      mine: "1",
      tag: "big customer",
      awaiting: "1",
      range: "custom",
      from: "2026-01-01",
      to: "2026-01-31",
      sort: "waitingTime",
      order: "asc",
      page: "3",
    });
  });

  it("maps unassigned and an agent id onto the assignee filter", () => {
    expect(
      buildTicketListParams(parse({ assignee: "unassigned" }), config).assignee
    ).toBe("unassigned");
    const byId = buildTicketListParams(parse({ assignee: "user-1" }), config);
    expect(byId.assignee).toBe("user-1");
    expect(byId.mine).toBeUndefined();
  });

  it("does not set awaiting for awaitingReply false", () => {
    expect(
      buildTicketListParams(parse({ awaitingReply: false }), config).awaiting
    ).toBeUndefined();
  });

  it("rejects unknown slugs, impossible dates and blank tags", () => {
    for (const v of [
      { status: ["nope"] },
      { priority: "low" },
      { category: "nope" },
      { createdAfter: "2026-02-30" },
      { createdBefore: "2026-00-10" },
      { tag: " \t " },
    ]) {
      expect(
        () => buildTicketListParams(parse(v), config),
        JSON.stringify(v)
      ).toThrowError(/./);
    }
  });
});

describe("size trimming", () => {
  it("largestFittingCount finds the longest fitting prefix", () => {
    expect(largestFittingCount(10, (n) => n <= 4)).toBe(4);
    expect(largestFittingCount(10, () => true)).toBe(10);
    expect(largestFittingCount(10, (n) => n === 0)).toBe(0);
    expect(largestFittingCount(0, () => true)).toBe(0);
  });

  const ticket = (i: number) => ({
    id: `t${i}`,
    number: i,
    subject: "s".repeat(1000),
    status: { slug: "open", label: "Open", isClosed: false },
    priority: { slug: "high", label: "High" },
    category: { slug: "bug", label: "Bug" },
    customer: { id: "c", name: "n" },
    assignee: null,
    awaitingReply: false,
    pendingReplies: 0,
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    agentUrl: `http://x/tickets/${i}`,
  });

  it("drops trailing tickets and flags the list", () => {
    const result = {
      tickets: Array.from({ length: 50 }, (_, i) => ticket(i)),
      page: 1,
      pageSize: 50,
      total: 500,
      hasMore: true,
    };
    expect(jsonLength(result)).toBeGreaterThan(MCP_RESULT_TARGET_CHARS);
    const shrunk = shrinkTicketList(result);
    expect(jsonLength(shrunk)).toBeLessThanOrEqual(MCP_RESULT_TARGET_CHARS);
    expect(shrunk.truncatedForSize).toBe(true);
    expect(shrunk.hasMore).toBe(true);
    expect(shrunk.tickets.length).toBeGreaterThan(0);
    expect(shrunk.tickets.length).toBeLessThan(50);
    expect(shrunk.tickets.map((t) => t.number)).toEqual(
      Array.from({ length: shrunk.tickets.length }, (_, i) => i)
    );
    expect(shrunk.total).toBe(500);
  });

  const message = (i: number, bodyLength: number) => ({
    kind: "message" as const,
    id: `m${String(i).padStart(3, "0")}`,
    visibility: "public" as const,
    authorRole: "customer",
    authorName: "A",
    body: "b".repeat(bodyLength),
    truncated: false,
    fullLength: bodyLength,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    attachments: [],
  });
  const thread = (
    items: ReturnType<typeof message>[],
    nextCursor: string | null = null
  ) => ({
    ticket: {
      id: "t",
      number: 1,
      subject: "s",
      status: { slug: "open", label: "Open", isClosed: false },
    },
    items,
    nextCursor,
  });

  it("trims a thread, pointing nextCursor at the last item kept", () => {
    const items = Array.from({ length: 30 }, (_, i) => message(i, 10_000));
    const shrunk = shrinkThread(thread(items));
    expect(jsonLength(shrunk)).toBeLessThanOrEqual(MCP_RESULT_TARGET_CHARS);
    expect(shrunk.truncatedForSize).toBe(true);
    expect(shrunk.items.length).toBeGreaterThan(0);
    expect(shrunk.items.length).toBeLessThan(30);
    const last = shrunk.items.at(-1);
    expect(shrunk.nextCursor).toBe(
      encodeThreadCursor(last?.createdAt ?? "", last?.id ?? "")
    );
  });

  it("keeps the original nextCursor when nothing was dropped", () => {
    const shrunk = shrinkThread(thread([message(0, 100)], "keep-me"));
    expect(shrunk.nextCursor).toBe("keep-me");
    expect(shrunk.truncatedForSize).toBe(true);
  });

  it("shortens a single oversized message instead of returning nothing", () => {
    const only = message(0, 10_000);
    const big = {
      ...only,
      attachments: Array.from({ length: 300 }, (_, i) => ({
        id: `a${i}`,
        filename: "f".repeat(100),
        mimeType: "application/pdf",
        fileSize: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      })),
    };
    const shrunk = shrinkThread(thread([big as never]));
    expect(shrunk.items).toHaveLength(1);
    expect(jsonLength(shrunk)).toBeLessThanOrEqual(MCP_RESULT_TARGET_CHARS);
  });

  it("shortens a ticket's description and caps its lists", () => {
    const detail = {
      ...ticket(1),
      customer: { id: "c", name: "n", email: "e@x.test" },
      description: {
        body: "d".repeat(10_000),
        truncated: false,
        fullLength: 10_000,
      },
      source: "portal",
      customFields: [],
      links: [],
      attachments: Array.from({ length: 400 }, (_, i) => ({
        id: `a${i}`,
        filename: "f".repeat(80),
        mimeType: "application/pdf",
        fileSize: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      })),
      sla: { waitingSince: null, firstRespondedAt: null },
      commentCounts: { public: 1 },
    };
    expect(jsonLength(detail)).toBeGreaterThan(MCP_RESULT_TARGET_CHARS);
    const shrunk = shrinkTicketDetail(detail);
    expect(jsonLength(shrunk)).toBeLessThanOrEqual(MCP_RESULT_TARGET_CHARS);
    expect(shrunk.truncatedForSize).toBe(true);
    expect(shrunk.description.truncated).toBe(true);
    expect(shrunk.description.fullLength).toBe(10_000);
    expect(shrunk.attachments.length).toBeLessThan(400);
  });

  it("caps a customer's ticket lists, agents and canned responses", () => {
    const t = (i: number) => ({
      id: `t${i}`,
      number: i,
      subject: "s".repeat(1500),
      status: { slug: "open", label: "Open", isClosed: false },
      createdAt: "2026-01-01T00:00:00.000Z",
      agentUrl: "http://x",
    });
    const customer = shrinkCustomer({
      id: "c",
      name: "n",
      email: "e@x.test",
      note: null,
      openTickets: Array.from({ length: 50 }, (_, i) => t(i)),
      closedTickets: Array.from({ length: 50 }, (_, i) => t(i)),
      openTotal: 50,
      closedTotal: 50,
      frequency: [],
    });
    expect(jsonLength(customer)).toBeLessThanOrEqual(MCP_RESULT_TARGET_CHARS);
    expect(customer.openTotal).toBe(50);
    expect(customer.truncatedForSize).toBe(true);

    const agents = shrinkAgents({
      agents: Array.from({ length: 200 }, (_, i) => ({
        id: `u${i}`,
        name: "n".repeat(200),
        email: `${"e".repeat(100)}${i}@x.test`,
        role: "agent",
      })),
      truncated: false,
    });
    expect(jsonLength(agents)).toBeLessThanOrEqual(MCP_RESULT_TARGET_CHARS);
    expect(agents.truncated).toBe(true);

    const canned = shrinkCanned({
      responses: Array.from({ length: 20 }, (_, i) => ({
        id: `r${i}`,
        title: "t",
        body: "b".repeat(10_000),
        truncated: false,
        fullLength: 10_000,
      })),
    });
    expect(jsonLength(canned)).toBeLessThanOrEqual(MCP_RESULT_TARGET_CHARS);
    expect(canned.truncatedForSize).toBe(true);
    expect(canned.responses.length).toBeGreaterThan(0);
  });

  it("drops a large report's trailing rows and says how many", () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({
      agentId: `agent-${i}`,
      agentName: "n".repeat(100),
      totalTickets: 500 - i,
      openTickets: 0,
      avgFirstResponseSeconds: null,
      avgResolutionSeconds: null,
    }));
    const report = shrinkReport({ kind: "by_agent", range: "all", rows });
    expect(jsonLength(report)).toBeLessThanOrEqual(MCP_RESULT_TARGET_CHARS);
    expect(report.truncatedForSize).toBe(true);
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.rows.length + (report.omittedRows ?? 0)).toBe(500);
    // The kept rows are the leading (busiest) ones.
    expect(report.rows).toEqual(rows.slice(0, report.rows.length));
  });
});
