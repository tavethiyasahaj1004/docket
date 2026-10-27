import { eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { vi } from "vitest";
import {
  emailOutbox,
  notifications,
  platformSettings,
  tags,
  ticketActivity,
  ticketAttachments,
  ticketComments,
  ticketReplyDrafts,
  ticketStatuses,
  tickets,
  ticketTags,
  webhookDeliveries,
  webhookEndpoints,
} from "@/db/schema";
import { db } from "@/lib/db";
import { JOB_NAMES } from "@/lib/worker/job-types";
import { FIXED_NOW, seedWorld, type TestDb, USERS } from "../fixtures";
import { reseed } from "./helpers";

/* ------------------------------------------------------------------------ *
 * Shared mocks. `vi.mock` must be declared in each test file, so each file
 * registers factories that lazily import these module-shaped objects:
 *
 *   vi.mock("@/lib/auth", async () =>
 *     (await import("./write-helpers")).authModule());
 *
 * Every recorded mock call lands in ONE ordered `callLog`.
 * ------------------------------------------------------------------------ */

export type CallEntry = Record<string, unknown>;

export const callLog: CallEntry[] = [];
export const getSession = vi.fn();

/** What the (mocked) email job enqueue does. Webhook jobs always resolve. */
export const enqueueMode: { email: "resolve" | "hang" | "reject" } = {
  email: "resolve",
};
export const emailEnqueueError = new Error("simulated email enqueue failure");

export function authModule() {
  return { auth: { api: { getSession } } };
}

export function enqueueModule() {
  return {
    enqueueJob: (job: string, payload: unknown) => {
      callLog.push({ call: "enqueueJob", job, payload });
      if (job === JOB_NAMES.EMAIL_SEND) {
        if (enqueueMode.email === "hang") {
          return new Promise<never>(() => undefined);
        }
        if (enqueueMode.email === "reject") {
          return Promise.reject(emailEnqueueError);
        }
      }
      return Promise.resolve("job-id");
    },
    getBoss: () =>
      Promise.reject(new Error("getBoss must not be used in these tests")),
  };
}

export function realtimeModule(original: Record<string, unknown>) {
  return {
    ...original,
    publishTicketCommentCreated: (ticketId: string) => {
      callLog.push({ call: "realtime.publishTicketCommentCreated", ticketId });
      return Promise.resolve();
    },
    publishNotificationCreated: (userId: string) => {
      callLog.push({ call: "realtime.publishNotificationCreated", userId });
      return Promise.resolve();
    },
  };
}

export function pushModule(original: Record<string, unknown>) {
  return {
    ...original,
    publishPushToUsers: (userIds: string[], data: unknown) => {
      callLog.push({ call: "push.publishPushToUsers", userIds, data });
      return Promise.resolve();
    },
  };
}

/** In-memory storage: records upload/delete, keeps the bytes in a Map. */
export const storedFiles = new Map<string, number>();

export function storageModule(original: Record<string, unknown>) {
  const originalStorage = original.storage as Record<string, unknown>;
  return {
    ...original,
    storage: {
      ...originalStorage,
      upload: (key: string, buffer: Buffer, mimeType: string) => {
        callLog.push({
          call: "storage.upload",
          key,
          bytes: buffer.length,
          mimeType,
        });
        storedFiles.set(key, buffer.length);
        return Promise.resolve();
      },
      delete: (key: string) => {
        callLog.push({ call: "storage.delete", key });
        storedFiles.delete(key);
        return Promise.resolve();
      },
    },
  };
}

export function resetMocks() {
  vi.setSystemTime(FIXED_NOW);
  callLog.length = 0;
  storedFiles.clear();
  getSession.mockReset();
  enqueueMode.email = "resolve";
}

export const agentSession = {
  user: {
    id: USERS.alice.id,
    role: "agent",
    name: USERS.alice.name,
    email: USERS.alice.email,
  },
};
export const adminSession = {
  user: {
    id: USERS.bob.id,
    role: "admin",
    name: USERS.bob.name,
    email: USERS.bob.email,
  },
};

/* ------------------------------------------------------------------ seed */

export const ALL_TICKET_EVENTS = [
  "ticket.replied",
  "ticket.closed",
  "ticket.reopened",
  "ticket.status_changed",
  "ticket.category_changed",
  "ticket.priority_changed",
  "ticket.assigned",
  "ticket.unassigned",
];

export interface WriteSeedOptions {
  /** platform_settings.ticket_email_notifications_enabled (default true). */
  emailNotifications?: boolean;
  /** Extra rows inserted after the standard world. */
  extra?: (db: TestDb) => Promise<void>;
}

/**
 * Re-seeds from scratch: seedWorld + ONE active webhook endpoint subscribed to
 * every ticket event the write routes emit. With `emailNotifications: false`
 * an explicit platform_settings row switches ticket emails off (no row at all
 * means the default: on).
 */
export async function seedWriteWorld(options: WriteSeedOptions = {}) {
  await reseed(async (seedDb) => {
    await seedWorld(seedDb);
    await seedDb.insert(webhookEndpoints).values({
      id: "wh-1",
      name: "Characterization hook",
      url: "https://hooks.example.test/docket",
      secretEncrypted: "not-a-real-secret",
      events: ALL_TICKET_EVENTS,
      isActive: true,
      createdById: USERS.bob.id,
      createdByName: USERS.bob.name,
    });
    if (options.emailNotifications === false) {
      await seedDb
        .insert(platformSettings)
        .values({ id: "default", ticketEmailNotificationsEnabled: false });
    }
    await options.extra?.(seedDb);
  });
}

/** Removes the closed (or default) status so the route's config guard trips. */
export async function deleteStatusBy(
  seedDb: TestDb,
  which: "closed" | "default"
) {
  await seedDb
    .delete(ticketStatuses)
    .where(
      which === "closed"
        ? eq(ticketStatuses.isClosedState, true)
        : eq(ticketStatuses.isDefault, true)
    );
}

/* ------------------------------------------------------- state capture */

type Row = Record<string, unknown>;

interface State {
  activity: Row[];
  attachments: Row[];
  comments: Row[];
  deliveries: Row[];
  drafts: Row[];
  notifications: Row[];
  outbox: Row[];
  tags: Row[];
  tickets: Row[];
  ticketTags: Row[];
}

const byId = (a: Row, b: Row) => String(a.id).localeCompare(String(b.id));

async function readState(ticketIds: string[]): Promise<State> {
  const [
    ticketRows,
    comments,
    attachments,
    activity,
    deliveries,
    outbox,
    notifs,
    drafts,
    links,
    tagRows,
  ] = await Promise.all([
    db.select().from(tickets).where(inArray(tickets.id, ticketIds)),
    db
      .select()
      .from(ticketComments)
      .where(inArray(ticketComments.ticketId, ticketIds)),
    db
      .select()
      .from(ticketAttachments)
      .where(inArray(ticketAttachments.ticketId, ticketIds)),
    db
      .select()
      .from(ticketActivity)
      .where(inArray(ticketActivity.ticketId, ticketIds)),
    db.select().from(webhookDeliveries),
    db.select().from(emailOutbox),
    db.select().from(notifications),
    db
      .select()
      .from(ticketReplyDrafts)
      .where(inArray(ticketReplyDrafts.ticketId, ticketIds)),
    db
      .select({
        id: ticketTags.id,
        ticketId: ticketTags.ticketId,
        tagId: ticketTags.tagId,
        name: tags.name,
      })
      .from(ticketTags)
      .innerJoin(tags, eq(ticketTags.tagId, tags.id))
      .where(inArray(ticketTags.ticketId, ticketIds)),
    db.select({ id: tags.id, name: tags.name }).from(tags),
  ]);
  return {
    tickets: ticketRows as Row[],
    comments: comments as Row[],
    attachments: attachments as Row[],
    activity: activity as Row[],
    deliveries: deliveries as Row[],
    outbox: outbox as Row[],
    notifications: notifs as Row[],
    drafts: drafts as Row[],
    ticketTags: links as Row[],
    tags: tagRows as Row[],
  };
}

function newRows(before: Row[], after: Row[]): Row[] {
  const known = new Set(before.map((r) => r.id));
  return after.filter((r) => !known.has(r.id));
}

/** Column-level before/after of the rows that changed. */
function diffRows(before: Row[], after: Row[]) {
  const out: Record<
    string,
    Record<string, { from: unknown; to: unknown }>
  > = {};
  for (const row of after) {
    const prev = before.find((b) => b.id === row.id);
    if (!prev) {
      continue;
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of Object.keys(row)) {
      if (JSON.stringify(prev[key]) !== JSON.stringify(row[key])) {
        changes[key] = { from: prev[key], to: row[key] };
      }
    }
    if (Object.keys(changes).length > 0) {
      out[String(row.id)] = changes;
    }
  }
  return out;
}

const cmp = (...keys: Array<string | number>) => keys.join("\u0000");

export interface Effects {
  activity: Row[];
  attachments: Row[];
  calls: CallEntry[];
  comments: Row[];
  deliveries: Row[];
  drafts: Row[];
  emails: Row[];
  newTags: Row[];
  notifications: Row[];
  response: { status: number; body: unknown };
  ticketDiff: Record<string, Record<string, { from: unknown; to: unknown }>>;
  tickets: Row[];
  ticketTags: Row[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls with REAL timers (max ~5 s). Not vi.waitFor: under fake timers that
 * advances the faked Date on every poll, which would break the frozen clock.
 */
export async function waitUntil(check: () => boolean, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) {
      throw new Error("waitUntil timed out");
    }
    await sleep(10);
  }
}

export interface CaptureOptions {
  /** Wait for the fire-and-forget email job (default false: settle 300ms). */
  expectEmail?: boolean;
  /** Run the request and return the response. */
  invoke: () => Promise<Response>;
  /** Tickets whose rows are reported (the affected ticket(s)). */
  ticketIds: string[];
}

/**
 * Runs one request and records every observable effect: the response, the
 * rows it touched (diffed against a pre-request read), and the ordered mock
 * call log. Returns the raw effects and the id-normalized ones (snapshot).
 */
export async function captureEffects(opts: CaptureOptions) {
  const before = await readState(opts.ticketIds);
  callLog.length = 0;

  const res = await opts.invoke();
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep as text
  }

  if (opts.expectEmail) {
    await waitUntil(() => callLog.some((c) => c.job === JOB_NAMES.EMAIL_SEND));
  } else {
    await sleep(300);
  }

  const after = await readState(opts.ticketIds);

  const effects: Effects = {
    response: { status: res.status, body },
    tickets: [...after.tickets].sort(byId),
    ticketDiff: diffRows(before.tickets, after.tickets),
    comments: newRows(before.comments, after.comments).sort((a, b) =>
      cmp(String(a.createdAt), String(a.content)).localeCompare(
        cmp(String(b.createdAt), String(b.content))
      )
    ),
    attachments: newRows(before.attachments, after.attachments).sort((a, b) =>
      String(a.filename).localeCompare(String(b.filename))
    ),
    activity: newRows(before.activity, after.activity).sort((a, b) =>
      cmp(String(a.action), JSON.stringify(a.metadata)).localeCompare(
        cmp(String(b.action), JSON.stringify(b.metadata))
      )
    ),
    // webhook_deliveries / email_outbox default their timestamps in SQL
    // (wall clock, not the frozen JS Date) and the outbox idempotency key is a
    // random UUID, so those columns are dropped from the record.
    deliveries: newRows(before.deliveries, after.deliveries)
      .map((r) => ({
        id: r.id,
        webhookId: r.webhookId,
        event: r.event,
        entityType: r.entityType,
        entityId: r.entityId,
        status: r.status,
        attemptCount: r.attemptCount,
        payload: r.payload,
      }))
      .sort((a, b) =>
        cmp(String(a.event), String(a.entityId)).localeCompare(
          cmp(String(b.event), String(b.entityId))
        )
      ),
    emails: newRows(before.outbox, after.outbox)
      .map((r) => {
        const p = r.payload as {
          to: string;
          subject: string;
          html: string;
          text?: string;
        };
        return {
          id: r.id,
          status: r.status,
          attemptCount: r.attemptCount,
          to: p.to,
          subject: p.subject,
          text: p.text,
          htmlLength: p.html.length,
        };
      })
      .sort((a, b) => String(a.subject).localeCompare(String(b.subject))),
    notifications: newRows(before.notifications, after.notifications).sort(
      (a, b) => String(a.userId).localeCompare(String(b.userId))
    ),
    drafts: [...after.drafts].sort((a, b) =>
      String(a.userId).localeCompare(String(b.userId))
    ),
    ticketTags: after.ticketTags
      .map((r) => ({
        id: r.id,
        ticketId: r.ticketId,
        tagId: r.tagId,
        name: r.name,
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    newTags: newRows(before.tags, after.tags).sort((a, b) =>
      String(a.name).localeCompare(String(b.name))
    ),
    calls: callLog.map((c) => ({ ...c })),
  };

  return { effects, normalized: normalizeIds(effects) as Effects };
}

/* ----------------------------------------------------------- normalizer */

// A cuid2: 24 chars, lowercase letter first, then lowercase alphanumerics.
// Seeded ids ("t-101", "user-alice", "tag-vip", ...) never match.
const CUID2 = /(?<![a-z0-9])[a-z][a-z0-9]{23}(?![a-z0-9])/g;

/** Replaces generated ids with `<id:n>` in order of first appearance. */
export function normalizeIds<T>(value: T): T {
  const seen = new Map<string, string>();
  const swap = (s: string) =>
    s.replace(CUID2, (m) => {
      let p = seen.get(m);
      if (!p) {
        p = `<id:${seen.size + 1}>`;
        seen.set(m, p);
      }
      return p;
    });
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      return swap(v);
    }
    if (Array.isArray(v)) {
      return v.map(walk);
    }
    if (v instanceof Date || v === null || typeof v !== "object") {
      return v;
    }
    return Object.fromEntries(
      Object.entries(v as Row).map(([k, x]) => [swap(k), walk(x)])
    );
  };
  return walk(value) as T;
}

/* --------------------------------------------------------------- helpers */

export const calls = (effects: Effects, name: string) =>
  effects.calls.filter((c) => c.call === name);

export const jobs = (effects: Effects, job: string) =>
  effects.calls.filter((c) => c.call === "enqueueJob" && c.job === job);

export const events = (effects: Effects) =>
  effects.deliveries.map((d) => d.event as string);

export const actions = (effects: Effects) =>
  effects.activity.map((a) => a.action as string);

/* ------------------------------------------------------------- requests */

export function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

export function jsonRequest(path: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function makeFile(name: string, type: string, size = 8) {
  return new File([new Uint8Array(size).fill(65)], name, { type });
}

export interface CommentFields {
  content?: string;
  files?: File[];
  isInternal?: string;
  token?: string;
}

/** The multipart POST the reply composers send to /comments. */
export function commentRequest(id: string, fields: CommentFields) {
  const form = new FormData();
  if (fields.content !== undefined) {
    form.set("content", fields.content);
  }
  if (fields.isInternal !== undefined) {
    form.set("isInternal", fields.isInternal);
  }
  if (fields.token !== undefined) {
    form.set("token", fields.token);
  }
  for (const file of fields.files ?? []) {
    form.append("attachments", file);
  }
  return new NextRequest(`http://localhost:3000/api/tickets/${id}/comments`, {
    method: "POST",
    body: form,
  });
}
