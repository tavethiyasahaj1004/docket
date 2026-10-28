import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hooks the mocks below read. Hoisted so the factories can see them.
const hooks = vi.hoisted(() => ({
  /** Runs after the next webhook dispatch succeeds (then clears itself). */
  afterWebhook: null as null | (() => Promise<void>),
  /** Makes webhook dispatch reject. */
  failWebhook: false,
  /** Makes the attachment-limit lookup (used by internal notes) throw. */
  failLimits: false,
}));

vi.mock("@/lib/auth", async () =>
  (await import("./characterization/write-helpers")).authModule()
);
vi.mock("@/lib/worker/enqueue", async () =>
  (await import("./characterization/write-helpers")).enqueueModule()
);
vi.mock("@/lib/realtime", async (importOriginal) =>
  (await import("./characterization/write-helpers")).realtimeModule(
    await importOriginal<Record<string, unknown>>()
  )
);
vi.mock("@/lib/push", async (importOriginal) =>
  (await import("./characterization/write-helpers")).pushModule(
    await importOriginal<Record<string, unknown>>()
  )
);
vi.mock("@/lib/webhooks/dispatch", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/webhooks/dispatch")>();
  return {
    ...original,
    dispatchWebhookEvent: async (
      ...args: Parameters<typeof original.dispatchWebhookEvent>
    ) => {
      if (hooks.failWebhook) {
        throw new Error("simulated webhook failure");
      }
      const result = await original.dispatchWebhookEvent(...args);
      const after = hooks.afterWebhook;
      hooks.afterWebhook = null;
      await after?.();
      return result;
    },
  };
});
vi.mock("@/lib/settings", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/settings")>();
  return {
    ...original,
    getAttachmentLimits: (
      ...args: Parameters<typeof original.getAttachmentLimits>
    ) => {
      if (hooks.failLimits) {
        throw new Error("simulated limits failure password=hunter2");
      }
      return original.getAttachmentLimits(...args);
    },
  };
});

import { POST as POST_COMMENT } from "@/app/api/tickets/[id]/comments/route";
import { PATCH } from "@/app/api/tickets/[id]/route";
import { POST as POST_TAG } from "@/app/api/tickets/[id]/tags/route";
import * as schema from "@/db/schema";
import { db } from "@/lib/db";
import { FORBIDDEN_OUTPUT_PATTERNS } from "@/lib/mcp/dto";
import { MCP_ERROR_DETAIL_KEYS } from "@/lib/mcp/errors";
import { hmacToolArgs } from "@/lib/mcp/safe-handler";
import {
  getReplyDraft,
  MAX_DRAFT_LENGTH,
  saveReplyDraft,
} from "@/lib/tickets/reply-drafts";
import {
  loadTicketForChange,
  setTicketCategory,
  setTicketPriority,
} from "@/lib/tickets/services/ticket-fields";
import {
  ALL_TICKET_EVENTS,
  actions,
  agentSession,
  callLog,
  captureEffects,
  commentRequest,
  ctx,
  enqueueMode,
  events,
  getSession,
  jsonRequest,
} from "./characterization/write-helpers";
import { CUSTOMERS, doc, tid, USERS } from "./fixtures";
import { addToken, auditRows, setupMcpWorld } from "./mcp-helpers";
import {
  ALICE,
  BOB,
  callTool,
  closeMcpClients,
  connectMcp,
  seedReadWorld,
  type ToolOutcome,
  wasRejected,
} from "./mcp-read-helpers";

const world = setupMcpWorld();

const WRITE_SCOPES = ["tickets:read", "customers:read", "tickets:write"];
const WRITE_TOOLS = [
  "save_reply_draft",
  "add_internal_note",
  "update_ticket_tags",
  "update_ticket_fields",
];
const READ_TOOLS = [
  "whoami",
  "get_ticket_config",
  "list_tickets",
  "get_ticket",
  "get_ticket_thread",
  "get_customer",
  "list_agents",
  "search_canned_responses",
  "get_ticket_stats",
];

const NOTE_BODY = "ZZ-MCP-NOTE-BODY-ZZ";
const DRAFT_BODY = "ZZ-MCP-DRAFT-BODY-ZZ";
const key = (n: string) => `req-${n}-0123456789abcdef`;

type Row = Record<string, unknown>;

/* ------------------------------------------------------------- harness */

async function writer(userId: string = ALICE, scopes = WRITE_SCOPES) {
  const token = await addToken(world.db, userId, { scopes });
  const client = await connectMcp(token.raw);
  return { client, tokenId: token.id };
}

/** Everything a write tool returns passes through here: no forbidden field,
 * and no echo of the body that was written. */
function scan(text: string) {
  for (const pattern of FORBIDDEN_OUTPUT_PATTERNS) {
    const hit =
      typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
    if (hit) {
      throw new Error(`Forbidden output pattern ${String(pattern)}: ${text}`);
    }
  }
  for (const secret of [
    NOTE_BODY,
    DRAFT_BODY,
    CUSTOMERS.ann.email,
    "token-101",
  ]) {
    if (text.includes(secret)) {
      throw new Error(`Output leaks ${secret}: ${text}`);
    }
  }
}

async function call(
  client: Awaited<ReturnType<typeof writer>>["client"],
  name: string,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const outcome = await callTool(client, name, args);
  scan(outcome.text);
  return outcome;
}

