import { createId } from "@paralleldrive/cuid2";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "@/db/schema/auth";
import { oauthConsent } from "@/db/schema/oauth";
import { tickets } from "@/db/schema/tickets";

export const mcpToolCallStatus = pgEnum("mcp_tool_call_status", [
  "pending",
  "succeeded",
  "failed",
]);

// Personal access tokens for the MCP endpoint — a credential tied to one agent
// or admin user. Like api_keys, the raw token is shown once at creation and never
// stored; only a sha256 hash (lookup) and a short prefix (display) persist. Rows
// are revoked (revoked_at/revoked_reason), never deleted, so the history stays;
// they only disappear with the user (cascade). A trigger on "user" revokes a
// user's tokens when they are banned or leave the agent/admin roles (see the
// 0017 migration).
export const mcpAccessTokens = pgTable(
  "mcp_access_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    // Granted scopes. The effective scopes are re-intersected with the owner's
    // current role ceiling on every use, so a demotion narrows a token at once.
    scopes: text("scopes").array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("mcp_access_tokens_user_idx").on(t.userId)]
);

// Operational trace of MCP tool calls, also the idempotency / per-ticket lock
// ledger for write tools. Rows hold NO message bodies or tool arguments — only
// keyed HMACs of them (args_hmac, body_hmac) — and are meant to be pruned after
// 30 days.
export const mcpToolCalls = pgTable(
  "mcp_tool_calls",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    requestId: text("request_id").notNull(),
    // set null (not cascade): the trace survives account erasure. No name or
    // email is snapshotted here, so anonymizeUserContent has nothing to scrub.
    userId: text("user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    authMethod: text("auth_method").notNull(),
    // Deliberately NO foreign key: the credential may be an access token today
    // and something else (e.g. an OAuth grant) later, and the trace must outlive
    // either.
    credentialId: text("credential_id"),
    tool: text("tool").notNull(),
    clientRequestId: text("client_request_id"),
    status: mcpToolCallStatus("status").notNull(),
    errorCode: text("error_code"),
    argsHmac: text("args_hmac"),
    plannedEntityId: text("planned_entity_id"),
    lockGroup: text("lock_group"),
    targetTicketId: text("target_ticket_id"),
    targetCustomerId: text("target_customer_id"),
    bodyHmac: text("body_hmac"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(1),
    resultJson: jsonb("result_json"),
    sideEffectsUncertain: boolean("side_effects_uncertain")
      .notNull()
      .default(false),
    // Null = no notification errors.
    notificationErrors: text("notification_errors").array(),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One recorded outcome per (user, tool, client-supplied request id).
    uniqueIndex("mcp_tool_calls_idempotency_idx")
      .on(t.userId, t.tool, t.clientRequestId)
      .where(sql`${t.clientRequestId} IS NOT NULL`),
    // At most one in-flight (pending) call per lock group and ticket.
    uniqueIndex("mcp_tool_calls_ticket_lock_idx")
      .on(t.lockGroup, t.targetTicketId)
      .where(sql`${t.status} = 'pending' AND ${t.lockGroup} IS NOT NULL`),
    index("mcp_tool_calls_created_at_idx").on(t.createdAt),
    index("mcp_tool_calls_user_idx").on(t.userId),
  ]
);

export const mcpPendingActionKind = pgEnum("mcp_pending_action_kind", [
  "close",
  "reply",
]);

export const mcpPendingActionStatus = pgEnum("mcp_pending_action_status", [
  "pending",
  "approved",
  "dismissed",
  "expired",
  "cancelled",
  "failed",
]);

// A request an MCP client made that only its token owner can carry out, because
// it reaches the customer (closing a ticket sends the close email, a reply
// sends the reply email). The client creates a `pending` row; the owner then
// approves or dismisses it in Docket, and an approval runs the same service the
// UI runs, as the owner. The partial unique index allows one pending close and
// one pending reply per ticket per person. A trigger cancels the pending rows of
// a token the moment it is revoked (see the 0018 migration).
//
// Customers never see this table: the customer portal and the v1 API do not
// read it. `payload.content` (a reply's Tiptap JSON) is shown only to the owner
// and never copied into audit rows, notifications or push messages.
export const mcpPendingActions = pgTable(
  "mcp_pending_actions",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    kind: mcpPendingActionKind("kind").notNull(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    // The token owner, and the only person who may approve or dismiss.
    requestedById: text("requested_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").references(() => mcpAccessTokens.id, {
      onDelete: "set null",
    }),
    // The OAuth grant the request came in on, when it did not come from a
    // personal access token. At most one of credential_id / oauth_consent_id is
    // set (CHECK below). The grant row keeps the request actionable: revoking the
    // grant deletes it, and a trigger cancels the request first.
    oauthConsentId: text("oauth_consent_id").references(() => oauthConsent.id, {
      onDelete: "set null",
    }),
    // The mcp_tool_calls row that created it, for tracing. Deliberately NO
    // foreign key: ledger rows are pruned after 30 days.
    toolCallId: text("tool_call_id"),
    // `{}` for a close; `{ content }` for a reply, where content is the Tiptap
    // JSON string exactly as it is stored in ticket_comments.content.
    payload: jsonb("payload").notNull().default({}),
    status: mcpPendingActionStatus("status").notNull().default("pending"),
    // Why a row was cancelled or failed: token_revoked, ticket_merged,
    // replies_disabled, ticket_closed, ticket_not_found, no_closed_status, interrupted.
    statusReason: text("status_reason"),
    // The activity or comment id an approval will create, set by the approving
    // compare-and-set so a crash can be reconciled from the database alone.
    plannedEntityId: text("planned_entity_id"),
    // Ids and booleans only: { activityId }, { commentId },
    // { alreadyClosed: true }, optionally notificationErrors.
    result: jsonb("result"),
    sideEffectsUncertain: boolean("side_effects_uncertain")
      .notNull()
      .default(false),
    // When it was approved or dismissed.
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("mcp_pending_actions_pending_idx")
      .on(t.ticketId, t.kind, t.requestedById)
      .where(sql`${t.status} = 'pending'`),
    index("mcp_pending_actions_credential_idx").on(t.credentialId),
    index("mcp_pending_actions_oauth_consent_idx").on(t.oauthConsentId),
    check(
      "mcp_pending_actions_one_credential_chk",
      sql`${t.credentialId} IS NULL OR ${t.oauthConsentId} IS NULL`
    ),
    index("mcp_pending_actions_status_idx").on(t.status),
    index("mcp_pending_actions_requested_by_idx").on(t.requestedById),
  ]
);
