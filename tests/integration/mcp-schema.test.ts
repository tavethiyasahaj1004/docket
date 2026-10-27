import { describe, expect, it } from "vitest";
import { setupMcpWorld } from "./mcp-helpers";

const world = setupMcpWorld();

type Col = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  udt_name: string;
};

async function columns(table: string) {
  const rows = (await world.sql`
    SELECT column_name, data_type, is_nullable, column_default, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY ordinal_position`) as unknown as Col[];
  return Object.fromEntries(rows.map((r) => [r.column_name, r]));
}

function expectCol(
  cols: Record<string, Col>,
  name: string,
  type: string,
  nullable: boolean,
  defaultMatch?: RegExp
) {
  const col = cols[name];
  expect(col, `column ${name}`).toBeDefined();
  expect(col.data_type, `${name} type`).toBe(type);
  expect(col.is_nullable, `${name} nullability`).toBe(nullable ? "YES" : "NO");
  if (defaultMatch) {
    expect(col.column_default, `${name} default`).toMatch(defaultMatch);
  } else {
    expect(col.column_default, `${name} default`).toBeNull();
  }
}

describe("mcp_access_tokens schema", () => {
  it("has exactly the designed columns", async () => {
    const cols = await columns("mcp_access_tokens");
    expect(Object.keys(cols)).toEqual([
      "id",
      "user_id",
      "name",
      "key_prefix",
      "key_hash",
      "scopes",
      "expires_at",
      "last_used_at",
      "revoked_at",
      "revoked_reason",
      "created_at",
      "updated_at",
    ]);
    expectCol(cols, "id", "text", false);
    expectCol(cols, "user_id", "text", false);
    expectCol(cols, "name", "text", false);
    expectCol(cols, "key_prefix", "text", false);
    expectCol(cols, "key_hash", "text", false);
    expectCol(cols, "scopes", "ARRAY", false);
    expect(cols.scopes.udt_name).toBe("_text");
    expectCol(cols, "expires_at", "timestamp with time zone", false);
    expectCol(cols, "last_used_at", "timestamp with time zone", true);
    expectCol(cols, "revoked_at", "timestamp with time zone", true);
    expectCol(cols, "revoked_reason", "text", true);
    expectCol(cols, "created_at", "timestamp with time zone", false, /now\(\)/);
    expectCol(cols, "updated_at", "timestamp with time zone", false, /now\(\)/);
  });

  it("has a unique key_hash and a user index", async () => {
    const rows = await world.sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'mcp_access_tokens'`;
    const defs = Object.fromEntries(
      rows.map((r) => [r.indexname as string, r.indexdef as string])
    );
    expect(defs.mcp_access_tokens_key_hash_unique).toMatch(
      /CREATE UNIQUE INDEX .* \(key_hash\)/
    );
    expect(defs.mcp_access_tokens_user_idx).toMatch(
      /CREATE INDEX mcp_access_tokens_user_idx .*\(user_id\)/
    );
  });
});

describe("mcp_tool_calls schema", () => {
  it("has exactly the designed columns", async () => {
    const cols = await columns("mcp_tool_calls");
    expect(Object.keys(cols)).toEqual([
      "id",
      "request_id",
      "user_id",
      "auth_method",
      "credential_id",
      "tool",
      "client_request_id",
      "status",
      "error_code",
      "args_hmac",
      "planned_entity_id",
      "lock_group",
      "target_ticket_id",
      "target_customer_id",
      "body_hmac",
      "lease_expires_at",
      "attempts",
      "result_json",
      "side_effects_uncertain",
      "notification_errors",
      "duration_ms",
      "created_at",
      "updated_at",
    ]);
    expectCol(cols, "id", "text", false);
    expectCol(cols, "request_id", "text", false);
    expectCol(cols, "user_id", "text", true);
    expectCol(cols, "auth_method", "text", false);
    expectCol(cols, "credential_id", "text", true);
    expectCol(cols, "tool", "text", false);
    expectCol(cols, "client_request_id", "text", true);
    expectCol(cols, "status", "USER-DEFINED", false);
    expect(cols.status.udt_name).toBe("mcp_tool_call_status");
    expectCol(cols, "error_code", "text", true);
    expectCol(cols, "args_hmac", "text", true);
    expectCol(cols, "planned_entity_id", "text", true);
    expectCol(cols, "lock_group", "text", true);
    expectCol(cols, "target_ticket_id", "text", true);
    expectCol(cols, "target_customer_id", "text", true);
    expectCol(cols, "body_hmac", "text", true);
    expectCol(cols, "lease_expires_at", "timestamp with time zone", true);
    expectCol(cols, "attempts", "integer", false, /^1$/);
    expectCol(cols, "result_json", "jsonb", true);
    expectCol(cols, "side_effects_uncertain", "boolean", false, /false/);
    expectCol(cols, "notification_errors", "ARRAY", true);
    expect(cols.notification_errors.udt_name).toBe("_text");
    expectCol(cols, "duration_ms", "integer", true);
    expectCol(cols, "created_at", "timestamp with time zone", false, /now\(\)/);
    expectCol(cols, "updated_at", "timestamp with time zone", false, /now\(\)/);
  });

  it("defines the status enum", async () => {
    const rows = await world.sql`
      SELECT e.enumlabel
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'mcp_tool_call_status'
      ORDER BY e.enumsortorder`;
    expect(rows.map((r) => r.enumlabel)).toEqual([
      "pending",
      "succeeded",
      "failed",
    ]);
  });

  it("has the designed indexes, including both partial predicates", async () => {
    const rows = await world.sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'mcp_tool_calls'`;
    const defs = Object.fromEntries(
      rows.map((r) => [r.indexname as string, r.indexdef as string])
    );

    const idem = defs.mcp_tool_calls_idempotency_idx;
    expect(idem).toContain("CREATE UNIQUE INDEX");
    expect(idem).toContain("(user_id, tool, client_request_id)");
    expect(idem).toMatch(/WHERE \(?client_request_id IS NOT NULL\)?/);

    const lock = defs.mcp_tool_calls_ticket_lock_idx;
    expect(lock).toContain("CREATE UNIQUE INDEX");
    expect(lock).toContain("(lock_group, target_ticket_id)");
    expect(lock).toMatch(/status = 'pending'::mcp_tool_call_status/);
    expect(lock).toMatch(/lock_group IS NOT NULL/);

    expect(defs.mcp_tool_calls_created_at_idx).toContain("(created_at)");
    expect(defs.mcp_tool_calls_user_idx).toContain("(user_id)");
  });
});

describe("foreign keys", () => {
  async function fkActions(table: string) {
    const rows = await world.sql`
      SELECT c.confdeltype AS action, ref.relname AS referenced
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_class ref ON ref.oid = c.confrelid
      WHERE c.contype = 'f' AND t.relname = ${table}`;
    return rows.map((r) => ({
      action: r.action as string,
      referenced: r.referenced as string,
    }));
  }

  it("cascades token deletion with the user", async () => {
    expect(await fkActions("mcp_access_tokens")).toEqual([
      { action: "c", referenced: "user" },
    ]);
  });

  it("sets tool-call user_id to null on user deletion, with no other FKs", async () => {
    expect(await fkActions("mcp_tool_calls")).toEqual([
      { action: "n", referenced: "user" },
    ]);
  });
});

describe("platform_settings.mcp_enabled", () => {
  it("defaults to false for a row inserted without it", async () => {
    await world.sql`DELETE FROM platform_settings`;
    await world.sql`INSERT INTO platform_settings (id) VALUES ('default')`;
    const [row] = await world.sql`
      SELECT mcp_enabled FROM platform_settings WHERE id = 'default'`;
    expect(row.mcp_enabled).toBe(false);
  });
});