/** An error result: tool error, the code, and text === JSON.stringify(data). */
function expectError(r: ToolOutcome, code: string) {
  expect(r.protocolError, r.text).toBeNull();
  expect(r.isError, r.text).toBe(true);
  expect(r.errorCode).toBe(code);
  expect(r.text).toBe(JSON.stringify(r.data));
  const error = r.data.error as {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  expect(typeof error.message).toBe("string");
  for (const k of Object.keys(error.details ?? {})) {
    expect(MCP_ERROR_DETAIL_KEYS as readonly string[]).toContain(k);
  }
  return error;
}

function expectOk(r: ToolOutcome) {
  expect(r.protocolError, r.text).toBeNull();
  expect(r.isError, r.text).toBe(false);
  expect(r.text).toBe(JSON.stringify(r.data));
  return r.data as Record<string, unknown>;
}

const sql = () => world.sql;

async function ledger(): Promise<Row[]> {
  return (await sql()`
    SELECT * FROM mcp_tool_calls ORDER BY created_at, id`) as unknown as Row[];
}
async function activityRows(ticketId: string): Promise<Row[]> {
  return (await sql()`
    SELECT action, actor_id, actor_name, actor_role, metadata
    FROM ticket_activity WHERE ticket_id = ${ticketId}
    ORDER BY created_at, id`) as unknown as Row[];
}
/** Activity added by a call: everything except the seeded t-101 history. */
async function newActivity(ticketId: string, action: string): Promise<Row[]> {
  return (await activityRows(ticketId)).filter(
    (r) => r.action === action && (r.metadata as Row | null)?.via === "mcp"
  );
}
async function commentsOn(ticketId: string): Promise<Row[]> {
  return (await sql()`
    SELECT id, author_id, author_name, author_role, is_internal, content, created_at
    FROM ticket_comments WHERE ticket_id = ${ticketId} ORDER BY created_at, id`) as unknown as Row[];
}
async function deliveries(): Promise<string[]> {
  const rows = await sql()`
    SELECT event FROM webhook_deliveries ORDER BY event, id`;
  return rows.map((r) => String(r.event));
}
async function outboxCount(): Promise<number> {
  const [row] = await sql()`SELECT count(*)::int AS n FROM email_outbox`;
  return row.n as number;
}
async function draftRow(ticketId: string, userId = ALICE) {
  const rows = await sql()`
    SELECT content, is_internal,
           (extract(epoch FROM updated_at) * 1000000)::bigint AS updated_us
    FROM ticket_reply_drafts
    WHERE ticket_id = ${ticketId} AND user_id = ${userId}`;
  return rows[0] as
    | { content: string; is_internal: boolean; updated_us: string }
    | undefined;
}
async function ticketRow(ticketId: string) {
  const [row] = await sql()`
    SELECT status, priority, category,
           (extract(epoch FROM date_trunc('milliseconds', updated_at)) * 1000)::bigint AS updated_ms
    FROM tickets WHERE id = ${ticketId}`;
  return {
    status: row.status as string,
    priority: row.priority as string,
    category: row.category as string,
    updatedMs: Number(row.updated_ms),
  };
}
const isoOf = (ms: number) => new Date(ms).toISOString();

const quiet: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(async () => {
  for (const method of ["log", "warn", "error", "info"] as const) {
    quiet.push(vi.spyOn(console, method).mockImplementation(() => undefined));
  }
  hooks.afterWebhook = null;
  hooks.failWebhook = false;
  hooks.failLimits = false;
  callLog.length = 0;
  getSession.mockReset();
  getSession.mockResolvedValue(agentSession);
  enqueueMode.email = "resolve";
  await seedReadWorld(world.db);
  await world.db.insert(schema.webhookEndpoints).values({
    id: "wh-1",
    name: "Write hook",
    url: "https://hooks.example.test/docket",
    secretEncrypted: "not-a-real-secret",
    events: ALL_TICKET_EVENTS,
    isActive: true,
    createdById: USERS.bob.id,
    createdByName: USERS.bob.name,
  });
});

afterEach(async () => {
  await closeMcpClients();
  vi.restoreAllMocks();
  quiet.length = 0;
});

/* ----------------------------------------------------- scope enforcement */

describe("scope enforcement", () => {
  it("does not list or run the write tools for a default (read-only) token", async () => {
    const token = await addToken(world.db, ALICE);
    const client = await connectMcp(token.raw);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(READ_TOOLS);

    const args: Record<string, Record<string, unknown>> = {
      save_reply_draft: { ticket: 101, body: DRAFT_BODY },
      add_internal_note: {
        ticket: 101,
        body: NOTE_BODY,
        clientRequestId: key("denied"),
      },
      update_ticket_tags: { ticket: 101, add: ["x"] },
      update_ticket_fields: { ticket: 101, priority: "low" },
    };
    for (const name of WRITE_TOOLS) {
      const r = await callTool(client, name, args[name]);
      expect(r.protocolError, name).toMatch(/unknown tool|not found/i);
    }
    const [{ n }] = await sql()`SELECT count(*)::int AS n FROM mcp_tool_calls`;
    expect(n).toBe(0);
    expect(await commentsOn(tid(101))).toHaveLength(5);
    expect(await deliveries()).toEqual([]);
  });

  it("lists exactly the four write tools, after the read tools, for tickets:write", async () => {
    const { client } = await writer();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...READ_TOOLS, ...WRITE_TOOLS]);
  });

  it("lists them after get_report for an admin", async () => {
    const { client } = await writer(BOB, [...WRITE_SCOPES, "reports:read"]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      ...READ_TOOLS,
      "get_report",
      ...WRITE_TOOLS,
    ]);
  });

  it("lists the write tools for a token with tickets:write alone", async () => {
    const { client } = await writer(ALICE, ["tickets:write"]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["whoami", ...WRITE_TOOLS]);
  });

  it("declares annotations, schemas and no requiresUserInteraction hint", async () => {
    const { client } = await writer();
    const { tools } = await client.listTools();
    const write = tools.filter((t) => WRITE_TOOLS.includes(t.name));
    expect(write).toHaveLength(4);
    const expected: Record<string, Row> = {
      save_reply_draft: { idempotentHint: true, openWorldHint: false },
      add_internal_note: { idempotentHint: false, openWorldHint: false },
      update_ticket_tags: { idempotentHint: true, openWorldHint: false },
      update_ticket_fields: { idempotentHint: true, openWorldHint: true },
    };
    for (const tool of write) {
      expect(tool.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        ...expected[tool.name],
      });
      expect(tool._meta).toBeUndefined();
      expect(tool.outputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect((tool.description ?? "").length).toBeLessThanOrEqual(1000);
      for (const keyword of ["anyOf", "oneOf", "allOf"]) {
        expect(tool.inputSchema).not.toHaveProperty(keyword);
      }
    }
    const note = write.find((t) => t.name === "add_internal_note");
    expect(note?.inputSchema.required).toContain("clientRequestId");
    const draft = write.find((t) => t.name === "save_reply_draft");
    expect(draft?.inputSchema.required ?? []).not.toContain("clientRequestId");
  });

  it("has none of the Phase 6 tools, even with every scope", async () => {
    const { client } = await writer(BOB, [
      "tickets:read",
      "tickets:read_internal",
      "customers:read",
      "tickets:write",
      "tickets:manage",
      "tickets:reply",
      "reports:read",
    ]);
    const { tools } = await client.listTools();
    for (const name of [
      "assign_ticket",
      "set_ticket_status",
      "close_ticket",
      "reopen_ticket",
      "reply_to_customer",
    ]) {
      expect(tools.map((t) => t.name)).not.toContain(name);
    }
  });
});

/* ------------------------------------------------------- save_reply_draft */

describe("save_reply_draft (W1)", () => {
  it("saves a new draft into the caller's own composer", async () => {
    const { client, tokenId } = await writer();
    const r = expectOk(
      await call(client, "save_reply_draft", {
        ticket: 101,
        body: DRAFT_BODY,
      })
    );
    expect(r.ticket).toEqual({
      number: 101,
      agentUrl: "http://localhost:3000/tickets/101",
    });
    expect(r.unchanged).toBe(false);
    expect((r.draft as Row).visibility).toBe("public");

    const draft = await draftRow(tid(101));
    expect(draft?.is_internal).toBe(false);
    expect(draft?.content).toContain(DRAFT_BODY);
    expect(isoOf(Number(draft?.updated_us) / 1000)).toBe(
      (r.draft as Row).updatedAt
    );
    // The UI writes no activity for a draft, and neither does MCP.
    expect(await newActivity(tid(101), "comment_added")).toEqual([]);
    expect(
      (await activityRows(tid(101))).some((a) => a.action === "draft_saved")
    ).toBe(false);
    // Another agent's drafts are not touched.
    expect(await draftRow(tid(101), BOB)).toBeUndefined();

    const audits = await auditRows(sql(), "mcp.save_reply_draft");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_id: ALICE,
      actor_email: USERS.alice.email,
      entity_type: "ticket",
      entity_id: tid(101),
    });
    expect(audits[0].description).toContain("#101");
    expect(audits[0].metadata).toMatchObject({
      via: "mcp",
      credentialId: tokenId,
      clientId: null,
      visibility: "public",
    });
  });

  it("saves an internal draft, and html is accepted", async () => {
    const { client } = await writer();
    const r = expectOk(
      await call(client, "save_reply_draft", {
        ticket: "#103",
        body: `<p>${DRAFT_BODY} <strong>bold</strong></p>`,
        format: "html",
        visibility: "internal",
      })
    );
    expect((r.draft as Row).visibility).toBe("internal");
    const draft = await draftRow(tid(103));
    expect(draft?.is_internal).toBe(true);
    expect(draft?.content).toContain("bold");
  });

  it("an identical repeat is unchanged: no row change, no second audit", async () => {
    const { client } = await writer();
    const first = expectOk(
      await call(client, "save_reply_draft", { ticket: 101, body: DRAFT_BODY })
    );
    const before = await draftRow(tid(101));

    const again = expectOk(
      await call(client, "save_reply_draft", { ticket: 101, body: DRAFT_BODY })
    );
    expect(again.unchanged).toBe(true);
    expect((again.draft as Row).updatedAt).toBe((first.draft as Row).updatedAt);
    expect(await draftRow(tid(101))).toEqual(before);
    expect(await auditRows(sql(), "mcp.save_reply_draft")).toHaveLength(1);
  });

  it("identical means same content AND visibility", async () => {
    const { client } = await writer();
    expectOk(
      await call(client, "save_reply_draft", { ticket: 101, body: DRAFT_BODY })
    );
    const before = await draftRow(tid(101));
    const r = await call(client, "save_reply_draft", {
      ticket: 101,
      body: DRAFT_BODY,
      visibility: "internal",
    });
    expectError(r, "draft_exists");
    expect(await draftRow(tid(101))).toEqual(before);
  });

  it("a different existing draft is draft_exists, and is left untouched", async () => {
    // Inserted as the UI composer's autosave would.
    await world.db.insert(schema.ticketReplyDrafts).values({
      ticketId: tid(101),
      userId: ALICE,
      content: doc("my own half-written reply"),
      isInternal: false,
      createdAt: new Date("2026-03-15T10:00:00.123Z"),
      updatedAt: new Date("2026-03-15T10:00:00.123Z"),
    });
    const before = await draftRow(tid(101));
    const { client } = await writer();
    const r = await call(client, "save_reply_draft", {
      ticket: 101,
      body: DRAFT_BODY,
    });
    const error = expectError(r, "draft_exists");
    expect(error.details).toEqual({
      currentUpdatedAt: "2026-03-15T10:00:00.123Z",
      ticketNumber: 101,
    });
    expect(error.message).toMatch(/not changed|was not changed/i);
    expect(await draftRow(tid(101))).toEqual(before);
    expect(await auditRows(sql(), "mcp.save_reply_draft")).toHaveLength(0);
  });

  it("is allowed on a closed ticket", async () => {
    const { client } = await writer();
    const r = expectOk(
      await call(client, "save_reply_draft", { ticket: 107, body: DRAFT_BODY })
    );
    expect(r.unchanged).toBe(false);
    expect(await draftRow(tid(107))).toBeDefined();
  });

  it("is merged on a merged ticket, naming the ticket to use", async () => {
    const { client } = await writer();
    const r = await call(client, "save_reply_draft", {
      ticket: 120,
      body: DRAFT_BODY,
    });
    const error = expectError(r, "merged");
    expect(error.details).toEqual({
      mergedIntoTicketNumber: 101,
      ticketNumber: 120,
    });
    expect(error.message).toContain("#101");
    expect(await draftRow(tid(120))).toBeUndefined();
    expect(await draftRow(tid(101))).toBeUndefined();
  });

  it("is not_found for an unknown ticket and invalid_input for a bad reference", async () => {
    const { client } = await writer();
    expectError(
      await call(client, "save_reply_draft", { ticket: 9999, body: "hi" }),
      "not_found"
    );
    expectError(
      await call(client, "save_reply_draft", { ticket: "t-101", body: "hi" }),
      "invalid_input"
    );
  });

  describe("empty drafts are rejected and never delete", () => {
    const empties: Array<[string, Record<string, unknown>]> = [
      ["blank text", { body: "   " }],
      ["empty html paragraph", { body: "<p></p>", format: "html" }],
      ["whitespace html", { body: "<p> </p>", format: "html" }],
    ];
    for (const [label, input] of empties) {
      it(`${label}: invalid_input, an existing draft survives`, async () => {
        await world.db.insert(schema.ticketReplyDrafts).values({
          ticketId: tid(101),
          userId: ALICE,
          content: doc("keep me"),
          isInternal: false,
        });
        const before = await draftRow(tid(101));
        const { client } = await writer();
        const r = await call(client, "save_reply_draft", {
          ticket: 101,
          ...input,
        });
        const error = expectError(r, "invalid_input");
        expect(error.details).toEqual({ field: "body" });
        expect(error.message).toMatch(/nothing was saved/i);
        expect(await draftRow(tid(101))).toEqual(before);
      });
    }

    it("creates no draft when there was none", async () => {
      const { client } = await writer();
      expectError(
        await call(client, "save_reply_draft", { ticket: 101, body: " \n " }),
        "invalid_input"
      );
      expect(await draftRow(tid(101))).toBeUndefined();
    });
  });

  it("MAX_DRAFT_LENGTH is shared with the draft route", () => {
    expect(MAX_DRAFT_LENGTH).toBe(200_000);
  });
});

