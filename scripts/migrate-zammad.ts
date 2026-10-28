// Zammad → Docket import. Run migrate-zammad-users.ts first, inside the
// `app` container. Writes direct to Postgres to preserve Zammad timestamps;
// idempotent via each ticket's `zammad_migrated` row. A plain re-run imports
// only tickets that weren't there last time; pass --sync to also pull Zammad-side
// changes to the ones that were. Docs: deployment §7.

import fs from "node:fs/promises";
import path from "node:path";
import { createId } from "@paralleldrive/cuid2";
import { asc, eq, sql } from "drizzle-orm";
import {
  tags,
  ticketActivity,
  ticketAttachments,
  ticketComments,
  tickets,
  ticketTags,
  user,
} from "@/db/schema";
import { findOrCreateCustomer } from "@/lib/customers";
import { db, dbClient } from "@/lib/db";
import {
  htmlToRichTextJson,
  isRichTextEmpty,
  textToRichTextJson,
} from "@/lib/rich-text";
import { storage } from "@/lib/storage";
import { getOrCreateTagId, normalizeTagName } from "@/lib/tags";
import {
  getDefaultPriority,
  getDefaultStatus,
  getTicketCategories,
  getTicketPriorities,
  getTicketStatuses,
} from "@/lib/ticket-config";

// Host/dev runs load .env via `tsx --env-file=.env` (see package.json), which
// must happen before the first import: @/lib/db reads DATABASE_URL at module
// load, and ESM hoists imports above any top-level statement placed here.

// ── Config ──────────────────────────────────────────────────────────────────
const ZAMMAD_BASE_URL = (process.env.ZAMMAD_BASE_URL ?? "").replace(/\/+$/, "");
const ZAMMAD_API_TOKEN = process.env.ZAMMAD_API_TOKEN ?? "";
const DEFAULT_CATEGORY = process.env.MIGRATION_DEFAULT_CATEGORY ?? "issue";
const ZAMMAD_SEARCH = process.env.MIGRATION_ZAMMAD_SEARCH ?? "";
const PER_PAGE = Number(process.env.MIGRATION_PER_PAGE ?? "100") || 100;
const LIMIT = process.env.MIGRATION_LIMIT
  ? Number(process.env.MIGRATION_LIMIT)
  : null;
const DRY_RUN = process.env.MIGRATION_DRY_RUN === "1";
// Tag edits in Zammad don't reliably bump the ticket's own `updated_at`, so the
// cheap "unchanged since last sync" skip below can miss them. This ignores that
// check and re-reads every ticket — much slower, but catches everything.
const SYNC_FORCE =
  process.env.MIGRATION_SYNC_FORCE === "1" ||
  process.argv.includes("--sync-force");
// Re-sync mode. Without it a re-run only imports tickets that didn't exist last
// time: a ticket already in Docket is skipped whole, so a close, a new reply or
// a re-tag on the Zammad side never lands. With it, already-imported tickets are
// re-read and updated in place. Additive — a sync never deletes anything.
const SYNC =
  process.env.MIGRATION_SYNC === "1" ||
  process.argv.includes("--sync") ||
  SYNC_FORCE;

const CHECKPOINT_FILE = path.join(
  process.cwd(),
  "uploads",
  ".zammad-migration-state.json"
);

if (!(ZAMMAD_BASE_URL && ZAMMAD_API_TOKEN)) {
  console.error(
    "Missing ZAMMAD_BASE_URL and/or ZAMMAD_API_TOKEN. See the header of this file."
  );
  process.exit(1);
}

// ── Zammad REST client (global fetch) ─────────────────────────────────────────
const ZAMMAD_HEADERS = {
  Authorization: `Token token=${ZAMMAD_API_TOKEN}`,
  "Content-Type": "application/json",
};

