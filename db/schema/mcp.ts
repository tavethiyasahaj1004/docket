import { createId } from "@paralleldrive/cuid2";
import { sql } from "drizzle-orm";
import {
  boolean,
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