describe("saveReplyDraft ifNoDifferentDraft (service)", () => {
  const input = (content: string, isInternal = false) => ({
    ticketId: tid(101),
    userId: ALICE,
    content,
    isInternal,
  });

  it("never loses a racing UI autosave", async () => {
    for (let i = 0; i < 25; i++) {
      await sql()`DELETE FROM ticket_reply_drafts WHERE ticket_id = ${tid(101)}`;
      const ui = doc(`ui autosave ${i}`);
      const [conditional] = await Promise.all([
        saveReplyDraft({ ...input(doc(`mcp ${i}`)), ifNoDifferentDraft: true }),
        // The UI route's upsert (no flag).
        saveReplyDraft(input(ui)),
      ]);
      // Whichever order they ran in, the agent's own text is what is left.
      expect(["saved", "conflict"]).toContain(conditional.status);
      expect((await getReplyDraft(tid(101), ALICE))?.content, `run ${i}`).toBe(
        ui
      );
    }
  });

  it("covers every outcome without touching an existing draft", async () => {
    const mine = doc("mine");
    const empty = await saveReplyDraft({
      ...input(
        JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] })
      ),
      ifNoDifferentDraft: true,
    });
    expect(empty).toEqual({ status: "rejected_empty" });

    const missing = await saveReplyDraft({
      ...input(mine),
      ticketId: "t-nope",
      ifNoDifferentDraft: true,
    });
    expect(missing).toEqual({ status: "not_found" });

    const saved = await saveReplyDraft({
      ...input(mine),
      ifNoDifferentDraft: true,
    });
    expect(saved.status).toBe("saved");
    const unchanged = await saveReplyDraft({
      ...input(mine),
      ifNoDifferentDraft: true,
    });
    expect(unchanged).toMatchObject({ status: "unchanged" });
    const conflict = await saveReplyDraft({
      ...input(doc("other")),
      ifNoDifferentDraft: true,
    });
    expect(conflict).toMatchObject({ status: "conflict" });
    expect((conflict as { updatedAt: Date }).updatedAt.getTime()).toBe(
      (saved as { updatedAt: Date }).updatedAt.getTime()
    );
    expect((await getReplyDraft(tid(101), ALICE))?.content).toBe(mine);

    // Empty never deletes in this mode either.
    await saveReplyDraft({
      ...input(JSON.stringify({ type: "doc", content: [] })),
      ifNoDifferentDraft: true,
    });
    expect((await getReplyDraft(tid(101), ALICE))?.content).toBe(mine);
  });

  it("leaves today's upsert path alone when the flag is off", async () => {
    await saveReplyDraft(input(doc("one")));
    await saveReplyDraft(input(doc("two"), true));
    expect(await getReplyDraft(tid(101), ALICE)).toMatchObject({
      content: doc("two"),
      isInternal: true,
    });
    expect(await saveReplyDraft(input(" "))).toEqual({ status: "cleared" });
    expect(await getReplyDraft(tid(101), ALICE)).toBeNull();
  });
});

/* -------------------------------------------------------- add_internal_note */

