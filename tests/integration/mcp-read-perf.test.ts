import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedDefaultConfig } from "./fixtures";
import { addToken, addUser, setupMcpWorld, USERS } from "./mcp-helpers";
import { callTool, closeMcpClients, connectMcp } from "./mcp-read-helpers";

const world = setupMcpWorld();

const TICKETS = 10_000;
const CUSTOMERS = 200;
const CALLS_PER_TOOL = 20;
const DEFAULT_SIZE_TARGET = 30_000;
// A generous sanity bound only: the 1 s p95 figure is a benchmark to report,
// not something this test gates on.
const SANITY_P95_MS = 10_000;

const doc = (text: string) =>
  `'{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"' || ${text} || '"}]}]}'`;

async function seedBulk() {
  const sql = world.sql;
  await seedDefaultConfig(world.db);
  await sql.unsafe(`
    INSERT INTO customers (id, name, email, created_at, updated_at)
    SELECT 'pc-' || g, 'Customer ' || g, 'perf' || g || '@example.test', now(), now()
    FROM generate_series(1, ${CUSTOMERS}) g`);
  await sql.unsafe(`
    INSERT INTO tickets (id, subject, description, category, status, priority,
      customer_id, customer_token, assigned_agent_id, awaiting_reply, source,
      closed_at, created_at, updated_at)
    SELECT 'pt-' || g,
      'Perf ticket ' || g || ' ' || repeat('subject text ', 4),
      ${doc("repeat('lorem ipsum ', 40)")},
      (array['bug','issue','feature_request','billing','general_query'])[1 + g % 5],
      (array['open','in_progress','closed'])[1 + g % 3],
      (array['low','normal','high','urgent'])[1 + g % 4],
      'pc-' || (1 + g % ${CUSTOMERS}),
      'ptok-' || g,
      CASE WHEN g % 4 = 0 THEN '${USERS.alice.id}' WHEN g % 4 = 1 THEN '${USERS.bob.id}' ELSE NULL END,
      g % 5 = 0,
      'portal',
      CASE WHEN g % 3 = 2 THEN now() - make_interval(mins => g) ELSE NULL END,
      now() - make_interval(mins => g),
      now() - make_interval(mins => g) + make_interval(secs => 30)
    FROM generate_series(1, ${TICKETS}) g`);
  await sql.unsafe(`
    INSERT INTO ticket_comments (id, ticket_id, author_name, author_role, content, is_internal, created_at, updated_at)
    SELECT 'pcm-' || g || '-' || k, 'pt-' || g, 'Customer', 'customer',
      ${doc("repeat('reply text ', 30)")}, false,
      now() - make_interval(mins => g) + make_interval(secs => k),
      now() - make_interval(mins => g) + make_interval(secs => k)
    FROM generate_series(1, ${TICKETS}) g, generate_series(1, 2) k`);
  // One long thread, so the default thread call has to be trimmed.
  await sql.unsafe(`
    INSERT INTO ticket_comments (id, ticket_id, author_name, author_role, content, is_internal, created_at, updated_at)
    SELECT 'long-' || k, 'pt-1', 'Customer', 'customer',
      ${doc("repeat('long reply ', 140)")}, false,
      now() + make_interval(secs => k), now() + make_interval(secs => k)
    FROM generate_series(1, 200) k`);
  await sql.unsafe(`
    INSERT INTO tags (id, name) SELECT 'ptag-' || g, 'ptag' || g FROM generate_series(1, 50) g`);
  await sql.unsafe(`
    INSERT INTO ticket_tags (id, ticket_id, tag_id)
    SELECT 'ptt-' || g, 'pt-' || g, 'ptag-' || (1 + g % 50) FROM generate_series(1, ${TICKETS}) g`);
  await sql.unsafe(`
    INSERT INTO canned_responses (id, title, content, created_by_name, created_at, updated_at)
    SELECT 'pcr-' || g, 'Canned ' || g, ${doc("repeat('template text ', 60)")}, 'Seed', now(), now()
    FROM generate_series(1, 100) g`);
  await sql.unsafe("ANALYZE");
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await closeMcpClients();
  vi.restoreAllMocks();
});

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];

describe("read tools on a 10,000-ticket database", () => {
  it("keep default calls under the size target and report latency", async () => {
    await seedBulk();
    const [{ n }] = await world.sql`SELECT count(*)::int AS n FROM tickets`;
    expect(n).toBe(TICKETS);

    const cases: [string, string, Record<string, unknown>][] = [
      ["whoami", "whoami", {}],
      ["get_ticket_config", "get_ticket_config", {}],
      ["list_tickets (default)", "list_tickets", {}],
      [
        "list_tickets (search, pageSize 50)",
        "list_tickets",
        { query: "Perf ticket 99", pageSize: 50 },
      ],
      [
        "list_tickets (filters)",
        "list_tickets",
        {
          view: "open",
          assignee: USERS.alice.id,
          tag: "ptag7",
          sort: "waiting_time",
        },
      ],
      ["get_ticket", "get_ticket", { ticket: 1 }],
      ["get_ticket_thread (long thread)", "get_ticket_thread", { ticket: 1 }],
      [
        "get_ticket_thread (max limit and body)",
        "get_ticket_thread",
        { ticket: 1, limit: 100, maxBodyChars: 10_000 },
      ],
      ["get_customer", "get_customer", { customerId: "pc-5" }],
      ["list_agents", "list_agents", {}],
      ["search_canned_responses", "search_canned_responses", {}],
      ["get_ticket_stats", "get_ticket_stats", {}],
      ["get_report (by_agent)", "get_report", { kind: "by_agent" }],
      ["get_report (by_tag)", "get_report", { kind: "by_tag", range: "all" }],
    ];

    const lines: string[] = [
      "",
      `tool latency over ${CALLS_PER_TOOL} calls on ${TICKETS} tickets (ms) and default result size (chars)`,
      "tool".padEnd(42) +
        "p50".padStart(8) +
        "p95".padStart(8) +
        "max".padStart(8) +
        "size".padStart(9),
    ];
    for (const [label, name, args] of cases) {
      // One user per case: the endpoint allows 120 calls a minute per user,
      // and this loop makes far more than that overall.
      const owner = await addUser(world.db, {
        role: name === "get_report" ? "admin" : "agent",
      });
      const token = await addToken(world.db, owner, {
        scopes: ["tickets:read", "customers:read", "reports:read"],
      });
      const client = await connectMcp(token.raw);
      const times: number[] = [];
      let size = 0;
      for (let i = 0; i < CALLS_PER_TOOL; i++) {
        const started = performance.now();
        const result = await callTool(client, name, args);
        times.push(performance.now() - started);
        expect(result.isError, `${label}: ${result.text.slice(0, 200)}`).toBe(
          false
        );
        expect(result.protocolError, label).toBeNull();
        size = result.text.length;
      }
      times.sort((a, b) => a - b);
      const p95 = percentile(times, 0.95);
      lines.push(
        label.padEnd(42) +
          percentile(times, 0.5).toFixed(0).padStart(8) +
          p95.toFixed(0).padStart(8) +
          times.at(-1)?.toFixed(0).padStart(8) +
          String(size).padStart(9)
      );
      expect(size, `${label} size`).toBeLessThanOrEqual(DEFAULT_SIZE_TARGET);
      expect(p95, `${label} p95`).toBeLessThan(SANITY_P95_MS);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  }, 600_000);
});
