import { describe, expect, it } from "vitest";
import { QUEUE_OPTIONS } from "@/lib/worker/ensure-queues";
import { handleMcpToolCallsPrune } from "@/lib/worker/handlers/mcp-tool-calls-prune";
import { JOB_NAMES } from "@/lib/worker/job-types";
import { addToken, setupMcpWorld, USERS } from "./mcp-helpers";

const world = setupMcpWorld();
const ALICE = USERS.alice.id;
const DAY = 24 * 60 * 60 * 1000;

async function insertCall(id: string, createdAt: Date) {
  await world.sql`
    INSERT INTO mcp_tool_calls
      (id, request_id, user_id, auth_method, tool, status, created_at)
    VALUES
      (${id}, ${`req-${id}`}, ${ALICE}, 'pat', 'whoami', 'succeeded',
       ${createdAt.toISOString()}::timestamptz)`;
}

async function ids(table: "mcp_tool_calls") {
  const rows = await world.sql`SELECT id FROM ${world.sql(table)} ORDER BY id`;
  return rows.map((r) => r.id as string);
}

describe("mcp tool-calls prune job", () => {
  it("is registered like the other prune jobs", () => {
    expect(JOB_NAMES.MCP_TOOL_CALLS_PRUNE).toBe("mcp.tool-calls-prune");
    expect(QUEUE_OPTIONS[JOB_NAMES.MCP_TOOL_CALLS_PRUNE]).toEqual(
      QUEUE_OPTIONS[JOB_NAMES.RATE_LIMIT_HITS_PRUNE]
    );
  });

  it("deletes rows older than 30 days and keeps the rest", async () => {
    const now = Date.now();
    await insertCall("old-31d", new Date(now - 31 * DAY));
    await insertCall("old-45d", new Date(now - 45 * DAY));
    await insertCall("keep-29d", new Date(now - 29 * DAY));
    await insertCall("keep-now", new Date(now));

    await handleMcpToolCallsPrune([]);

    expect(await ids("mcp_tool_calls")).toEqual(["keep-29d", "keep-now"]);
  });

  it("is delete-only and touches no other table", async () => {
    await insertCall("old", new Date(Date.now() - 40 * DAY));
    await addToken(world.db, ALICE);
    await world.sql`
      INSERT INTO rate_limit_hits (id, bucket_key, window_start, count)
      VALUES ('old-hit', 'x', now() - interval '90 days', 1)`;
    await world.sql`
      INSERT INTO audit_logs (id, action, description, entity_type, created_at)
      VALUES ('old-audit', 'x', 'x', 'x', now() - interval '90 days')`;

    const count = async (table: string) =>
      (await world.sql`SELECT count(*)::int AS n FROM ${world.sql(table)}`)[0]
        .n as number;
    const before = {
      tokens: await count("mcp_access_tokens"),
      users: await count("user"),
      hits: await count("rate_limit_hits"),
      audit: await count("audit_logs"),
      settings: await count("platform_settings"),
    };

    await handleMcpToolCallsPrune([]);

    expect(await ids("mcp_tool_calls")).toEqual([]);
    expect({
      tokens: await count("mcp_access_tokens"),
      users: await count("user"),
      hits: await count("rate_limit_hits"),
      audit: await count("audit_logs"),
      settings: await count("platform_settings"),
    }).toEqual(before);
  });
});