describe("add_internal_note", () => {
  it("adds an internal note as the token owner and records it on the ledger", async () => {
    const { client, tokenId } = await writer();
    const r = expectOk(
      await call(client, "add_internal_note", {
        ticket: 101,
        body: NOTE_BODY,
        clientRequestId: key("note1"),
      })
    );
    expect(r).toMatchObject({
      ticket: { number: 101, agentUrl: "http://localhost:3000/tickets/101" },
      visibility: "internal",
    });
    expect(r.replayed).toBeUndefined();
    expect(r.mergedFrom).toBeUndefined();

    const comments = await commentsOn(tid(101));
    const note = comments.find((c) => c.id === r.commentId);
    expect(note).toMatchObject({
      author_id: ALICE,
      author_name: USERS.alice.name,
      author_role: "agent",
      is_internal: true,
    });
    expect(String(note?.content)).toContain(NOTE_BODY);

    const act = await newActivity(tid(101), "internal_note_added");
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({
      actor_id: ALICE,
      actor_name: USERS.alice.name,
      actor_role: "agent",
      metadata: { via: "mcp", credentialId: tokenId },
    });

    const audits = await auditRows(sql(), "mcp.add_internal_note");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_id: ALICE,
      actor_email: USERS.alice.email,
      entity_type: "ticket",
      entity_id: tid(101),
    });
    expect(audits[0].description).toContain("#101");
    expect(audits[0].metadata).toEqual({
      via: "mcp",
      credentialId: tokenId,
      clientId: null,
      ticketNumber: 101,
      commentId: r.commentId,
    });

    // The ledger row is the one record of the call.
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: "add_internal_note",
      client_request_id: key("note1"),
      target_ticket_id: tid(101),
      status: "succeeded",
      planned_entity_id: r.commentId,
      lock_group: null,
      user_id: ALICE,
      credential_id: tokenId,
      side_effects_uncertain: false,
    });
    expect(JSON.stringify(rows[0].result_json)).not.toContain(NOTE_BODY);
    expect(rows[0].result_json).toEqual({ commentId: r.commentId });
  });

  it("requires a clientRequestId and a visible body", async () => {
    const { client } = await writer();
    const noKey = await callTool(client, "add_internal_note", {
      ticket: 101,
      body: NOTE_BODY,
    });
    expect(wasRejected(noKey)).toBe(true);
    expect(noKey.errorCode).toBeNull();

    const empty = await call(client, "add_internal_note", {
      ticket: 101,
      body: "   ",
      clientRequestId: key("empty"),
    });
    const error = expectError(empty, "invalid_input");
    expect(error.details).toEqual({ field: "body" });
    // Pre-claim failure: one trace row, no ledger row for the key.
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "failed",
      error_code: "invalid_input",
      client_request_id: null,
      target_ticket_id: tid(101),
    });
  });

  it("replays a repeat of the same key: one note, one activity, one audit", async () => {
    const { client } = await writer();
    const args = {
      ticket: 101,
      body: NOTE_BODY,
      clientRequestId: key("replay"),
    };
    const first = expectOk(await call(client, "add_internal_note", args));
    const second = expectOk(await call(client, "add_internal_note", args));
    expect(second.replayed).toBe(true);
    expect(second.commentId).toBe(first.commentId);
    expect(second.createdAt).toBe(first.createdAt);

    expect(
      (await commentsOn(tid(101))).filter(
        (c) =>
          c.is_internal &&
          c.author_id === ALICE &&
          String(c.content).includes(NOTE_BODY)
      )
    ).toHaveLength(1);
    expect(await newActivity(tid(101), "internal_note_added")).toHaveLength(1);
    expect(await auditRows(sql(), "mcp.add_internal_note")).toHaveLength(1);

    // One ledger row plus one trace row for the replay.
    const rows = await ledger();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      client_request_id: key("replay"),
      status: "succeeded",
    });
    expect(rows[1]).toMatchObject({
      client_request_id: null,
      status: "succeeded",
      tool: "add_internal_note",
    });
  });

  it("the same key with different arguments is idempotency_key_reused", async () => {
    const { client } = await writer();
    const base = { ticket: 101, clientRequestId: key("reuse") };
    expectOk(
      await call(client, "add_internal_note", { ...base, body: NOTE_BODY })
    );
    const r = await call(client, "add_internal_note", {
      ...base,
      body: `${NOTE_BODY} changed`,
    });
    expectError(r, "idempotency_key_reused");
    expect(await newActivity(tid(101), "internal_note_added")).toHaveLength(1);
    // Ledger row + the handler's trace row for the refusal.
    expect(await ledger()).toHaveLength(2);
  });

  it("two different keys create TWO notes (no per-ticket lock)", async () => {
    const { client } = await writer();
    const args = { ticket: 101, body: NOTE_BODY };
    const a = expectOk(
      await call(client, "add_internal_note", {
        ...args,
        clientRequestId: key("two-a"),
      })
    );
    const b = expectOk(
      await call(client, "add_internal_note", {
        ...args,
        clientRequestId: key("two-b"),
      })
    );
    expect(a.commentId).not.toBe(b.commentId);
    expect(await newActivity(tid(101), "internal_note_added")).toHaveLength(2);
    expect(await auditRows(sql(), "mcp.add_internal_note")).toHaveLength(2);
    const rows = await ledger();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.lock_group === null)).toBe(true);
  });

  it("recovers an expired pending call without a duplicate (sideEffectsUncertain)", async () => {
    const { client, tokenId } = await writer();
    const args = {
      ticket: 101,
      body: NOTE_BODY,
      format: "text",
      clientRequestId: key("crash"),
    };
    // The crash: the comment was written under the planned id, the ledger row
    // was never finalized and its lease ran out.
    const planned = "plannedcommentid0000001";
    await world.db.insert(schema.mcpToolCalls).values({
      id: "ledger-crash",
      requestId: "req-old",
      userId: ALICE,
      authMethod: "pat",
      credentialId: tokenId,
      tool: "add_internal_note",
      clientRequestId: args.clientRequestId,
      status: "pending",
      argsHmac: hmacToolArgs(args),
      plannedEntityId: planned,
      targetTicketId: tid(101),
      leaseExpiresAt: new Date(Date.now() - 5000),
      attempts: 1,
    });
    await world.db.insert(schema.ticketComments).values({
      id: planned,
      ticketId: tid(101),
      authorId: ALICE,
      authorName: USERS.alice.name,
      authorRole: "agent",
      content: doc(NOTE_BODY),
      isInternal: true,
    });

    const r = expectOk(await call(client, "add_internal_note", args));
    expect(r.commentId).toBe(planned);
    expect(r.sideEffectsUncertain).toBe(true);
    expect(r.replayed).toBeUndefined();

    const notes = (await commentsOn(tid(101))).filter((c) =>
      String(c.content).includes(NOTE_BODY)
    );
    expect(notes).toHaveLength(1);
    // Nothing re-ran: no activity, no audit.
    expect(await newActivity(tid(101), "internal_note_added")).toHaveLength(0);
    expect(await auditRows(sql(), "mcp.add_internal_note")).toHaveLength(0);

    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "ledger-crash",
      status: "succeeded",
      side_effects_uncertain: true,
      attempts: 2,
    });
  });

  it("re-executes an expired pending call whose comment was never written", async () => {
    const { client, tokenId } = await writer();
    const args = {
      ticket: 101,
      body: NOTE_BODY,
      format: "text",
      clientRequestId: key("redo"),
    };
    const planned = "plannedcommentid0000002";
    await world.db.insert(schema.mcpToolCalls).values({
      id: "ledger-redo",
      requestId: "req-old",
      userId: ALICE,
      authMethod: "pat",
      credentialId: tokenId,
      tool: "add_internal_note",
      clientRequestId: args.clientRequestId,
      status: "pending",
      argsHmac: hmacToolArgs(args),
      plannedEntityId: planned,
      targetTicketId: tid(101),
      leaseExpiresAt: new Date(Date.now() - 5000),
      attempts: 1,
    });
    const r = expectOk(await call(client, "add_internal_note", args));
    // The same planned id is reused, so a stray earlier attempt could never
    // have produced a second note.
    expect(r.commentId).toBe(planned);
    expect(r.sideEffectsUncertain).toBeUndefined();
    expect(await newActivity(tid(101), "internal_note_added")).toHaveLength(1);
    expect(await ledger()).toHaveLength(1);
  });

  it("answers in_progress while another attempt holds the key, keeping a trace row", async () => {
    const { client, tokenId } = await writer();
    const args = {
      ticket: 101,
      body: NOTE_BODY,
      format: "text",
      clientRequestId: key("busy"),
    };
    await world.db.insert(schema.mcpToolCalls).values({
      id: "ledger-busy",
      requestId: "req-other",
      userId: ALICE,
      authMethod: "pat",
      credentialId: tokenId,
      tool: "add_internal_note",
      clientRequestId: args.clientRequestId,
      status: "pending",
      argsHmac: hmacToolArgs(args),
      plannedEntityId: "plannedcommentid0000003",
      targetTicketId: tid(101),
      leaseExpiresAt: new Date(Date.now() + 60_000),
      attempts: 1,
    });
    const r = await call(client, "add_internal_note", args);
    const error = expectError(r, "in_progress");
    expect(typeof (error.details as Row).retryAfterSeconds).toBe("number");
    expect(await newActivity(tid(101), "internal_note_added")).toHaveLength(0);
    const rows = await ledger();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      status: "failed",
      error_code: "in_progress",
      client_request_id: null,
    });
  });

  it("a closed ticket is ticket_closed; the failure is stored and replayed", async () => {
    const { client } = await writer();
    const args = {
      ticket: 107,
      body: NOTE_BODY,
      clientRequestId: key("closed"),
    };
    const first = await call(client, "add_internal_note", args);
    const error = expectError(first, "ticket_closed");
    expect(error.details).toEqual({
      ticketNumber: 107,
      currentStatus: "closed",
    });
    expect(await commentsOn(tid(107))).toEqual([]);

    // One ledger row (failed, with the stored error).
    let rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "failed",
      error_code: "ticket_closed",
    });

    const again = await call(client, "add_internal_note", args);
    expectError(again, "ticket_closed");
    rows = await ledger();
    expect(rows).toHaveLength(2);
    expect(rows[1].client_request_id).toBeNull();
    expect(await auditRows(sql(), "mcp.add_internal_note")).toHaveLength(0);
  });

  it("forwards a merged ticket to its target and reports mergedFrom", async () => {
    const { client } = await writer();
    const r = expectOk(
      await call(client, "add_internal_note", {
        ticket: 120,
        body: NOTE_BODY,
        clientRequestId: key("merged"),
      })
    );
    expect(r.ticket).toMatchObject({ number: 101 });
    expect(r.mergedFrom).toEqual({ requested: "#120" });
    const note = (await commentsOn(tid(101))).find((c) => c.id === r.commentId);
    expect(note).toBeDefined();
    expect(await commentsOn(tid(120))).toEqual([]);
  });

  it("is not_found for an unknown ticket, with one trace row", async () => {
    const { client } = await writer();
    expectError(
      await call(client, "add_internal_note", {
        ticket: 9999,
        body: NOTE_BODY,
        clientRequestId: key("ghost"),
      }),
      "not_found"
    );
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "failed",
      error_code: "not_found",
      client_request_id: null,
      target_ticket_id: null,
    });
  });

  it("an unexpected failure is internal, retryable with the same key", async () => {
    const { client } = await writer();
    const args = { ticket: 101, body: NOTE_BODY, clientRequestId: key("boom") };
    hooks.failLimits = true;
    const failed = await call(client, "add_internal_note", args);
    const error = expectError(failed, "internal");
    expect(error.message).toMatch(/^Internal error \(ref: /);
    expect(failed.text).not.toContain("hunter2");
    let rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", error_code: "internal" });

    hooks.failLimits = false;
    const retry = expectOk(await call(client, "add_internal_note", args));
    expect(retry.replayed).toBeUndefined();
    rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(await newActivity(tid(101), "internal_note_added")).toHaveLength(1);
  });

  it("is hidden from the thread without the opt-in, visible with both gates, and never reaches the portal", async () => {
    const { client } = await writer();
    const note = expectOk(
      await call(client, "add_internal_note", {
        ticket: 101,
        body: NOTE_BODY,
        clientRequestId: key("vis"),
      })
    );

    const plain = await callTool(client, "get_ticket_thread", { ticket: 101 });
    expect(plain.text).not.toContain(NOTE_BODY);
    expect(plain.text).not.toContain(String(note.commentId));

    const reader = await writer(ALICE, [
      ...WRITE_SCOPES,
      "tickets:read_internal",
    ]);
    const shown = await callTool(reader.client, "get_ticket_thread", {
      ticket: 101,
      includeInternal: true,
      limit: 100,
    });
    expect(shown.text).toContain(NOTE_BODY);

    // The customer portal lists a ticket's comments with this filter
    // (app/(customer)/ticket/[ticketId]/page.tsx).
    const portal = await db
      .select({ id: schema.ticketComments.id })
      .from(schema.ticketComments)
      .where(
        and(
          eq(schema.ticketComments.ticketId, tid(101)),
          eq(schema.ticketComments.isInternal, false)
        )
      );
    expect(portal.map((c) => c.id)).not.toContain(note.commentId);
  });

  it("matches the UI route's internal note, except actor metadata, and keeps the reply draft", async () => {
    for (const id of [tid(104), tid(112)]) {
      await world.db.insert(schema.ticketReplyDrafts).values({
        ticketId: id,
        userId: ALICE,
        content: doc("alice half-written reply"),
        isInternal: false,
      });
    }
    // UI: an internal note on #104.
    const ui = await captureEffects({
      ticketIds: [tid(104)],
      invoke: () =>
        POST_COMMENT(
          commentRequest(tid(104), {
            content: doc("same text"),
            isInternal: "true",
          }),
          ctx(tid(104))
        ),
    });
    // MCP: the same note on #112 (same state: open, not awaiting).
    const { client, tokenId } = await writer();
    const mcp = await captureEffects({
      ticketIds: [tid(112)],
      invoke: async () => {
        const r = await call(client, "add_internal_note", {
          ticket: 112,
          body: "same text",
          clientRequestId: key("parity"),
        });
        return Response.json(r.data);
      },
    });

    expect(ui.effects.response.status).toBe(201);
    const pick = (c: Row) => ({
      authorId: c.authorId,
      authorName: c.authorName,
      authorRole: c.authorRole,
      isInternal: c.isInternal,
      content: c.content,
    });
    expect(mcp.effects.comments).toHaveLength(1);
    expect(pick(mcp.effects.comments[0])).toEqual(pick(ui.effects.comments[0]));

    expect(actions(mcp.effects)).toEqual(actions(ui.effects));
    expect(actions(mcp.effects)).toEqual(["internal_note_added"]);
    expect(ui.effects.activity[0].metadata ?? null).toBeNull();
    expect(mcp.effects.activity[0].metadata).toEqual({
      via: "mcp",
      credentialId: tokenId,
    });
    for (const field of ["actorId", "actorName", "actorRole"]) {
      expect(mcp.effects.activity[0][field]).toBe(
        ui.effects.activity[0][field]
      );
    }

    // Flags and timestamps: only updatedAt moves, on both.
    const changed = (e: typeof ui.effects) =>
      Object.values(e.ticketDiff).flatMap((c) => Object.keys(c));
    expect(changed(mcp.effects)).toEqual(["updatedAt"]);
    expect(changed(ui.effects)).toEqual(["updatedAt"]);

    // No webhook, no email, no notification, same realtime push.
    for (const e of [ui.effects, mcp.effects]) {
      expect(events(e)).toEqual([]);
      expect(e.emails).toEqual([]);
      expect(e.notifications).toEqual([]);
      expect(e.calls.filter((c) => c.call === "enqueueJob")).toEqual([]);
      expect(
        e.calls.filter((c) => c.call === "realtime.publishTicketCommentCreated")
      ).toHaveLength(1);
    }
    expect(await outboxCount()).toBe(0);

    // The UI route drops the caller's draft (unchanged); MCP keeps it.
    expect(await draftRow(tid(104))).toBeUndefined();
    expect((await draftRow(tid(112)))?.content).toContain("alice half-written");
  });
});

