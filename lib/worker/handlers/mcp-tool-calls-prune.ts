import { lt } from "drizzle-orm";
import type { Job } from "pg-boss";
import { mcpToolCalls } from "@/db/schema";
import { db } from "@/lib/db";
import { MCP_TOOL_CALL_RETENTION_DAYS } from "@/lib/mcp/limits";

export async function handleMcpToolCallsPrune(
  _jobs: Job<Record<string, never>>[]
) {
  const cutoff = new Date(
    Date.now() - MCP_TOOL_CALL_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );
  await db.delete(mcpToolCalls).where(lt(mcpToolCalls.createdAt, cutoff));
}
