import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/db/schema";
import type { Sql } from "./guard";

/**
 * Deterministic fixtures for the characterization tests.
 *
 * Everything is inserted with direct Drizzle writes (NOT through lib functions)
 * so that every id, ticket number and timestamp is explicit and fixed. The
 * default statuses/categories/priorities mirror lib/seed-defaults.ts field for
 * field except the ids (seedDefaults uses createId()); a test in
 * `db-target.test.ts` proves the mirror has not drifted.
 */

export type TestDb = ReturnType<typeof makeDb>;

export function makeDb(sql: Sql) {
  return drizzle(sql, { schema });
}

/** The instant JS time is frozen to (Date only) in the characterization tests. */
export const FIXED_NOW = new Date("2026-03-15T12:00:00.000Z");

const at = (iso: string) => new Date(iso);

/** A minimal Tiptap document (the stored description/reply format). */
export function doc(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

/* ------------------------------------------------------------------ users */

export const USERS = {
  alice: { id: "user-alice", name: "Alice Agent", email: "alice@example.test" },
  bob: { id: "user-bob", name: "Bob Admin", email: "bob@example.test" },
  carol: {
    id: "user-carol",
    name: "Carol Banned",
    email: "carol@example.test",
  },
  dave: { id: "user-dave", name: "Dave Plain", email: "dave@example.test" },
  erin: {
    id: "user-erin",
    name: "Erin BannedAdmin",
    email: "erin@example.test",
  },
} as const;

export async function seedUsers(db: TestDb) {
  const created = at("2026-01-01T00:00:00.000Z");
  const base = { emailVerified: true, createdAt: created, updatedAt: created };
  await db.insert(schema.user).values([
    { ...base, ...USERS.alice, role: "agent" },
    { ...base, ...USERS.bob, role: "admin" },
    // banned agent: must be excluded everywhere agents are listed
    {
      ...base,
      ...USERS.carol,
      role: "agent",
      banned: true,
      banReason: "test",
      banExpires: at("2020-01-01T00:00:00.000Z"),
    },
    // plain "user" role: excluded from /api/agents, NOT filtered by the
    // ticket-detail page's `agents` query (recorded as-is).
    { ...base, ...USERS.dave, role: "user" },
    { ...base, ...USERS.erin, role: "admin", banned: true },
  ]);
}

/* ------------------------------------------------- statuses / cats / prios */

const CFG_TS = at("2026-01-01T00:00:00.000Z");
const ts = { createdAt: CFG_TS, updatedAt: CFG_TS };

/** Same values as lib/seed-defaults.ts, with fixed ids and timestamps. */
export const DEFAULT_STATUSES = [
  {
    id: "status-open",
    slug: "open",
    label: "Open",
    color: "blue",
    sortOrder: 0,
    isDefault: true,
    isClosedState: false,
  },
  {
    id: "status-in-progress",
    slug: "in_progress",
    label: "In Progress",
    color: "amber",
    sortOrder: 1,
    isDefault: false,
    isClosedState: false,
  },
  {
    id: "status-closed",
    slug: "closed",
    label: "Closed",
    color: "slate",
    sortOrder: 2,
    isDefault: false,
    isClosedState: true,
  },
];
export const DEFAULT_CATEGORIES = [
  { id: "cat-bug", slug: "bug", label: "Bug", color: "red", sortOrder: 0 },
  {
    id: "cat-issue",
    slug: "issue",
    label: "Issue",
    color: "orange",
    sortOrder: 1,
  },
  {
    id: "cat-feature",
    slug: "feature_request",
    label: "Feature Request",
    color: "purple",
    sortOrder: 2,
  },
  {
    id: "cat-billing",
    slug: "billing",
    label: "Billing",
    color: "green",
    sortOrder: 3,
  },
  {
    id: "cat-general",
    slug: "general_query",
    label: "General Query",
    color: "slate",
    sortOrder: 4,
  },
];
export const DEFAULT_PRIORITIES = [
  {
    id: "prio-low",
    slug: "low",
    label: "Low",
    color: "slate",
    sortOrder: 0,
    isDefault: false,
  },
  {
    id: "prio-normal",
    slug: "normal",
    label: "Normal",
    color: "blue",
    sortOrder: 1,
    isDefault: true,
  },
  {
    id: "prio-high",
    slug: "high",
    label: "High",
    color: "amber",
    sortOrder: 2,
    isDefault: false,
  },
  {
    id: "prio-urgent",
    slug: "urgent",
    label: "Urgent",
    color: "red",
    sortOrder: 3,
    isDefault: false,
  },
];

export async function seedDefaultConfig(db: TestDb) {
  await db
    .insert(schema.ticketStatuses)
    .values(DEFAULT_STATUSES.map((s) => ({ ...s, ...ts })));
  await db
    .insert(schema.ticketCategories)
    .values(DEFAULT_CATEGORIES.map((c) => ({ ...c, ...ts })));
  await db
    .insert(schema.ticketPriorities)
    .values(DEFAULT_PRIORITIES.map((p) => ({ ...p, ...ts })));
}

/* -------------------------------------------------------------- customers */

export const CUSTOMERS = {
  ann: { id: "cust-ann", name: "Ann Adams", email: "ann@example.test" },
  zed: { id: "cust-zed", name: "Zed Zimmer", email: "zed@example.test" },
  pat: { id: "cust-pat", name: "Pat Percent", email: "pat@example.test" },
  una: {
    id: "cust-una",
    name: "Una Under_score",
    email: "una_under@example.test",
  },
} as const;

export async function seedCustomers(db: TestDb) {
  const created = at("2026-01-01T00:00:00.000Z");
  await db.insert(schema.customers).values(
    Object.values(CUSTOMERS).map((c) => ({
      ...c,
      note: null,
      createdAt: created,
      updatedAt: created,
    }))
  );
}

/* ---------------------------------------------------------------- tickets */

export type TicketSeed = {
  num: number;
  subject: string;
  status: string;
  category: string;
  priority: string;
  customer: keyof typeof CUSTOMERS;
  assignee?: keyof typeof USERS;
  awaiting?: boolean;
  created: string;
  updated: string;
  waitingSince?: string;
  closedAt?: string;
  mergedInto?: number;
  tags?: string[];
};

function t(
  num: number,
  subject: string,
  status: string,
  category: string,
  priority: string,
  customer: keyof typeof CUSTOMERS,
  created: string,
  updated: string,
  extra: Partial<TicketSeed> = {}
): TicketSeed {
  return {
    num,
    subject,
    status,
    category,
    priority,
    customer,
    created,
    updated,
    ...extra,
  };
}

// All timestamps are explicit. FIXED_NOW = 2026-03-15T12:00:00Z.
// createdAt / updatedAt / waitingSince are pairwise distinct across the open
// tickets, and closed durations are distinct, so every sort key has a total
// order (no reliance on Postgres tie ordering).
export const WORLD_TICKETS: TicketSeed[] = [
  t(
    101,
    "Cannot log in",
    "open",
    "bug",
    "high",
    "ann",
    "2026-03-15T06:00:00Z",
    "2026-03-15T09:00:00Z",
    { assignee: "alice", awaiting: true, waitingSince: "2026-03-15T08:00:00Z" }
  ),
  t(
    102,
    "Refund 100% please",
    "open",
    "billing",
    "normal",
    "zed",
    "2026-03-13T09:00:00Z",
    "2026-03-14T09:00:00Z",
    { awaiting: true, waitingSince: "2026-03-13T09:00:00Z", tags: ["billing"] }
  ),
  t(
    103,
    "snake_case error in export",
    "in_progress",
    "bug",
    "urgent",
    "pat",
    "2026-03-10T09:30:00Z",
    "2026-03-12T09:00:00Z",
    { assignee: "bob" }
  ),
  t(
    104,
    "Order 1005 delayed",
    "open",
    "billing",
    "low",
    "una",
    "2026-03-08T10:00:00Z",
    "2026-03-08T11:00:00Z"
  ),
  t(
    105,
    "Feature: dark mode",
    "open",
    "feature_request",
    "normal",
    "ann",
    "2026-03-01T10:00:00Z",
    "2026-03-02T10:00:00Z",
    { assignee: "alice" }
  ),
  t(
    106,
    "Billing address wrong",
    "in_progress",
    "billing",
    "high",
    "zed",
    "2026-02-20T10:00:00Z",
    "2026-03-14T15:00:00Z",
    { assignee: "bob", awaiting: true, waitingSince: "2026-03-14T14:00:00Z" }
  ),
  // closed but awaitingReply=true: the generic status-change route only sets closedAt
  t(
    107,
    "General question",
    "closed",
    "general_query",
    "normal",
    "una",
    "2026-03-03T09:00:00Z",
    "2026-03-04T11:00:00Z",
    { assignee: "alice", awaiting: true, closedAt: "2026-03-04T11:00:00Z" }
  ),
  t(
    108,
    "Old issue resolved",
    "closed",
    "issue",
    "low",
    "pat",
    "2026-01-05T09:00:00Z",
    "2026-01-05T12:00:00Z",
    { closedAt: "2026-01-05T12:00:00Z" }
  ),
  t(
    109,
    "Ancient bug",
    "open",
    "bug",
    "normal",
    "ann",
    "2025-12-01T09:00:00Z",
    "2025-12-02T09:00:00Z"
  ),
  t(
    110,
    "Tagged ticket one",
    "in_progress",
    "issue",
    "normal",
    "zed",
    "2026-03-12T08:00:00Z",
    "2026-03-13T08:00:00Z",
    {
      assignee: "alice",
      waitingSince: "2026-03-12T08:30:00Z",
      tags: ["vip", "billing"],
    }
  ),
  t(
    111,
    "Tagged ticket two",
    "open",
    "issue",
    "high",
    "pat",
    "2026-03-11T08:00:00Z",
    "2026-03-13T20:00:00Z",
    { awaiting: true, waitingSince: "2026-03-11T09:00:00Z", tags: ["vip"] }
  ),
  t(
    112,
    "ANN question about #103",
    "open",
    "general_query",
    "low",
    "una",
    "2026-03-09T08:00:00Z",
    "2026-03-09T09:00:00Z",
    { assignee: "bob" }
  ),
  // Merged shells (never in the list; forward to their target)
  t(
    120,
    "Duplicate login problem",
    "closed",
    "bug",
    "normal",
    "ann",
    "2026-03-14T09:00:00Z",
    "2026-03-14T09:30:00Z",
    { assignee: "alice", closedAt: "2026-03-14T09:30:00Z", mergedInto: 101 }
  ),
  t(
    121,
    "Dup dark mode",
    "closed",
    "feature_request",
    "normal",
    "ann",
    "2026-03-02T10:00:00Z",
    "2026-03-02T11:00:00Z",
    { closedAt: "2026-03-02T11:00:00Z", mergedInto: 105 }
  ),
];

export const tid = (num: number) => `t-${num}`;

function ticketRow(x: TicketSeed) {
  return {
    id: tid(x.num),
    ticketNumber: x.num,
    subject: x.subject,
    description: doc(`Description of ${x.subject}`),
    category: x.category,
    status: x.status,
    priority: x.priority,
    customerId: CUSTOMERS[x.customer].id,
    customerToken: `token-${x.num}`,
    assignedAgentId: x.assignee ? USERS[x.assignee].id : null,
    awaitingReply: x.awaiting ?? false,
    pendingReplies: 0,
    source: "portal",
    closedAt: x.closedAt ? at(x.closedAt) : null,
    mergedIntoTicketId: null as string | null,
    mergedAt: x.mergedInto ? at(x.updated) : null,
    waitingSince: x.waitingSince ? at(x.waitingSince) : null,
    firstRespondedAt: null,
    slaActiveSeconds: 0,
    createdAt: at(x.created),
    updatedAt: at(x.updated),
  };
}

/** Inserts tickets (targets before merged shells) plus their tags. */
export async function insertTickets(db: TestDb, seeds: TicketSeed[]) {
  const plain = seeds.filter((x) => x.mergedInto === undefined);
  const merged = seeds.filter((x) => x.mergedInto !== undefined);
  if (plain.length > 0) {
    await db.insert(schema.tickets).values(plain.map(ticketRow));
  }
  if (merged.length > 0) {
    await db.insert(schema.tickets).values(
      merged.map((x) => ({
        ...ticketRow(x),
        mergedIntoTicketId: tid(x.mergedInto as number),
      }))
    );
  }

  const tagNames = [...new Set(seeds.flatMap((x) => x.tags ?? []))].sort();
  if (tagNames.length > 0) {
    await db.insert(schema.tags).values(
      tagNames.map((name) => ({
        id: `tag-${name}`,
        name,
        createdAt: at("2026-01-02T00:00:00Z"),
      }))
    );
    await db.insert(schema.ticketTags).values(
      seeds.flatMap((x) =>
        (x.tags ?? []).map((name) => ({
          id: `tt-${x.num}-${name}`,
          ticketId: tid(x.num),
          tagId: `tag-${name}`,
          createdAt: at("2026-01-02T00:00:00Z"),
        }))
      )
    );
  }
}

/* ------------------------------------- the "world" used by list + thread */

export async function seedWorld(db: TestDb) {
  await seedUsers(db);
  await seedDefaultConfig(db);
  await seedCustomers(db);
  await insertTickets(db, WORLD_TICKETS);

  // Extra tag in the pool that no ticket uses (appears in the tag filter).
  await db.insert(schema.tags).values({
    id: "tag-unused",
    name: "unused-tag",
    createdAt: at("2026-01-02T00:00:00Z"),
  });

  // Updated-by column: latest agent/admin activity wins; customer rows ignored.
  const act = (
    id: string,
    num: number,
    actor: keyof typeof USERS | null,
    name: string,
    role: string,
    action: string,
    when: string
  ) => ({
    id,
    ticketId: tid(num),
    actorId: actor ? USERS[actor].id : null,
    actorName: name,
    actorRole: role,
    action,
    metadata: null,
    createdAt: at(when),
  });
  await db
    .insert(schema.ticketActivity)
    .values([
      act(
        "act-list-1",
        101,
        "alice",
        "Alice Agent",
        "agent",
        "status_changed",
        "2026-03-15T07:00:00Z"
      ),
      act(
        "act-list-2",
        101,
        "bob",
        "Bob Admin",
        "admin",
        "assigned",
        "2026-03-15T08:30:00Z"
      ),
      act(
        "act-list-3",
        101,
        null,
        "Ann Adams",
        "customer",
        "replied",
        "2026-03-15T08:45:00Z"
      ),
      act(
        "act-list-4",
        105,
        "alice",
        "Alice Agent",
        "agent",
        "priority_changed",
        "2026-03-02T10:00:00Z"
      ),
      act(
        "act-list-5",
        106,
        null,
        "Zed Zimmer",
        "customer",
        "replied",
        "2026-03-14T14:00:00Z"
      ),
    ]);

  // Linked-ticket numbers column.
  await db.insert(schema.ticketLinks).values([
    {
      id: "link-1",
      ticketId: tid(101),
      linkedTicketId: tid(104),
      type: "related_to",
      createdById: USERS.alice.id,
      createdAt: at("2026-03-15T07:30:00Z"),
      updatedAt: at("2026-03-15T07:30:00Z"),
    },
    {
      id: "link-2",
      ticketId: tid(103),
      linkedTicketId: tid(105),
      type: "blocks",
      createdById: USERS.bob.id,
      createdAt: at("2026-03-12T08:00:00Z"),
      updatedAt: at("2026-03-12T08:00:00Z"),
    },
  ]);

  // Reply drafts: alice has one on 102 and on 103 (the thread ticket); bob on 101.
  await db.insert(schema.ticketReplyDrafts).values([
    {
      ticketId: tid(102),
      userId: USERS.alice.id,
      content: doc("alice draft on 102"),
      isInternal: false,
      createdAt: at("2026-03-14T10:00:00Z"),
      updatedAt: at("2026-03-14T10:00:00Z"),
    },
    {
      ticketId: tid(103),
      userId: USERS.alice.id,
      content: doc("alice internal draft on 103"),
      isInternal: true,
      createdAt: at("2026-03-12T10:00:00Z"),
      updatedAt: at("2026-03-12T10:30:00Z"),
    },
    {
      ticketId: tid(101),
      userId: USERS.bob.id,
      content: doc("bob draft on 101"),
      isInternal: false,
      createdAt: at("2026-03-15T08:00:00Z"),
      updatedAt: at("2026-03-15T08:00:00Z"),
    },
  ]);

  // bob hides the tags + updatedBy columns (so those queries are skipped).
  await db.insert(schema.userTicketTablePrefs).values({
    userId: USERS.bob.id,
    columns: [
      { id: "tags", visible: false },
      { id: "updatedBy", visible: false },
      { id: "status", visible: true },
    ],
    sendReplyOnEnter: false,
    showSlaAndOverdue: false,
    updatedAt: at("2026-03-01T00:00:00Z"),
  });

  // Custom fields + values (thread sidebar).
  await db.insert(schema.ticketCustomFields).values([
    {
      id: "cf-plan",
      key: "plan",
      label: "Plan",
      type: "select",
      options: ["free", "pro"],
      required: false,
      sortOrder: 1,
      ...ts,
    },
    {
      id: "cf-order",
      key: "order_ref",
      label: "Order Ref",
      type: "text",
      options: null,
      required: true,
      sortOrder: 0,
      ...ts,
    },
  ]);
  await db.insert(schema.ticketCustomFieldValues).values({
    id: "cfv-1",
    ticketId: tid(103),
    fieldId: "cf-plan",
    value: "pro",
    createdAt: at("2026-03-10T09:30:00Z"),
    updatedAt: at("2026-03-10T09:30:00Z"),
  });

  // Canned responses (thread reply form), inserted out of title order.
  await db.insert(schema.cannedResponses).values([
    {
      id: "canned-b",
      title: "Beta",
      content: doc("beta body"),
      createdById: USERS.alice.id,
      createdByName: "Alice Agent",
      createdAt: at("2026-02-01T00:00:00Z"),
      updatedAt: at("2026-02-01T00:00:00Z"),
    },
    {
      id: "canned-a",
      title: "Alpha",
      content: doc("alpha body"),
      createdById: null,
      createdByName: "Deleted Agent",
      createdAt: at("2026-02-02T00:00:00Z"),
      updatedAt: at("2026-02-02T00:00:00Z"),
    },
  ]);

  await seedThread(db);
}

/** Rich thread on ticket #103: public replies, internal notes, ticket-level and
 * per-comment attachments, several activity rows. Inserted OUT of display order
 * on purpose so the ORDER BY is what the snapshot proves. */
async function seedThread(db: TestDb) {
  const ticketId = tid(103);
  const cm = (
    id: string,
    author: keyof typeof USERS | null,
    name: string,
    role: string,
    content: string,
    isInternal: boolean,
    when: string
  ) => ({
    id,
    ticketId,
    authorId: author ? USERS[author].id : null,
    authorName: name,
    authorRole: role,
    content,
    isInternal,
    createdAt: at(when),
    updatedAt: at(when),
  });
  await db
    .insert(schema.ticketComments)
    .values([
      cm(
        "cm-5",
        "alice",
        "Alice Agent",
        "agent",
        "Legacy plain text reply",
        false,
        "2026-03-11T10:00:00Z"
      ),
      cm(
        "cm-1",
        null,
        "Pat Percent",
        "customer",
        doc("Customer first message"),
        false,
        "2026-03-10T10:00:00Z"
      ),
      cm(
        "cm-3",
        "bob",
        "Bob Admin",
        "admin",
        doc("Internal note: check the export job"),
        true,
        "2026-03-10T12:00:00Z"
      ),
      cm(
        "cm-2",
        "bob",
        "Bob Admin",
        "admin",
        doc("Public agent reply"),
        false,
        "2026-03-10T11:00:00Z"
      ),
      cm(
        "cm-6",
        null,
        "Pat Percent",
        "customer",
        "",
        false,
        "2026-03-12T08:00:00Z"
      ),
      cm(
        "cm-4",
        null,
        "Pat Percent",
        "customer",
        doc("Customer follow-up with files"),
        false,
        "2026-03-11T09:00:00Z"
      ),
    ]);

  const att = (
    id: string,
    commentId: string | null,
    filename: string,
    dir: string,
    fileSize: number,
    mimeType: string,
    uploader: keyof typeof USERS | null,
    uploaderName: string,
    uploaderRole: string,
    when: string
  ) => ({
    id,
    ticketId,
    commentId,
    filename,
    storageKey: `tickets/t-103/${dir}/${filename}`,
    fileSize,
    mimeType,
    uploadedById: uploader ? USERS[uploader].id : null,
    uploadedByName: uploaderName,
    uploadedByRole: uploaderRole,
    createdAt: at(when),
  });
  // Inserted in this fixed order; the page's attachment query has no ORDER BY.
  await db
    .insert(schema.ticketAttachments)
    .values([
      att(
        "att-1",
        null,
        "screenshot.png",
        "aaa",
        1024,
        "image/png",
        null,
        "Pat Percent",
        "customer",
        "2026-03-10T09:30:00Z"
      ),
      att(
        "att-2",
        null,
        "agent-note.pdf",
        "bbb",
        2048,
        "application/pdf",
        "bob",
        "Bob Admin",
        "admin",
        "2026-03-10T09:45:00Z"
      ),
      att(
        "att-3",
        "cm-4",
        "log-1.txt",
        "ccc",
        300,
        "text/plain",
        null,
        "Pat Percent",
        "customer",
        "2026-03-11T09:00:00Z"
      ),
      att(
        "att-4",
        "cm-4",
        "log-2.txt",
        "ddd",
        400,
        "text/plain",
        null,
        "Pat Percent",
        "customer",
        "2026-03-11T09:00:01Z"
      ),
      att(
        "att-5",
        "cm-6",
        "only-file.zip",
        "eee",
        5000,
        "application/zip",
        null,
        "Pat Percent",
        "customer",
        "2026-03-12T08:00:00Z"
      ),
    ]);

  const ac = (
    id: string,
    actor: keyof typeof USERS | null,
    name: string,
    role: string,
    action: string,
    metadata: Record<string, unknown> | null,
    when: string
  ) => ({
    id,
    ticketId,
    actorId: actor ? USERS[actor].id : null,
    actorName: name,
    actorRole: role,
    action,
    metadata,
    createdAt: at(when),
  });
  await db
    .insert(schema.ticketActivity)
    .values([
      ac(
        "act-3",
        "bob",
        "Bob Admin",
        "admin",
        "priority_changed",
        { from: "normal", to: "urgent" },
        "2026-03-10T13:00:00Z"
      ),
      ac(
        "act-1",
        null,
        "Pat Percent",
        "customer",
        "created",
        null,
        "2026-03-10T09:30:00Z"
      ),
      ac(
        "act-5",
        "alice",
        "Alice Agent",
        "agent",
        "replied",
        { internal: false },
        "2026-03-11T10:00:00Z"
      ),
      ac(
        "act-2",
        "bob",
        "Bob Admin",
        "admin",
        "status_changed",
        { from: "open", to: "in_progress" },
        "2026-03-10T10:30:00Z"
      ),
      ac(
        "act-4",
        "bob",
        "Bob Admin",
        "admin",
        "assigned",
        { to: "user-bob" },
        "2026-03-10T14:00:00Z"
      ),
    ]);
}

/* --------------------------------------------- stats datasets (overview) */

/** Overview mix: default/in-progress/closed/merged/unknown-status tickets.
 * createdAt values are fixed; the expected average wait is derived from them. */
export const OVERVIEW_TICKETS: TicketSeed[] = [
  t(
    1,
    "open-a",
    "open",
    "bug",
    "normal",
    "ann",
    "2026-03-01T00:00:00Z",
    "2026-03-01T00:00:00Z"
  ),
  t(
    2,
    "open-b",
    "open",
    "bug",
    "normal",
    "ann",
    "2026-03-05T00:00:00Z",
    "2026-03-05T00:00:00Z"
  ),
  t(
    3,
    "open-c",
    "open",
    "bug",
    "normal",
    "zed",
    "2026-03-09T00:00:00Z",
    "2026-03-09T00:00:00Z"
  ),
  t(
    4,
    "prog-a",
    "in_progress",
    "bug",
    "normal",
    "zed",
    "2026-03-02T00:00:00Z",
    "2026-03-02T00:00:00Z"
  ),
  t(
    5,
    "prog-b",
    "in_progress",
    "bug",
    "normal",
    "pat",
    "2026-03-07T00:00:00Z",
    "2026-03-07T00:00:00Z"
  ),
  t(
    6,
    "closed-a",
    "closed",
    "bug",
    "normal",
    "pat",
    "2026-02-01T00:00:00Z",
    "2026-02-02T00:00:00Z",
    { closedAt: "2026-02-02T00:00:00Z" }
  ),
  t(
    7,
    "closed-b",
    "closed",
    "bug",
    "normal",
    "una",
    "2026-02-03T00:00:00Z",
    "2026-02-04T00:00:00Z",
    { closedAt: "2026-02-04T00:00:00Z" }
  ),
  t(
    8,
    "closed-c",
    "closed",
    "bug",
    "normal",
    "una",
    "2026-02-05T00:00:00Z",
    "2026-02-06T00:00:00Z",
    { closedAt: "2026-02-06T00:00:00Z" }
  ),
  // status slug that no longer exists in ticket_statuses: counted as inProgress, excluded from avg wait
  t(
    9,
    "legacy-status",
    "legacy_status",
    "bug",
    "normal",
    "ann",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z"
  ),
  // merged shells: excluded from every count and from the average
  t(
    10,
    "merged-open",
    "open",
    "bug",
    "normal",
    "ann",
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
    { mergedInto: 1 }
  ),
  t(
    11,
    "merged-closed",
    "closed",
    "bug",
    "normal",
    "ann",
    "2025-01-02T00:00:00Z",
    "2025-01-02T00:00:00Z",
    { closedAt: "2025-01-02T00:00:00Z", mergedInto: 2 }
  ),
];

/** createdAt of the tickets that feed the average wait (non-closed config
 * statuses, not merged): open + in_progress only. */
export const OVERVIEW_AVG_WAIT_CREATED = OVERVIEW_TICKETS.filter(
  (x) => !x.mergedInto && (x.status === "open" || x.status === "in_progress")
).map((x) => new Date(x.created).getTime());

export async function seedOverviewWorld(db: TestDb) {
  await seedDefaultConfig(db);
  await seedCustomers(db);
  await insertTickets(db, OVERVIEW_TICKETS);
}

/** Config whose only status is a closed one (no non-closed statuses, no default). */
export async function seedClosedOnlyConfig(db: TestDb) {
  await db.insert(schema.ticketStatuses).values({
    id: "status-closed",
    slug: "closed",
    label: "Closed",
    color: "slate",
    sortOrder: 0,
    isDefault: false,
    isClosedState: true,
    ...ts,
  });
  await seedCustomers(db);
  await insertTickets(db, [
    t(
      1,
      "c1",
      "closed",
      "bug",
      "normal",
      "ann",
      "2026-02-01T00:00:00Z",
      "2026-02-02T00:00:00Z",
      { closedAt: "2026-02-02T00:00:00Z" }
    ),
    t(
      2,
      "c2",
      "closed",
      "bug",
      "normal",
      "ann",
      "2026-02-03T00:00:00Z",
      "2026-02-04T00:00:00Z",
      { closedAt: "2026-02-04T00:00:00Z" }
    ),
    // slug unknown to this config -> not closed, not default -> inProgress
    t(
      3,
      "u1",
      "open",
      "bug",
      "normal",
      "ann",
      "2026-02-05T00:00:00Z",
      "2026-02-05T00:00:00Z"
    ),
  ]);
}

/** Statuses exist (open/in_progress/closed) but only closed tickets do. */
export async function seedOnlyClosedTickets(db: TestDb) {
  await seedDefaultConfig(db);
  await seedCustomers(db);
  await insertTickets(db, [
    t(
      1,
      "c1",
      "closed",
      "bug",
      "normal",
      "ann",
      "2026-02-01T00:00:00Z",
      "2026-02-02T00:00:00Z",
      { closedAt: "2026-02-02T00:00:00Z" }
    ),
  ]);
}

/** Default statuses only; no tickets at all. */
export async function seedConfigOnly(db: TestDb) {
  await seedDefaultConfig(db);
}

/* ------------------------------------------------------ volume stats data */

const noon = (day: string) => `${day}T12:00:00Z`;

/** Tickets at noon UTC on chosen days relative to FIXED_NOW (2026-03-15):
 * keeps results independent of the machine's time zone. */
const VOLUME_DAYS: Array<[number, string]> = [
  [1, "2026-03-15"],
  [2, "2026-03-15"],
  [3, "2026-03-14"],
  [4, "2026-03-13"],
  [5, "2026-03-11"],
  [6, "2026-03-09"], // offset 6: last day inside the 7-day window
  [7, "2026-03-08"], // offset 7: just outside the 7-day window
  [8, "2026-03-05"],
  [9, "2026-02-23"],
  [10, "2026-02-14"], // offset 29: last day inside the 30-day window
  [11, "2026-02-13"], // offset 30: just outside the 30-day window
  [12, "2026-01-29"],
];

export async function seedVolumeWorld(db: TestDb) {
  await seedDefaultConfig(db);
  await seedCustomers(db);
  await insertTickets(db, [
    ...VOLUME_DAYS.map(([num, day]) =>
      t(num, `vol-${num}`, "open", "bug", "normal", "ann", noon(day), noon(day))
    ),
    // merged shells inside the window: must not be counted
    t(
      20,
      "vol-merged-1",
      "closed",
      "bug",
      "normal",
      "ann",
      noon("2026-03-15"),
      noon("2026-03-15"),
      { mergedInto: 1 }
    ),
    t(
      21,
      "vol-merged-2",
      "closed",
      "bug",
      "normal",
      "ann",
      noon("2026-03-14"),
      noon("2026-03-14"),
      { mergedInto: 3 }
    ),
  ]);
}

/* ------------------------------------------------------ canned responses */

export async function seedCannedResponses(db: TestDb) {
  await seedUsers(db);
  const base = at("2026-02-01T00:00:00Z").getTime();
  const row = (id: string, title: string, n: number) => ({
    id,
    title,
    content: doc(`body of ${title}`),
    createdById: n % 2 === 0 ? USERS.alice.id : null,
    createdByName: n % 2 === 0 ? "Alice Agent" : "Deleted Agent",
    createdAt: new Date(base + n * 60_000),
    updatedAt: new Date(base + n * 60_000),
  });
  // Deliberately inserted out of title order.
  await db
    .insert(schema.cannedResponses)
    .values([
      row("cr-zebra", "Zebra reply", 1),
      row("cr-greeting", "Greeting", 2),
      row("cr-apology", "apology template", 3),
      row("cr-pct", "Refund policy 100%", 4),
      row("cr-snake", "snake_case tips", 5),
      row("cr-greet2", "greeting follow-up", 6),
      row("cr-alpha", "Alpha", 7),
      row("cr-digits", "100 days", 8),
    ]);
}

/* --------------------------------------------------------------- v1 config */

export async function seedV1Config(db: TestDb) {
  await seedDefaultConfig(db);
  await db.insert(schema.ticketCustomFields).values([
    {
      id: "cf-3",
      key: "satisfied",
      label: "Satisfied",
      type: "checkbox",
      options: null,
      required: false,
      sortOrder: 2,
      ...ts,
    },
    {
      id: "cf-1",
      key: "order_ref",
      label: "Order Ref",
      type: "text",
      options: null,
      required: true,
      sortOrder: 0,
      ...ts,
    },
    {
      id: "cf-2",
      key: "plan",
      label: "Plan",
      type: "select",
      options: ["free", "pro", "enterprise"],
      required: false,
      sortOrder: 1,
      ...ts,
    },
  ]);
  await db.insert(schema.tags).values(
    ["zeta", "alpha", "vip", "billing"].map((name) => ({
      id: `tag-${name}`,
      name,
      createdAt: at("2026-01-02T00:00:00Z"),
    }))
  );
}