/* --------------------------------------------------------- update_ticket_tags */

describe("update_ticket_tags", () => {
  it("adds and removes tags, writing the same activity as the tag routes", async () => {
    const { client, tokenId } = await writer();
    const r = expectOk(
      await call(client, "update_ticket_tags", {
        ticket: 102,
        add: ["  Refund  Pending ", "vip"],
        remove: ["billing"],
      })
    );
    expect(r.ticket).toEqual({
      number: 102,
      agentUrl: "http://localhost:3000/tickets/102",
    });
    expect(r.added).toEqual(["refund pending", "vip"]);
    expect(r.removed).toEqual(["billing"]);
    expect(r.tags).toEqual(["refund pending", "vip"]);

    const added = await newActivity(tid(102), "tag_added");
    expect(added.map((a) => (a.metadata as Row).tag).sort()).toEqual([
      "refund pending",
      "vip",
    ]);
    const removed = await newActivity(tid(102), "tag_removed");
    expect(removed.map((a) => (a.metadata as Row).tag)).toEqual(["billing"]);
    for (const row of [...added, ...removed]) {
      expect(row).toMatchObject({
        actor_id: ALICE,
        actor_name: USERS.alice.name,
        actor_role: "agent",
      });
      expect((row.metadata as Row).via).toBe("mcp");
      expect((row.metadata as Row).credentialId).toBe(tokenId);
    }

    const audits = await auditRows(sql(), "mcp.update_ticket_tags");
    expect(audits).toHaveLength(1);
    expect(audits[0].entity_id).toBe(tid(102));
    expect(audits[0].metadata).toMatchObject({
      via: "mcp",
      credentialId: tokenId,
    });
    expect((audits[0].metadata as Row).addedTagIds).toHaveLength(2);
    expect((audits[0].metadata as Row).removedTagIds).toEqual(["tag-billing"]);
    // The pool tag "billing" itself stays.
    const [{ n }] =
      await sql()`SELECT count(*)::int AS n FROM tags WHERE name = 'billing'`;
    expect(n).toBe(1);
  });

  it("is a no-op for already-linked adds and unlinked removes: no activity, no audit", async () => {
    const { client } = await writer();
    const r = expectOk(
      await call(client, "update_ticket_tags", {
        ticket: 102,
        add: ["billing"],
        remove: ["vip", "never-existed"],
      })
    );
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.tags).toEqual(["billing"]);
    expect(
      (await activityRows(tid(102))).filter((a) => a.action === "tag_added")
    ).toEqual([]);
    expect(await auditRows(sql(), "mcp.update_ticket_tags")).toHaveLength(0);
    // A tag that does not exist is not created by a remove.
    const [{ n }] =
      await sql()`SELECT count(*)::int AS n FROM tags WHERE name = 'never-existed'`;
    expect(n).toBe(0);
  });

  it("matches the tag route's rows for an add", async () => {
    const ui = await captureEffects({
      ticketIds: [tid(104)],
      invoke: () =>
        POST_TAG(
          jsonRequest(`/api/tickets/${tid(104)}/tags`, "POST", {
            name: "Fresh",
          }),
          ctx(tid(104))
        ),
    });
    const { client } = await writer();
    const mcp = await captureEffects({
      ticketIds: [tid(112)],
      invoke: async () => {
        const r = await call(client, "update_ticket_tags", {
          ticket: 112,
          add: ["Fresh"],
        });
        return Response.json(r.data);
      },
    });
    expect(ui.effects.response.status).toBeLessThan(300);
    expect(actions(mcp.effects)).toEqual(actions(ui.effects));
    expect(actions(mcp.effects)).toEqual(["tag_added"]);
    expect(mcp.effects.ticketTags.map((t) => t.name)).toEqual(
      ui.effects.ticketTags.map((t) => t.name)
    );
    expect(events(mcp.effects)).toEqual(events(ui.effects));
  });

  it("validates input: at least one list, bounds, overlap, duplicates", async () => {
    const { client } = await writer();
    expectError(
      await call(client, "update_ticket_tags", { ticket: 102 }),
      "invalid_input"
    );
    expectError(
      await call(client, "update_ticket_tags", {
        ticket: 102,
        add: [],
        remove: [],
      }),
      "invalid_input"
    );
    const empty = expectError(
      await call(client, "update_ticket_tags", { ticket: 102, add: ["   "] }),
      "invalid_input"
    );
    expect(empty.details).toEqual({ field: "add" });
    const long = expectError(
      await call(client, "update_ticket_tags", {
        ticket: 102,
        remove: ["x".repeat(51)],
      }),
      "invalid_input"
    );
    expect(long.details).toEqual({ field: "remove" });
    const overlap = expectError(
      await call(client, "update_ticket_tags", {
        ticket: 102,
        add: ["Vip"],
        remove: ["  vip "],
      }),
      "invalid_input"
    );
    expect(overlap.message).toMatch(/both/);
    // Duplicates collapse into one add.
    const dup = expectOk(
      await call(client, "update_ticket_tags", {
        ticket: 102,
        add: ["Twice", "twice", " TWICE"],
      })
    );
    expect(dup.added).toEqual(["twice"]);
    expect(await newActivity(tid(102), "tag_added")).toHaveLength(1);
  });

  it("forwards a merged ticket and reports mergedFrom", async () => {
    const { client } = await writer();
    const r = expectOk(
      await call(client, "update_ticket_tags", { ticket: 121, add: ["fwd"] })
    );
    expect(r.ticket).toMatchObject({ number: 105 });
    expect(r.mergedFrom).toEqual({ requested: "#121" });
    expect(r.tags).toEqual(["fwd"]);
  });

  it("replays an optional key without repeating anything", async () => {
    const { client } = await writer();
    const args = {
      ticket: 102,
      add: ["replayed"],
      clientRequestId: key("tags"),
    };
    const first = expectOk(await call(client, "update_ticket_tags", args));
    expect(first.added).toEqual(["replayed"]);
    const second = expectOk(await call(client, "update_ticket_tags", args));
    expect(second.replayed).toBe(true);
    // Rendered from the stored ids, identically.
    expect(second.added).toEqual(["replayed"]);
    expect(second.tags).toEqual(first.tags);
    expect(await newActivity(tid(102), "tag_added")).toHaveLength(1);
    expect(await auditRows(sql(), "mcp.update_ticket_tags")).toHaveLength(1);
    const rows = await ledger();
    expect(rows).toHaveLength(2);
    expect(rows[0].client_request_id).toBe(key("tags"));
    expect(rows[1].client_request_id).toBeNull();
    // Stored: ids only.
    expect(JSON.stringify(rows[0].result_json)).not.toContain('replayed"');
  });

  it("a repeat without a key is a no-op", async () => {
    const { client } = await writer();
    const args = { ticket: 102, add: ["again"] };
    expectOk(await call(client, "update_ticket_tags", args));
    const second = expectOk(await call(client, "update_ticket_tags", args));
    expect(second.added).toEqual([]);
    expect(second.tags).toContain("again");
    expect(await newActivity(tid(102), "tag_added")).toHaveLength(1);
    expect(await auditRows(sql(), "mcp.update_ticket_tags")).toHaveLength(1);
  });
});