async function zammadGet<T>(
  pathname: string,
  params?: Record<string, string | number>
): Promise<T> {
  const url = new URL(`${ZAMMAD_BASE_URL}/api/v1${pathname}`);
  for (const [k, v] of Object.entries(params ?? {})) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: ZAMMAD_HEADERS });
  if (!res.ok) {
    throw new Error(`Zammad GET ${pathname} → ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function zammadGetBinary(pathname: string): Promise<Buffer> {
  const res = await fetch(`${ZAMMAD_BASE_URL}/api/v1${pathname}`, {
    headers: { Authorization: ZAMMAD_HEADERS.Authorization },
  });
  if (!res.ok) {
    throw new Error(`Zammad GET ${pathname} → ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Zammad's tag API — GET only, like the rest of this script. Returns [] and
// logs rather than throwing: an old Zammad version or a token without tag read
// access shouldn't abort a migration over a non-essential field.
async function getZammadTags(ticketId: number): Promise<string[]> {
  try {
    const res = await zammadGet<{ tags?: string[] }>("/tags", {
      object: "Ticket",
      o_id: ticketId,
    });
    return res.tags ?? [];
  } catch (err) {
    console.warn(
      `    ! could not fetch tags for Zammad ticket ${ticketId}: ${(err as Error).message}`
    );
    return [];
  }
}

// ── Zammad shapes (only the fields we read) ───────────────────────────────────
interface ZUser {
  email?: string;
  firstname?: string;
  id: number;
  lastname?: string;
  login?: string;
}
interface ZTicket {
  close_at?: string | null;
  created_at: string;
  customer_id: number;
  id: number;
  number: string;
  // Assigned agent. Stock Zammad reserves id 1 for the "-" placeholder
  // owner (unassigned) — treated as null below, same as omitted/0.
  owner_id?: number;
  priority_id: number;
  state_id: number;
  title: string;
  updated_at: string;
}
interface ZAttachment {
  filename: string;
  id: number;
  preferences?: { "Content-Type"?: string };
  size?: string;
}
interface ZArticle {
  attachments?: ZAttachment[];
  body?: string;
  content_type?: string;
  created_at: string;
  created_by_id: number;
  from?: string;
  id: number;
  internal: boolean;
  sender_id: number;
  ticket_id: number;
}

// ── Caches / lookup maps built once from Zammad ───────────────────────────────
const userCache = new Map<number, ZUser>();
async function getZUser(id: number): Promise<ZUser | null> {
  if (!id) {
    return null;
  }
  const cached = userCache.get(id);
  if (cached) {
    return cached;
  }
  try {
    const u = await zammadGet<ZUser>(`/users/${id}`);
    userCache.set(id, u);
    return u;
  } catch {
    return null;
  }
}

// Zammad user id → Docket user id, by email. Null when there's no email or no
// matching account (typically migrate-zammad-users.ts hasn't run), in which
// case comments and attachments simply keep a null author.
const localUserIdByZammadUserId = new Map<number, string | null>();
async function resolveLocalAuthorId(
  zammadUserId: number
): Promise<string | null> {
  const cached = localUserIdByZammadUserId.get(zammadUserId);
  if (cached !== undefined) {
    return cached;
  }
  const zUser = await getZUser(zammadUserId);
  const email = (zUser?.email ?? "").trim().toLowerCase();
  let localId: string | null = null;
  if (email) {
    // lower() on both sides: Zammad and Better Auth don't agree on case, and
    // a case-mismatched agent email is exactly how an assignee silently
    // migrates as "Unassigned".
    const [row] = await db
      .select({ id: user.id })
      .from(user)
      .where(sql`lower(${user.email}) = ${email}`)
      .limit(1);
    localId = row?.id ?? null;
  }
  localUserIdByZammadUserId.set(zammadUserId, localId);
  return localId;
}

// Zammad owners (ticket assignees) with no Docket account at migration
// time — those tickets land unassigned until scripts/migrate-zammad-users.ts
// creates the accounts and backfills them. Reported in the summary.
const unlinkedOwners = new Set<string>();

function zUserName(u: ZUser | null): string {
  if (!u) {
    return "";
  }
  const name = `${u.firstname ?? ""} ${u.lastname ?? ""}`.trim();
  return name || u.email || u.login || "";
}

// Zammad "senders" (Agent / Customer / System) — id → name.
let senderNameById = new Map<number, string>();
async function loadSenders() {
  try {
    const rows = await zammadGet<Array<{ id: number; name: string }>>(
      "/ticket_article_senders"
    );
    senderNameById = new Map(rows.map((r) => [r.id, r.name]));
  } catch {
    // Fall back to the stock Zammad ids: 1 Agent, 2 Customer, 3 System.
    senderNameById = new Map([
      [1, "Agent"],
      [2, "Customer"],
      [3, "System"],
    ]);
  }
}

// Zammad state id → this app's status slug. Closed/merged → the closed slug,
// everything else → the default (open) slug.
let statusSlugByStateId = new Map<number, string>();
async function loadStateMap(openSlug: string, closedSlug: string) {
  try {
    const rows =
      await zammadGet<Array<{ id: number; name: string }>>("/ticket_states");
    statusSlugByStateId = new Map(
      rows.map((s) => [s.id, /clos|merg/i.test(s.name) ? closedSlug : openSlug])
    );
  } catch {
    // Stock Zammad: 4 = closed, 5 = merged.
    statusSlugByStateId = new Map([
      [4, closedSlug],
      [5, closedSlug],
    ]);
  }
}
function statusForState(stateId: number, openSlug: string): string {
  return statusSlugByStateId.get(stateId) ?? openSlug;
}

// Zammad priority id → this app's priority slug (matched by name).
let prioritySlugById = new Map<number, string>();
async function loadPriorityMap(validSlugs: Set<string>, defaultSlug: string) {
  const pick = (name: string): string => {
    const n = name.toLowerCase();
    if (/urgent|emergenc/.test(n) && validSlugs.has("urgent")) {
      return "urgent";
    }
    if (/high/.test(n) && validSlugs.has("high")) {
      return "high";
    }
    if (/low/.test(n) && validSlugs.has("low")) {
      return "low";
    }
    if (/normal|medium/.test(n) && validSlugs.has("normal")) {
      return "normal";
    }
    return defaultSlug;
  };
  try {
    const rows =
      await zammadGet<Array<{ id: number; name: string }>>(
        "/ticket_priorities"
      );
    prioritySlugById = new Map(rows.map((p) => [p.id, pick(p.name)]));
  } catch {
    prioritySlugById = new Map([
      [1, validSlugs.has("low") ? "low" : defaultSlug],
      [2, defaultSlug],
      [3, validSlugs.has("high") ? "high" : defaultSlug],
    ]);
  }
}
function priorityForId(id: number, defaultSlug: string): string {
  return prioritySlugById.get(id) ?? defaultSlug;
}

// ── Content conversion ────────────────────────────────────────────────────────
// Zammad article bodies are usually text/html; store them as the Tiptap JSON the
// app's editor produces. Empty bodies fall back to a caller-supplied
// placeholder, so notNull columns are satisfied.
function articleToRichText(article: ZArticle, fallbackPlain: string): string {
  const body = article.body ?? "";
  const isHtml = (article.content_type ?? "").toLowerCase().includes("html");
  let json = body.trim()
    ? isHtml
      ? htmlToRichTextJson(body)
      : textToRichTextJson(body)
    : "";
  if (!json || isRichTextEmpty(json)) {
    json = textToRichTextJson(fallbackPlain);
  }
  return json;
}

// ── Zammad ticket listing (paginated) ─────────────────────────────────────────
async function* iterateZammadTickets(): AsyncGenerator<ZTicket> {
  let page = 1;
  for (;;) {
    const batch = ZAMMAD_SEARCH
      ? await zammadGet<ZTicket[]>("/tickets/search", {
          query: ZAMMAD_SEARCH,
          page,
          per_page: PER_PAGE,
          sort_by: "created_at",
          order_by: "asc",
        })
      : await zammadGet<ZTicket[]>("/tickets", {
          page,
          per_page: PER_PAGE,
          sort_by: "created_at",
          order_by: "asc",
        });
    if (!Array.isArray(batch) || batch.length === 0) {
      return;
    }
    for (const t of batch) {
      yield t;
    }
    if (batch.length < PER_PAGE) {
      return;
    }
    page += 1;
  }
}

// ── Checkpoint (resume-after-crash cache; DB is the source of truth) ──────────
interface Checkpoint {
  done: Record<string, string>; // zammadTicketId → new ticketId
  failed: Record<string, string>; // zammadTicketId → error
}
async function loadCheckpoint(): Promise<Checkpoint> {
  try {
    const raw = await fs.readFile(CHECKPOINT_FILE, "utf8");
    return JSON.parse(raw) as Checkpoint;
  } catch {
    return { done: {}, failed: {} };
  }
}
async function saveCheckpoint(cp: Checkpoint): Promise<void> {
  if (DRY_RUN) {
    return;
  }
  await fs.mkdir(path.dirname(CHECKPOINT_FILE), { recursive: true });
  await fs.writeFile(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}
// Authoritative already-migrated set: every migrated ticket left a
// `zammad_migrated` activity row carrying its source Zammad id. That row is
// also where a re-sync keeps its bookkeeping — which Zammad articles are
// already comments here, and the ticket's Zammad `updated_at` as of the last
// run, so an untouched ticket costs zero extra requests next time.
interface MigratedRef {
  articleMap: Map<number, string | null>;
  markerId: string;
  metadata: Record<string, unknown>;
  ticketId: string;
  zammadUpdatedAt: string | null;
}

async function loadMigratedTickets(): Promise<Map<string, MigratedRef>> {
  const rows = await db
    .select({
      id: ticketActivity.id,
      metadata: ticketActivity.metadata,
      ticketId: ticketActivity.ticketId,
    })
    .from(ticketActivity)
    .where(eq(ticketActivity.action, "zammad_migrated"));

  const refs = new Map<string, MigratedRef>();
  for (const row of rows) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const zid = meta.zammadTicketId;
    if (zid == null) {
      continue;
    }
    // Absent on imports made before this script tracked the mapping — those
    // get it rebuilt from comment timestamps on their first sync.
    const rawMap = (meta.zammadArticleMap ?? {}) as Record<
      string,
      string | null
    >;
    const articleMap = new Map<number, string | null>();
    for (const [articleId, commentId] of Object.entries(rawMap)) {
      articleMap.set(Number(articleId), commentId);
    }
    refs.set(String(zid), {
      articleMap,
      markerId: row.id,
      metadata: meta,
      ticketId: row.ticketId,
      zammadUpdatedAt:
        typeof meta.zammadUpdatedAt === "string" ? meta.zammadUpdatedAt : null,
    });
  }
  return refs;
}

// ── Per-ticket migration ──────────────────────────────────────────────────────
interface StagedAttachment {
  commentId: string | null;
  createdAt: Date;
  filename: string;
  fileSize: number;
  id: string;
  mimeType: string;
  storageKey: string;
  ticketId: string;
  uploadedById: string | null;
  uploadedByName: string;
  uploadedByRole: string;
}

interface MigrationConfig {
  defaultPriority: string;
  openSlug: string;
  validCategory: string;
}

interface ArticleMeta {
  authorId: string | null;
  name: string;
  role: "customer" | "agent";
}

interface TicketContext {
  articles: ZArticle[];
  assignedAgentId: string | null;
  customerEmail: string;
  customerName: string;
  owner: ZUser | null;
  ownerEmail: string;
  roleFor: (article: ZArticle) => Promise<ArticleMeta>;
  tagNames: string[];
}

// Everything the first import and a later re-sync both need from Zammad about
// one ticket. Shared so the two paths can't drift on how a display name, the
// assignee or a tag is derived — a mismatch there would show up as duplicated
// replies or a flip-flopping assignee on every sync.
async function loadTicketContext(zTicket: ZTicket): Promise<TicketContext> {
  // Articles = the whole conversation, oldest first.
  const articles = (
    await zammadGet<ZArticle[]>(`/ticket_articles/by_ticket/${zTicket.id}`)
  )
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  // Normalized and deduped up front: the tag pool is case-insensitive, so
  // "Billing" and "billing" resolve to one row — and ticket_tags' UNIQUE
  // (ticket_id, tag_id) would fail the whole transaction on a duplicate.
  const tagNames = [
    ...new Set((await getZammadTags(zTicket.id)).map(normalizeTagName)),
  ].filter(Boolean);

  // Customer identity lives inline on the ticket.
  const customer = await getZUser(zTicket.customer_id);
  const customerEmail = (customer?.email ?? "").trim();
  const customerName =
    zUserName(customer) || customerEmail.split("@")[0] || "Customer";

  // Assignee — same email lookup as comment authors, so it resolves only if
  // migrate-zammad-users.ts already made the account. Otherwise the ticket lands
  // unassigned and the owner on the `zammad_migrated` row lets a later run fix it.
  const owner =
    zTicket.owner_id && zTicket.owner_id > 1
      ? await getZUser(zTicket.owner_id)
      : null;
  const ownerEmail = (owner?.email ?? "").trim().toLowerCase();
  const assignedAgentId = owner ? await resolveLocalAuthorId(owner.id) : null;
  if (owner && !assignedAgentId) {
    unlinkedOwners.add(ownerEmail || zUserName(owner) || `id ${owner.id}`);
  }

  // Display role/name/local-user-id for an article. authorId is non-null only
  // once migrate-zammad-users.ts has created a matching account — run it FIRST
  // so replies link directly rather than via its name-matching backfill.
  const roleFor = async (article: ZArticle): Promise<ArticleMeta> => {
    const senderName = senderNameById.get(article.sender_id) ?? "Agent";
    if (senderName === "Customer") {
      return { role: "customer", name: customerName, authorId: null };
    }
    const author = await getZUser(article.created_by_id);
    const name =
      zUserName(author) ||
      (article.from ?? "").replace(/<[^>]*>/g, "").trim() ||
      "Support Agent";
    const authorId = await resolveLocalAuthorId(article.created_by_id);
    return { role: "agent", name, authorId };
  };

  return {
    articles,
    assignedAgentId,
    customerEmail,
    customerName,
    owner,
    ownerEmail,
    roleFor,
    tagNames,
  };
}

// The ticket columns that are a pure function of the Zammad ticket, so the sync
// path can recompute exactly what the import path wrote and diff against it.
function derivedTicketFields(zTicket: ZTicket, cfg: MigrationConfig) {
  const status = statusForState(zTicket.state_id, cfg.openSlug);
  const isClosed = status !== cfg.openSlug; // openSlug is the only non-closed default
  const lastActivityAt = new Date(zTicket.updated_at ?? zTicket.created_at);
  return {
    closedAt: zTicket.close_at
      ? new Date(zTicket.close_at)
      : isClosed
        ? lastActivityAt
        : null,
    lastActivityAt,
    priority: priorityForId(zTicket.priority_id, cfg.defaultPriority),
    status,
    subject: zTicket.title || "(no subject)",
  };
}

// Rebuilds the awaiting-reply bookkeeping the app maintains on every reply,
// from the whole thread: the opening message counts as the first customer
// message, and only PUBLIC messages move the counter — an agent's public reply
// resets it. Recomputed rather than incremented, so a sync converges on the
// same numbers a fresh import of the same ticket would produce.
async function computePendingReplies(
  articles: ZArticle[],
  roleFor: (article: ZArticle) => Promise<ArticleMeta>
): Promise<{ awaitingReply: boolean; pendingReplies: number }> {
  let pending = 0;
  for (const [index, article] of articles.entries()) {
    const meta = await roleFor(article);
    if (index === 0) {
      pending = meta.role === "customer" ? 1 : 0;
      continue;
    }
    if (!article.internal) {
      pending = meta.role === "customer" ? pending + 1 : 0;
    }
  }
  return { awaitingReply: pending > 0, pendingReplies: pending };
}

// What goes on the ticket's `zammad_migrated` row: the audit trail of where the
// ticket came from, plus everything the next sync run needs to tell new Zammad
// activity from what it already copied.
function markerMetadata(
  zTicket: ZTicket,
  ctx: TicketContext,
  articleMap: Map<number, string | null>
): Record<string, unknown> {
  return {
    zammadTicketId: zTicket.id,
    zammadNumber: zTicket.number,
    // Owner identity, always recorded (null = no owner in Zammad) even
    // when already resolved locally: migrate-zammad-users.ts's assignee
    // backfill matches on it, and skips a Zammad round-trip when present.
    zammadOwnerId: ctx.owner?.id ?? null,
    zammadOwnerEmail: ctx.ownerEmail || null,
    zammadOwnerName: ctx.owner ? zUserName(ctx.owner) || null : null,
    // Sync bookkeeping. `zammadUpdatedAt` is compared against the ticket in the
    // listing to skip untouched tickets without fetching anything else;
    // `zammadArticleMap` (article id → comment id, null = the opening article,
    // which became the description) is how a re-sync appends only new replies.
    zammadUpdatedAt: zTicket.updated_at ?? null,
    zammadArticleMap: Object.fromEntries(
      [...articleMap].map(([articleId, commentId]) => [
        String(articleId),
        commentId,
      ])
    ),
    lastSyncedAt: new Date().toISOString(),
  };
}

async function migrateOneTicket(
  zTicket: ZTicket,
  cfg: MigrationConfig
): Promise<{
  ticketId: string;
  comments: number;
  attachments: number;
  tags: number;
}> {
  const ticketId = createId();
  const ctx = await loadTicketContext(zTicket);
  const { articles } = ctx;

  const opening = articles[0];
  const rest = articles.slice(1);

  const descriptionPlainFallback = zTicket.title || "(no content)";
  const description = opening
    ? articleToRichText(opening, descriptionPlainFallback)
    : textToRichTextJson(descriptionPlainFallback);

  const openingMeta = opening
    ? await ctx.roleFor(opening)
    : { role: "customer" as const, name: ctx.customerName, authorId: null };

  // Zammad article id → the row it became here, recorded for later syncs. The
  // opening article maps to null: it is the description, not a comment.
  const articleMap = new Map<number, string | null>();
  if (opening) {
    articleMap.set(opening.id, null);
  }

  const commentRows: Array<typeof ticketComments.$inferInsert> = [];

  // Mirrors the activity rows the live app writes on creation and every reply.
  // Without them the ticket list's "Updated By" column — which reads the latest
  // agent ticketActivity row — is blank for migrated tickets.
  const activityRows: Array<typeof ticketActivity.$inferInsert> = [
    {
      id: createId(),
      ticketId,
      actorId: openingMeta.authorId,
      actorName: openingMeta.name,
      actorRole: openingMeta.role,
      action: "ticket_created",
      createdAt: new Date(zTicket.created_at),
    },
  ];

  const stagedAttachments: StagedAttachment[] = [];

  // Opening-message attachments belong to the ticket, not to a comment
  // (comment_id IS NULL) — matching how the app models the opening message.
  if (opening?.attachments?.length) {
    for (const att of opening.attachments) {
      const staged = await stageAttachment(
        ticketId,
        null,
        opening,
        att,
        openingMeta
      );
      if (staged) {
        stagedAttachments.push(staged);
      }
    }
  }

  for (const article of rest) {
    const meta = await ctx.roleFor(article);
    const content = articleToRichText(article, "(no content)");

    // Drop empty, non-internal system chatter (e.g. Zammad state-change notes
    // with no body) — they'd show as blank bubbles.
    if (isRichTextEmpty(content) && !article.internal) {
      continue;
    }

    const commentId = createId();
    articleMap.set(article.id, commentId);
    commentRows.push({
      id: commentId,
      ticketId,
      authorId: meta.authorId,
      authorName: meta.name,
      authorRole: meta.role,
      content,
      isInternal: article.internal,
      createdAt: new Date(article.created_at),
      updatedAt: new Date(article.created_at),
    });
    activityRows.push({
      id: createId(),
      ticketId,
      actorId: meta.authorId,
      actorName: meta.name,
      actorRole: meta.role,
      action: article.internal ? "internal_note_added" : "comment_added",
      createdAt: new Date(article.created_at),
    });

    if (article.attachments?.length) {
      for (const att of article.attachments) {
        const staged = await stageAttachment(
          ticketId,
          commentId,
          article,
          att,
          meta
        );
        if (staged) {
          stagedAttachments.push(staged);
        }
      }
    }
  }

  const createdAt = new Date(zTicket.created_at);
  const derived = derivedTicketFields(zTicket, cfg);
  const { awaitingReply, pendingReplies } = await computePendingReplies(
    articles,
    ctx.roleFor
  );

  if (DRY_RUN) {
    console.log(
      `  [dry-run] would import Zammad #${zTicket.number} → "${zTicket.title}" ` +
        `(${ctx.customerEmail || "no-email"}, ${derived.status}, assignee: ${ctx.assignedAgentId ?? "none"}, ` +
        `${commentRows.length} comments, ${stagedAttachments.length} attachments, ${ctx.tagNames.length} tags)`
    );
    // Roll back the files we uploaded while staging during a dry run.
    for (const a of stagedAttachments) {
      await storage.delete(a.storageKey).catch(() => undefined);
    }
    return {
      ticketId,
      comments: commentRows.length,
      attachments: stagedAttachments.length,
      tags: ctx.tagNames.length,
    };
  }

  // Tags and customer are resolved BEFORE the ticket's transaction, never inside
  // it: they write through the global `db` handle, so from inside tx they'd hit a
  // different pooled connection — invisible to it, and able to deadlock.
  const tagIds = await Promise.all(ctx.tagNames.map(getOrCreateTagId));
  const customerRecord = await findOrCreateCustomer(
    ctx.customerName,
    ctx.customerEmail || "unknown@migrated.local"
  );

  try {
    await db.transaction(async (tx) => {
      await tx.insert(tickets).values({
        id: ticketId,
        subject: derived.subject,
        description,
        category: cfg.validCategory,
        status: derived.status,
        priority: derived.priority,
        customerId: customerRecord.id,
        customerToken: createId(),
        assignedAgentId: ctx.assignedAgentId,
        source: "portal",
        awaitingReply,
        pendingReplies,
        closedAt: derived.closedAt,
        createdAt,
        updatedAt: derived.lastActivityAt,
      });

      if (commentRows.length > 0) {
        await tx.insert(ticketComments).values(commentRows);
      }
      if (stagedAttachments.length > 0) {
        await tx.insert(ticketAttachments).values(
          stagedAttachments.map((a) => ({
            id: a.id,
            ticketId: a.ticketId,
            commentId: a.commentId,
            filename: a.filename,
            storageKey: a.storageKey,
            fileSize: a.fileSize,
            mimeType: a.mimeType,
            uploadedById: a.uploadedById,
            uploadedByName: a.uploadedByName,
            uploadedByRole: a.uploadedByRole,
            createdAt: a.createdAt,
          }))
        );
      }

      if (tagIds.length > 0) {
        await tx.insert(ticketTags).values(
          tagIds.map((tagId) => ({
            id: createId(),
            ticketId,
            tagId,
            // Same as every other row here: keep the ticket's own date rather
            // than defaulting to now(), so the import carries no "today" stamps.
            createdAt,
          }))
        );
      }

      // Reconstructed creation/reply activity trail (see activityRows above)
      // + the idempotency marker + audit trail of where this ticket came from.
      await tx.insert(ticketActivity).values([
        ...activityRows,
        {
          id: createId(),
          ticketId,
          actorId: null,
          actorName: "Zammad Migration",
          actorRole: "system",
          action: "zammad_migrated",
          metadata: markerMetadata(zTicket, ctx, articleMap),
          createdAt,
        },
      ]);
    });
  } catch (err) {
    // Insert failed — remove the files we already uploaded for this ticket.
    for (const a of stagedAttachments) {
      await storage.delete(a.storageKey).catch(() => undefined);
    }
    throw err;
  }

  return {
    ticketId,
    comments: commentRows.length,
    attachments: stagedAttachments.length,
    tags: tagIds.length,
  };
}

// ── Re-sync of an already-imported ticket (MIGRATION_SYNC=1) ──────────────────

// Reconstruct "Zammad article id → the row it became" for a ticket imported
// before that map was recorded. The import copies each article's created_at
// verbatim onto its comment, so this is exact equality, not a heuristic:
// articles[0] became the description, the rest became comments in order.
async function rebuildArticleMap(
  ticketId: string,
  articles: ZArticle[]
): Promise<Map<number, string | null>> {
  const rows = await db
    .select({ id: ticketComments.id, createdAt: ticketComments.createdAt })
    .from(ticketComments)
    .where(eq(ticketComments.ticketId, ticketId))
    .orderBy(asc(ticketComments.createdAt));

  // Bucketed rather than a flat map: two articles can share a timestamp, and
  // each must claim a different comment row.
  const byTimestamp = new Map<number, string[]>();
  for (const row of rows) {
    const key = row.createdAt.getTime();
    const bucket = byTimestamp.get(key);
    if (bucket) {
      bucket.push(row.id);
    } else {
      byTimestamp.set(key, [row.id]);
    }
  }

  const map = new Map<number, string | null>();
  articles.forEach((article, index) => {
    if (index === 0) {
      map.set(article.id, null);
      return;
    }
    const commentId = byTimestamp
      .get(new Date(article.created_at).getTime())
      ?.shift();
    if (commentId) {
      map.set(article.id, commentId);
    }
    // Unmatched → treated as new below. Correct for an article added after the
    // import; a reply deleted inside Docket also comes back, which is the right
    // call for what is a one-way mirror of Zammad.
  });
  return map;
}

// Attachment identity across the two systems: Zammad's attachment ids aren't
// recorded on our rows, so a file already copied is recognised by
// (comment, filename). Counted rather than set-tested, so an article carrying
// the same filename twice doesn't collapse into one.
async function buildAttachmentClaimer(
  ticketId: string
): Promise<(commentId: string | null, filename: string) => boolean> {
  const rows = await db
    .select({
      commentId: ticketAttachments.commentId,
      filename: ticketAttachments.filename,
    })
    .from(ticketAttachments)
    .where(eq(ticketAttachments.ticketId, ticketId));

  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.commentId ?? ""}|${row.filename}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return (commentId, filename) => {
    const key = `${commentId ?? ""}|${filename}`;
    const remaining = counts.get(key) ?? 0;
    if (remaining <= 0) {
      return false;
    }
    counts.set(key, remaining - 1);
    return true;
  };
}

// Bring an already-imported ticket up to date with Zammad: append the articles
// added since the last run, and refresh the fields Zammad owns (status,
// priority, subject, assignee, tags, awaiting-reply). Additive only — nothing
// is deleted here, so an agent's own work inside Docket survives a sync.
async function syncOneTicket(
  zTicket: ZTicket,
  ref: MigratedRef,
  cfg: MigrationConfig
): Promise<{
  attachments: number;
  changes: string[];
  comments: number;
  tags: number;
}> {
  const ticketId = ref.ticketId;

  const [current] = await db
    .select({
      assignedAgentId: tickets.assignedAgentId,
      awaitingReply: tickets.awaitingReply,
      closedAt: tickets.closedAt,
      description: tickets.description,
      pendingReplies: tickets.pendingReplies,
      priority: tickets.priority,
      status: tickets.status,
      subject: tickets.subject,
    })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  if (!current) {
    throw new Error(`ticket ${ticketId} named by its marker no longer exists`);
  }

  const ctx = await loadTicketContext(zTicket);
  const { articles } = ctx;
  const articleMap =
    ref.articleMap.size > 0
      ? new Map(ref.articleMap)
      : await rebuildArticleMap(ticketId, articles);

  const changes: string[] = [];
  const newComments: Array<typeof ticketComments.$inferInsert> = [];
  const newActivity: Array<typeof ticketActivity.$inferInsert> = [];
  const stagedAttachments: StagedAttachment[] = [];
  const claimExistingAttachment = await buildAttachmentClaimer(ticketId);

  for (const [index, article] of articles.entries()) {
    const known = articleMap.has(article.id);
    const meta = await ctx.roleFor(article);
    let commentId = articleMap.get(article.id) ?? null;

    if (!known) {
      const content = articleToRichText(article, "(no content)");
      // Same rule as the import path, so a synced thread matches a re-imported
      // one. index 0 can only be unknown on a ticket that had no articles at
      // import time — it belongs to the description, not to a comment.
      if (index > 0 && !(isRichTextEmpty(content) && !article.internal)) {
        commentId = createId();
        newComments.push({
          id: commentId,
          ticketId,
          authorId: meta.authorId,
          authorName: meta.name,
          authorRole: meta.role,
          content,
          isInternal: article.internal,
          createdAt: new Date(article.created_at),
          updatedAt: new Date(article.created_at),
        });
        newActivity.push({
          id: createId(),
          ticketId,
          actorId: meta.authorId,
          actorName: meta.name,
          actorRole: meta.role,
          action: article.internal ? "internal_note_added" : "comment_added",
          createdAt: new Date(article.created_at),
        });
      }
      articleMap.set(article.id, commentId);
    }

    // For a brand-new article every attachment is new. For one already
    // imported, only files added to it in Zammad afterwards are.
    for (const att of article.attachments ?? []) {
      if (known && claimExistingAttachment(commentId, att.filename)) {
        continue;
      }
      const staged = await stageAttachment(
        ticketId,
        commentId,
        article,
        att,
        meta
      );
      if (staged) {
        stagedAttachments.push(staged);
      }
    }
  }

  const derived = derivedTicketFields(zTicket, cfg);
  const { awaitingReply, pendingReplies } = await computePendingReplies(
    articles,
    ctx.roleFor
  );
  const description = articles[0]
    ? articleToRichText(articles[0], zTicket.title || "(no content)")
    : current.description;

  const update: Partial<typeof tickets.$inferInsert> = {};
  if (derived.subject !== current.subject) {
    update.subject = derived.subject;
    changes.push("subject");
  }
  if (derived.status !== current.status) {
    update.status = derived.status;
    changes.push(`status ${current.status} → ${derived.status}`);
  }
  if (derived.priority !== current.priority) {
    update.priority = derived.priority;
    changes.push(`priority ${current.priority} → ${derived.priority}`);
  }
  if (description !== current.description) {
    update.description = description;
    changes.push("description");
  }
  if (
    (derived.closedAt?.getTime() ?? null) !==
    (current.closedAt?.getTime() ?? null)
  ) {
    // Not reported on its own — it moves with `status`, which already is.
    update.closedAt = derived.closedAt;
  }
  if (
    awaitingReply !== current.awaitingReply ||
    pendingReplies !== current.pendingReplies
  ) {
    update.awaitingReply = awaitingReply;
    update.pendingReplies = pendingReplies;
  }

  // Assignee: adopt Zammad's owner whenever we can resolve them. The reverse —
  // clearing — only mirrors an un-assign in Zammad when the current assignee is
  // the owner this import last recorded, so an assignment made inside Docket is
  // never wiped by a sync.
  let nextAssignee = current.assignedAgentId;
  if (ctx.assignedAgentId) {
    nextAssignee = ctx.assignedAgentId;
  } else if (!ctx.owner && current.assignedAgentId) {
    const previousOwnerId =
      typeof ref.metadata.zammadOwnerId === "number"
        ? ref.metadata.zammadOwnerId
        : null;
    const previousLocalId = previousOwnerId
      ? await resolveLocalAuthorId(previousOwnerId)
      : null;
    if (previousLocalId && previousLocalId === current.assignedAgentId) {
      nextAssignee = null;
    }
  }
  if (nextAssignee !== current.assignedAgentId) {
    update.assignedAgentId = nextAssignee;
    changes.push("assignee");
  }

  // Tags are add-only: a tag removed in Zammad stays here, because agents can
  // also tag a ticket inside Docket and there's no way to tell the two apart.
  const existingTagNames = new Set(
    (
      await db
        .select({ name: tags.name })
        .from(ticketTags)
        .innerJoin(tags, eq(ticketTags.tagId, tags.id))
        .where(eq(ticketTags.ticketId, ticketId))
    ).map((row) => row.name)
  );
  const missingTagNames = ctx.tagNames.filter(
    (name) => !existingTagNames.has(name)
  );

  if (newComments.length > 0) {
    changes.push(`+${newComments.length} comment(s)`);
  }
  if (stagedAttachments.length > 0) {
    changes.push(`+${stagedAttachments.length} attachment(s)`);
  }
  if (missingTagNames.length > 0) {
    changes.push(`+${missingTagNames.length} tag(s)`);
  }
  // Catch-all for the fields reported silently above (closed date, the
  // awaiting-reply pair) so a ticket that really was written never gets
  // counted as unchanged in the summary.
  if (changes.length === 0 && Object.keys(update).length > 0) {
    changes.push("state");
  }
  if (changes.length > 0) {
    update.updatedAt = derived.lastActivityAt;
  }

  if (DRY_RUN) {
    if (changes.length > 0) {
      console.log(
        `  [dry-run] would update #${zTicket.number} → ${ticketId}: ${changes.join(", ")}`
      );
    }
    return {
      attachments: stagedAttachments.length,
      changes,
      comments: newComments.length,
      tags: missingTagNames.length,
    };
  }

  // Resolved outside the transaction for the same reason as the import path:
  // getOrCreateTagId writes through the global `db` handle.
  const tagIds = await Promise.all(missingTagNames.map(getOrCreateTagId));

  try {
    await db.transaction(async (tx) => {
      if (newComments.length > 0) {
        await tx.insert(ticketComments).values(newComments);
      }
      if (stagedAttachments.length > 0) {
        await tx.insert(ticketAttachments).values(
          stagedAttachments.map((a) => ({
            id: a.id,
            ticketId: a.ticketId,
            commentId: a.commentId,
            filename: a.filename,
            storageKey: a.storageKey,
            fileSize: a.fileSize,
            mimeType: a.mimeType,
            uploadedById: a.uploadedById,
            uploadedByName: a.uploadedByName,
            uploadedByRole: a.uploadedByRole,
            createdAt: a.createdAt,
          }))
        );
      }
      if (newActivity.length > 0) {
        await tx.insert(ticketActivity).values(newActivity);
      }
      if (tagIds.length > 0) {
        await tx
          .insert(ticketTags)
          .values(
            tagIds.map((tagId) => ({
              id: createId(),
              ticketId,
              tagId,
              createdAt: derived.lastActivityAt,
            }))
          )
          .onConflictDoNothing();
      }
      if (Object.keys(update).length > 0) {
        await tx.update(tickets).set(update).where(eq(tickets.id, ticketId));
      }
      // Always rewritten, even for a ticket that turned out unchanged: it
      // stamps the Zammad `updated_at` we just verified, which is what lets the
      // next run skip this ticket without fetching its articles at all.
      await tx
        .update(ticketActivity)
        .set({ metadata: markerMetadata(zTicket, ctx, articleMap) })
        .where(eq(ticketActivity.id, ref.markerId));
    });
  } catch (err) {
    for (const a of stagedAttachments) {
      await storage.delete(a.storageKey).catch(() => undefined);
    }
    throw err;
  }

  return {
    attachments: stagedAttachments.length,
    changes,
    comments: newComments.length,
    tags: tagIds.length,
  };
}

// Download a Zammad attachment and store it under this ticket's prefix,
// returning a DB-ready row. Returns null (and logs) on any download failure so
// a single bad attachment never aborts the whole ticket.
async function stageAttachment(
  ticketId: string,
  commentId: string | null,
  article: ZArticle,
  att: ZAttachment,
  by: { role: "customer" | "agent"; name: string; authorId: string | null }
): Promise<StagedAttachment | null> {
  try {
    const buffer = await zammadGetBinary(
      `/ticket_attachment/${article.ticket_id}/${article.id}/${att.id}`
    );
    if (buffer.length === 0) {
      return null;
    }
    const mimeType = (
      att.preferences?.["Content-Type"] ?? "application/octet-stream"
    )
      .split(";")[0]
      .trim();
    const ext = att.filename.includes(".")
      ? att.filename.split(".").pop()
      : "bin";
    const storageKey = `tickets/${ticketId}/${createId()}.${ext}`;

    if (!DRY_RUN) {
      await storage.upload(storageKey, buffer, mimeType);
    }

    return {
      id: createId(),
      ticketId,
      commentId,
      filename: att.filename,
      storageKey,
      fileSize: buffer.length,
      mimeType,
      uploadedById: by.authorId,
      uploadedByName: by.name,
      uploadedByRole: by.role,
      createdAt: new Date(article.created_at),
    };
  } catch (err) {
    console.warn(
      `    ! skipped attachment "${att.filename}" on Zammad article ${article.id}: ${(err as Error).message}`
    );
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(
    `\nZammad → Docket migration${DRY_RUN ? " (DRY RUN — no writes)" : ""}`
  );
  console.log(`  source:   ${ZAMMAD_BASE_URL}`);
  console.log(
    `  mode:     ${
      SYNC
        ? `re-sync — updates already-imported tickets${SYNC_FORCE ? " (forced)" : ""}`
        : "import-only — already-imported tickets are left untouched"
    }`
  );
  console.log(
    `  filter:   ${ZAMMAD_SEARCH ? `search "${ZAMMAD_SEARCH}"` : "ALL tickets"}`
  );
  if (LIMIT == null) {
    console.log("");
  } else {
    console.log(`  limit:    first ${LIMIT} ticket(s) seen (oldest-first)\n`);
  }

  // Resolve this app's config → the slugs we'll map Zammad values onto.
  const [statuses, priorities, categories, defaultStatus, defaultPriority] =
    await Promise.all([
      getTicketStatuses(),
      getTicketPriorities(),
      getTicketCategories(),
      getDefaultStatus(),
      getDefaultPriority(),
    ]);

  const openSlug = defaultStatus?.slug ?? "open";
  const closedSlug = statuses.find((s) => s.isClosedState)?.slug ?? "closed";
  const defaultPrioritySlug = defaultPriority?.slug ?? "normal";
  const prioritySlugs = new Set(priorities.map((p) => p.slug));

  const categorySlugs = new Set(categories.map((c) => c.slug));
  const validCategory = categorySlugs.has(DEFAULT_CATEGORY)
    ? DEFAULT_CATEGORY
    : (categories[0]?.slug ?? "issue");
  if (validCategory !== DEFAULT_CATEGORY) {
    console.warn(
      `  ⚠ category "${DEFAULT_CATEGORY}" not found — using "${validCategory}" instead.\n`
    );
  }

  await Promise.all([
    loadSenders(),
    loadStateMap(openSlug, closedSlug),
    loadPriorityMap(prioritySlugs, defaultPrioritySlug),
  ]);

  const checkpoint = await loadCheckpoint();
  const migratedRefs = await loadMigratedTickets();
  // Ids in the checkpoint but with no marker row (a crash between the two, or a
  // ticket deleted here since) still count as done, but can't be synced —
  // there's nothing to sync against.
  const checkpointOnly = new Set(
    Object.keys(checkpoint.done).filter((id) => !migratedRefs.has(id))
  );

  const cfg: MigrationConfig = {
    defaultPriority: defaultPrioritySlug,
    openSlug,
    validCategory,
  };

  let seen = 0;
  let migrated = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;
  let totalComments = 0;
  let totalAttachments = 0;
  let totalTags = 0;

  for await (const zTicket of iterateZammadTickets()) {
    if (LIMIT != null && seen >= LIMIT) {
      break;
    }
    seen += 1;
    const zid = String(zTicket.id);
    const ref = migratedRefs.get(zid);

    if (ref || checkpointOnly.has(zid)) {
      // Already here. Without --sync that's the end of it: this is the mode
      // that made a second run import only tickets created since the first,
      // and silently ignore everything that changed on the ones before them.
      if (!(SYNC && ref)) {
        skipped += 1;
        continue;
      }
      // Zammad's own updated_at hasn't moved since the last sync, so there is
      // nothing to fetch for this ticket at all — the listing already told us.
      if (
        !SYNC_FORCE &&
        ref.zammadUpdatedAt &&
        ref.zammadUpdatedAt === zTicket.updated_at
      ) {
        unchanged += 1;
        continue;
      }
      try {
        const result = await syncOneTicket(zTicket, ref, cfg);
        totalComments += result.comments;
        totalAttachments += result.attachments;
        totalTags += result.tags;
        if (result.changes.length === 0) {
          unchanged += 1;
        } else {
          updated += 1;
          if (!DRY_RUN) {
            console.log(
              `  ↻ #${zTicket.number} → ${ref.ticketId} (${result.changes.join(", ")})`
            );
          }
        }
        delete checkpoint.failed[zid];
      } catch (err) {
        failed += 1;
        checkpoint.failed[zid] = (err as Error).message;
        console.error(
          `  ✗ sync #${zTicket.number} (Zammad id ${zid}): ${(err as Error).message}`
        );
      }
      await saveCheckpoint(checkpoint);
      continue;
    }

    try {
      const result = await migrateOneTicket(zTicket, cfg);
      migrated += 1;
      totalComments += result.comments;
      totalAttachments += result.attachments;
      totalTags += result.tags;
      checkpoint.done[zid] = result.ticketId;
      delete checkpoint.failed[zid];
      if (!DRY_RUN) {
        console.log(
          `  ✓ #${zTicket.number} → ${result.ticketId} ` +
            `(${result.comments} comments, ${result.attachments} attachments, ${result.tags} tags)`
        );
      }
    } catch (err) {
      failed += 1;
      checkpoint.failed[zid] = (err as Error).message;
      console.error(
        `  ✗ #${zTicket.number} (Zammad id ${zid}): ${(err as Error).message}`
      );
    }

    // Persist progress every ticket so a crash resumes almost exactly.
    await saveCheckpoint(checkpoint);
  }

  console.log("\n──────── Summary ────────");
  console.log(`  Zammad tickets seen:   ${seen}`);
  console.log(`  imported (new):        ${migrated}`);
  if (SYNC) {
    console.log(`  updated (re-synced):   ${updated}`);
    console.log(`  already up to date:    ${unchanged}`);
  }
  console.log(`  skipped (already done):${skipped}`);
  console.log(`  failed:                ${failed}`);
  console.log(`  comments imported:     ${totalComments}`);
  console.log(`  attachments imported:  ${totalAttachments}`);
  console.log(`  tags imported:         ${totalTags}`);
  if (!SYNC && skipped > 0) {
    console.log(
      `\n  ${skipped} ticket(s) were already imported and left untouched — anything that\n` +
        "  changed on them in Zammad since (replies, a close, priority/assignee/tag edits)\n" +
        "  was NOT picked up. Re-run with `--sync` (or MIGRATION_SYNC=1) to pull those in."
    );
  }
  if (unlinkedOwners.size > 0) {
    console.log(
      `\n  ${unlinkedOwners.size} Zammad assignee(s) had no Docket account, so those ` +
        "tickets imported as Unassigned:\n" +
        [...unlinkedOwners].map((o) => `    - ${o}`).join("\n") +
        "\n  Run `pnpm migrate:zammad:users` — it creates the accounts and backfills the assignee."
    );
  }
  if (failed > 0) {
    console.log(
      `\n  ${failed} ticket(s) failed — see ${CHECKPOINT_FILE} (.failed). Re-run to retry only those.`
    );
  }
  console.log("");
}

main()
  .then(async () => {
    await dbClient.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("\nMigration aborted:", err);
    await dbClient.end().catch(() => undefined);
    process.exit(1);
  });

// Runnable commands (dry run first, then the real one) are in
// docs/deployment-and-zammad-migration.md §7.1–7.3 — kept there rather than
// duplicated here so there is one copy to keep correct.