/* ------------------------------------------------------ update_ticket_fields */

describe("update_ticket_fields", () => {
  it("changes priority and category like the PATCH route, with MCP attribution", async () => {
    // UI PATCH on #104, MCP on #112: same new values, both open and quiet.
    const patch = { category: "bug", priority: "high" };
    const ui = await captureEffects({
      ticketIds: [tid(104)],
      invoke: () =>
        PATCH(
          jsonRequest(`/api/tickets/${tid(104)}`, "PATCH", patch),
          ctx(tid(104))
        ),
    });
    const { client, tokenId } = await writer();
    const mcp = await captureEffects({
      ticketIds: [tid(112)],
      invoke: async () => {
        const r = await call(client, "update_ticket_fields", {
          ticket: 112,
          ...patch,
        });
        return Response.json(r.data);
      },
    });
    expect(ui.effects.response.status).toBe(200);
    expect(mcp.effects.response.status).toBe(200);

    expect(actions(mcp.effects)).toEqual(actions(ui.effects));
    expect(actions(mcp.effects)).toEqual([
      "category_changed",
      "priority_changed",
    ]);
    expect(events(mcp.effects)).toEqual(events(ui.effects));
    expect(events(mcp.effects)).toEqual([
      "ticket.category_changed",
      "ticket.priority_changed",
    ]);
    const changedColumns = (e: typeof ui.effects) =>
      Object.values(e.ticketDiff)
        .flatMap((c) => Object.keys(c))
        .sort();
    expect(changedColumns(mcp.effects)).toEqual(changedColumns(ui.effects));
    expect(mcp.effects.deliveries.map((d) => d.status)).toEqual(
      ui.effects.deliveries.map((d) => d.status)
    );
    expect(
      mcp.effects.deliveries.map((d) => Object.keys(d.payload as Row).sort())
    ).toEqual(
      ui.effects.deliveries.map((d) => Object.keys(d.payload as Row).sort())
    );

    for (const row of mcp.effects.activity) {
      expect(row).toMatchObject({
        actorId: ALICE,
        actorName: USERS.alice.name,
        actorRole: "agent",
      });
      expect((row.metadata as Row).via).toBe("mcp");
      expect((row.metadata as Row).credentialId).toBe(tokenId);
      expect(Object.keys(row.metadata as Row).sort()).toEqual([
        "credentialId",
        "from",
        "to",
        "via",
      ]);
    }
    // The UI rows carry no extra metadata keys.
    for (const row of ui.effects.activity) {
      expect(Object.keys(row.metadata as Row).sort()).toEqual(["from", "to"]);
    }

    const audits = await auditRows(sql(), "mcp.update_ticket_fields");
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({
      via: "mcp",
      credentialId: tokenId,
      changed: ["category", "priority"],
    });
  });

  it("returns the ticket's new state", async () => {
    const { client } = await writer();
    const r = expectOk(
      await call(client, "update_ticket_fields", {
        ticket: 104,
        priority: "urgent",
      })
    );
    expect(r.changed).toEqual(["priority"]);
    const row = await ticketRow(tid(104));
    expect(r.ticket).toEqual({
      id: tid(104),
      number: 104,
      agentUrl: "http://localhost:3000/tickets/104",
      priority: { slug: "urgent", label: "Urgent" },
      category: { slug: "billing", label: "Billing" },
      updatedAt: isoOf(row.updatedMs),
    });
    expect(r.notificationErrors).toBeUndefined();
    expect(await deliveries()).toEqual(["ticket.priority_changed"]);
  });

  it("an unchanged value is a no-op: no activity, webhook or audit", async () => {
    const { client } = await writer();
    const before = await ticketRow(tid(104));
    const r = expectOk(
      await call(client, "update_ticket_fields", {
        ticket: 104,
        priority: "low",
        category: "billing",
      })
    );
    expect(r.changed).toEqual([]);
    expect(await ticketRow(tid(104))).toEqual(before);
    expect(await newActivity(tid(104), "priority_changed")).toEqual([]);
    expect(await deliveries()).toEqual([]);
    expect(await auditRows(sql(), "mcp.update_ticket_fields")).toHaveLength(0);
  });

  it("rejects an unknown slug before writing anything", async () => {
    const { client } = await writer();
    const before = await ticketRow(tid(104));
    const r = await call(client, "update_ticket_fields", {
      ticket: 104,
      category: "bug",
      priority: "nonsense",
    });
    const error = expectError(r, "invalid_input");
    expect(error.details).toMatchObject({ field: "priority" });
    expect(error.details?.allowed).toEqual(["low", "normal", "high", "urgent"]);
    expect(await ticketRow(tid(104))).toEqual(before);
    expect(await deliveries()).toEqual([]);

    const cat = await call(client, "update_ticket_fields", {
      ticket: 104,
      category: "nope",
    });
    expect(expectError(cat, "invalid_input").details).toMatchObject({
      field: "category",
    });
  });

  it("needs at least one field", async () => {
    const { client } = await writer();
    expectError(
      await call(client, "update_ticket_fields", { ticket: 104 }),
      "invalid_input"
    );
    // A malformed expectedUpdatedAt never reaches the handler: the SDK's own
    // schema check answers with its plain-text tool error.
    const bad = await callTool(client, "update_ticket_fields", {
      ticket: 104,
      priority: "high",
      expectedUpdatedAt: "2026-13-45T00:00:00Z",
    });
    expect(bad.isError).toBe(true);
    expect(bad.errorCode).toBeNull();
    expect(bad.text).toMatch(/^Input validation error/);
  });

  it("is merged for a merged ticket, naming the ticket to use", async () => {
    const { client } = await writer();
    const r = await call(client, "update_ticket_fields", {
      ticket: 121,
      priority: "high",
    });
    const error = expectError(r, "merged");
    expect(error.details).toEqual({
      mergedIntoTicketNumber: 105,
      ticketNumber: 121,
    });
    expect((await ticketRow(tid(121))).priority).toBe("normal");
    expect(await deliveries()).toEqual([]);
  });

  describe("expectedUpdatedAt", () => {
    it("a stale value is conflict and writes nothing", async () => {
      const { client } = await writer();
      const before = await ticketRow(tid(104));
      const r = await call(client, "update_ticket_fields", {
        ticket: 104,
        priority: "high",
        category: "bug",
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      });
      const error = expectError(r, "conflict");
      expect(error.details).toEqual({
        currentUpdatedAt: isoOf(before.updatedMs),
        ticketNumber: 104,
      });
      expect(await ticketRow(tid(104))).toEqual(before);
      expect(await newActivity(tid(104), "priority_changed")).toEqual([]);
      expect(await newActivity(tid(104), "category_changed")).toEqual([]);
      expect(await deliveries()).toEqual([]);
      expect(await auditRows(sql(), "mcp.update_ticket_fields")).toHaveLength(
        0
      );
    });

    it("a matching value applies", async () => {
      const { client } = await writer();
      const before = await ticketRow(tid(104));
      const r = expectOk(
        await call(client, "update_ticket_fields", {
          ticket: 104,
          priority: "high",
          category: "bug",
          expectedUpdatedAt: isoOf(before.updatedMs),
        })
      );
      expect(r.changed).toEqual(["priority", "category"]);
      const after = await ticketRow(tid(104));
      expect(after).toMatchObject({ priority: "high", category: "bug" });
      expect(after.updatedMs).toBeGreaterThan(before.updatedMs);
      expect(await deliveries()).toEqual([
        "ticket.category_changed",
        "ticket.priority_changed",
      ]);
    });

    it("a ticket whose updated_at has microseconds matches its millisecond value", async () => {
      await sql()`UPDATE tickets SET updated_at = '2026-03-15 09:00:00.123456+00' WHERE id = ${tid(104)}`;
      const { client } = await writer();
      // One millisecond off is stale ...
      expectError(
        await call(client, "update_ticket_fields", {
          ticket: 104,
          priority: "high",
          expectedUpdatedAt: "2026-03-15T09:00:00.124Z",
        }),
        "conflict"
      );
      // ... the truncated value matches.
      const r = expectOk(
        await call(client, "update_ticket_fields", {
          ticket: 104,
          priority: "high",
          expectedUpdatedAt: "2026-03-15T09:00:00.123Z",
        })
      );
      expect(r.changed).toEqual(["priority"]);
      expect((await ticketRow(tid(104))).priority).toBe("high");
    });

    it("accepts an offset timestamp", async () => {
      await sql()`UPDATE tickets SET updated_at = '2026-03-15 09:00:00.5+00' WHERE id = ${tid(104)}`;
      const { client } = await writer();
      const r = expectOk(
        await call(client, "update_ticket_fields", {
          ticket: 104,
          priority: "high",
          expectedUpdatedAt: "2026-03-15T11:00:00.500+02:00",
        })
      );
      expect(r.changed).toEqual(["priority"]);
    });

    it("two fields: a change between them applies the first and conflicts the second", async () => {
      const { client, tokenId } = await writer();
      const before = await ticketRow(tid(104));
      // A concurrent edit lands right after the category update is done.
      let bumpedMs = 0;
      hooks.afterWebhook = async () => {
        await sql()`UPDATE tickets SET updated_at = updated_at + interval '5 seconds' WHERE id = ${tid(104)}`;
        bumpedMs = (await ticketRow(tid(104))).updatedMs;
      };
      const r = await call(client, "update_ticket_fields", {
        ticket: 104,
        category: "bug",
        priority: "high",
        expectedUpdatedAt: isoOf(before.updatedMs),
      });
      const error = expectError(r, "conflict");
      expect(error.details).toEqual({
        currentUpdatedAt: isoOf(bumpedMs),
        ticketNumber: 104,
        field: "priority",
      });
      expect(error.message).toMatch(/Applied: category/);
      expect(error.message).toMatch(/Not applied: priority/);

      expect(await ticketRow(tid(104))).toMatchObject({
        category: "bug",
        priority: "low",
      });
      expect(await newActivity(tid(104), "category_changed")).toHaveLength(1);
      expect(await newActivity(tid(104), "priority_changed")).toEqual([]);
      expect(await deliveries()).toEqual(["ticket.category_changed"]);
      // What was applied is audited, flagged partial.
      const audits = await auditRows(sql(), "mcp.update_ticket_fields");
      expect(audits).toHaveLength(1);
      expect(audits[0].metadata).toMatchObject({
        via: "mcp",
        credentialId: tokenId,
        changed: ["category"],
        partial: true,
      });
      // The refusal is stored on the ledger row.
      const rows = await ledger();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "failed",
        error_code: "conflict",
      });
    });

    it("without expectedUpdatedAt the fields apply one after the other", async () => {
      const { client } = await writer();
      let bumped = false;
      hooks.afterWebhook = async () => {
        bumped = true;
        await sql()`UPDATE tickets SET updated_at = updated_at + interval '5 seconds' WHERE id = ${tid(104)}`;
      };
      const r = expectOk(
        await call(client, "update_ticket_fields", {
          ticket: 104,
          category: "bug",
          priority: "high",
        })
      );
      expect(bumped).toBe(true);
      expect(r.changed).toEqual(["priority", "category"]);
      expect(await ticketRow(tid(104))).toMatchObject({
        category: "bug",
        priority: "high",
      });
    });
  });

  it("reports a failed webhook as notificationErrors, not as a failure", async () => {
    const { client } = await writer();
    hooks.failWebhook = true;
    const r = expectOk(
      await call(client, "update_ticket_fields", {
        ticket: 104,
        priority: "high",
        clientRequestId: key("hookfail"),
      })
    );
    expect(r.changed).toEqual(["priority"]);
    expect(r.notificationErrors).toEqual(["webhook_dispatch_failed"]);
    expect(r.sideEffectsUncertain).toBeUndefined();
    expect((await ticketRow(tid(104))).priority).toBe("high");
    const rows = await ledger();
    expect(rows[0]).toMatchObject({
      status: "succeeded",
      notification_errors: ["webhook_dispatch_failed"],
    });
    // A replay carries the same note.
    hooks.failWebhook = false;
    const again = expectOk(
      await call(client, "update_ticket_fields", {
        ticket: 104,
        priority: "high",
        clientRequestId: key("hookfail"),
      })
    );
    expect(again.replayed).toBe(true);
    expect(again.notificationErrors).toEqual(["webhook_dispatch_failed"]);
  });

  it("replays an optional key without a second change, webhook or audit", async () => {
    const { client } = await writer();
    const args = {
      ticket: 104,
      priority: "high",
      clientRequestId: key("fields"),
    };
    const first = expectOk(await call(client, "update_ticket_fields", args));
    const second = expectOk(await call(client, "update_ticket_fields", args));
    expect(second.replayed).toBe(true);
    expect(second.changed).toEqual(first.changed);
    expect(await newActivity(tid(104), "priority_changed")).toHaveLength(1);
    expect(await deliveries()).toEqual(["ticket.priority_changed"]);
    expect(await auditRows(sql(), "mcp.update_ticket_fields")).toHaveLength(1);
    expect(await ledger()).toHaveLength(2);
  });
});

describe("conditional field services (CAS chain)", () => {
  const actor = {
    id: ALICE,
    name: USERS.alice.name,
    role: "agent" as const,
  };

  async function snapshot() {
    const loaded = await loadTicketForChange(tid(104));
    if (loaded.status !== "ok") {
      throw new Error("ticket not loaded");
    }
    return loaded;
  }

  it("the second field passes the first one's exact `now`", async () => {
    const snap = await snapshot();
    const expected = snap.ticket.updatedAt;
    const now = new Date(Date.now() + 1234);
    const first = await setTicketCategory({
      snapshot: snap,
      actor,
      value: "bug",
      now,
      expectedUpdatedAt: expected,
    });
    expect(first.status).toBe("changed");
    const second = await setTicketPriority({
      snapshot: snap,
      actor,
      value: "high",
      now,
      expectedUpdatedAt: now,
    });
    expect(second.status).toBe("changed");
  });

  it("a change between the two stops the second and writes nothing for it", async () => {
    const snap = await snapshot();
    const now = new Date(Date.now() + 1234);
    const first = await setTicketCategory({
      snapshot: snap,
      actor,
      value: "bug",
      now,
      expectedUpdatedAt: snap.ticket.updatedAt,
    });
    expect(first.status).toBe("changed");
    await sql()`UPDATE tickets SET updated_at = updated_at + interval '3 seconds' WHERE id = ${tid(104)}`;
    const before = await ticketRow(tid(104));
    const activityBefore = (await activityRows(tid(104))).length;
    const deliveriesBefore = (await deliveries()).length;

    const second = await setTicketPriority({
      snapshot: snap,
      actor,
      value: "high",
      now,
      expectedUpdatedAt: now,
    });
    expect(second).toEqual({ status: "conflict" });
    expect(await ticketRow(tid(104))).toEqual(before);
    expect(before.priority).toBe("low");
    expect((await activityRows(tid(104))).length).toBe(activityBefore);
    expect((await deliveries()).length).toBe(deliveriesBefore);
  });

  it("unchanged and invalid keep their results; omitting the version is unconditional", async () => {
    const snap = await snapshot();
    const now = new Date();
    expect(
      await setTicketPriority({ snapshot: snap, actor, value: "low", now })
    ).toEqual({ status: "unchanged" });
    expect(
      await setTicketPriority({
        snapshot: snap,
        actor,
        value: "bogus",
        now,
        expectedUpdatedAt: new Date(0),
      })
    ).toEqual({ status: "invalid" });
    const changed = await setTicketPriority({
      snapshot: snap,
      actor,
      value: "urgent",
      now,
    });
    expect(changed.status).toBe("changed");
    expect((await ticketRow(tid(104))).priority).toBe("urgent");
  });
});

/* ----------------------------------------------------- error text, records */

describe("every error is JSON text", () => {
  it("covers each error code the write tools can return", async () => {
    const { client, tokenId } = await writer();
    const seen = new Set<string>();
    const note = (r: ToolOutcome, code: string) => {
      expectError(r, code);
      seen.add(code);
    };

    note(
      await call(client, "save_reply_draft", { ticket: 9999, body: "x" }),
      "not_found"
    );
    note(
      await call(client, "save_reply_draft", { ticket: "bad", body: "x" }),
      "invalid_input"
    );
    note(
      await call(client, "save_reply_draft", { ticket: 120, body: "x" }),
      "merged"
    );
    note(
      await call(client, "update_ticket_fields", {
        ticket: 104,
        priority: "high",
        expectedUpdatedAt: "2020-01-01T00:00:00Z",
      }),
      "conflict"
    );
    note(
      await call(client, "add_internal_note", {
        ticket: 107,
        body: "x",
        clientRequestId: key("t-closed"),
      }),
      "ticket_closed"
    );
    await world.db.insert(schema.ticketReplyDrafts).values({
      ticketId: tid(103),
      userId: ALICE,
      content: doc("existing"),
      isInternal: false,
    });
    note(
      await call(client, "save_reply_draft", { ticket: 103, body: "other" }),
      "draft_exists"
    );
    const reuse = { ticket: 101, clientRequestId: key("t-reuse") };
    expectOk(await call(client, "add_internal_note", { ...reuse, body: "a" }));
    note(
      await call(client, "add_internal_note", { ...reuse, body: "b" }),
      "idempotency_key_reused"
    );
    const busy = {
      ticket: 101,
      body: "c",
      format: "text",
      clientRequestId: key("t-busy"),
    };
    await world.db.insert(schema.mcpToolCalls).values({
      requestId: "r",
      userId: ALICE,
      authMethod: "pat",
      credentialId: tokenId,
      tool: "add_internal_note",
      clientRequestId: busy.clientRequestId,
      status: "pending",
      argsHmac: hmacToolArgs(busy),
      plannedEntityId: "plannedcommentid0000009",
      targetTicketId: tid(101),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    note(await call(client, "add_internal_note", busy), "in_progress");
    hooks.failLimits = true;
    note(
      await call(client, "add_internal_note", {
        ticket: 101,
        body: "d",
        clientRequestId: key("t-internal"),
      }),
      "internal"
    );

    expect([...seen].sort()).toEqual(
      [
        "conflict",
        "draft_exists",
        "idempotency_key_reused",
        "in_progress",
        "internal",
        "invalid_input",
        "merged",
        "not_found",
        "ticket_closed",
      ].sort()
    );
  });
});

describe("one mcp_tool_calls row per call", () => {
  it("covers a fresh write, pre-claim failures, replays, in_progress and unknown tools", async () => {
    const { client } = await writer();
    const args = { ticket: 101, body: "row", clientRequestId: key("rows") };

    // fresh write: 1 ledger row
    expectOk(await call(client, "add_internal_note", args));
    expect(await ledger()).toHaveLength(1);
    // replay: +1 trace row
    expectOk(await call(client, "add_internal_note", args));
    expect(await ledger()).toHaveLength(2);
    // pre-claim failures: +1 each
    await call(client, "add_internal_note", {
      ...args,
      ticket: 9999,
      clientRequestId: key("rows-2"),
    });
    expect(await ledger()).toHaveLength(3);
    await call(client, "save_reply_draft", { ticket: 120, body: "x" });
    expect(await ledger()).toHaveLength(4);
    // key reuse: +1
    await call(client, "add_internal_note", { ...args, body: "different" });
    expect(await ledger()).toHaveLength(5);

    // keyless writes: one ledger row each, with the target recorded.
    expectOk(
      await call(client, "update_ticket_tags", { ticket: 102, add: ["r"] })
    );
    const rows = await ledger();
    expect(rows).toHaveLength(6);
    expect(rows[5]).toMatchObject({
      tool: "update_ticket_tags",
      client_request_id: null,
      target_ticket_id: tid(102),
      status: "succeeded",
      lock_group: null,
    });
    // Every row belongs to the token owner.
    expect(rows.every((r) => r.user_id === ALICE)).toBe(true);
  });
});

/* ---------------------------------------------------------- misc invariants */

describe("scope boundaries", () => {
  it("a role demotion removes the write tools immediately", async () => {
    const { client } = await writer();
    await sql()`UPDATE "user" SET role = 'user' WHERE id = ${ALICE}`;
    const r = await callTool(client, "update_ticket_tags", {
      ticket: 102,
      add: ["x"],
    });
    expect(wasRejected(r)).toBe(true);
    expect(await newActivity(tid(102), "tag_added")).toEqual([]);
  });
});
