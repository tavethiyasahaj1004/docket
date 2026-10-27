import { describe, expect, it } from "vitest";
import { setupMcpWorld, USERS } from "./mcp-helpers";

const world = setupMcpWorld();
const ALICE = USERS.alice.id;
const BOB = USERS.bob.id;

type CallInput = {
  id: string;
  userId?: string | null;
  tool?: string;
  clientRequestId?: string | null;
  status?: "pending" | "succeeded" | "failed";
  lockGroup?: string | null;
  ticket?: string | null;
};

async function insertCall(c: CallInput) {
  await world.sql`
    INSERT INTO mcp_tool_calls
      (id, request_id, user_id, auth_method, tool, client_request_id, status,
       lock_group, target_ticket_id)
    VALUES
      (${c.id}, ${`req-${c.id}`}, ${c.userId === undefined ? ALICE : c.userId},
       'token', ${c.tool ?? "reply_to_ticket"}, ${c.clientRequestId ?? null},
       ${c.status ?? "succeeded"}, ${c.lockGroup ?? null}, ${c.ticket ?? null})`;
}

describe("idempotency index", () => {
  it("rejects a duplicate (user, tool, client_request_id)", async () => {
    await insertCall({ id: "c1", clientRequestId: "abc" });
    await expect(
      insertCall({ id: "c2", clientRequestId: "abc" })
    ).rejects.toThrow(/mcp_tool_calls_idempotency_idx/);
  });

  it("allows the same client_request_id for another user or tool", async () => {
    await insertCall({ id: "c1", clientRequestId: "abc" });
    await insertCall({ id: "c2", clientRequestId: "abc", userId: BOB });
    await insertCall({ id: "c3", clientRequestId: "abc", tool: "other_tool" });
  });

  it("allows many rows with a NULL client_request_id", async () => {
    await insertCall({ id: "c1", clientRequestId: null });
    await insertCall({ id: "c2", clientRequestId: null });
    await insertCall({ id: "c3", clientRequestId: null });
  });
});

describe("per-ticket pending lock index", () => {
  it("rejects a second pending row for the same lock group and ticket", async () => {
    await insertCall({
      id: "c1",
      status: "pending",
      lockGroup: "reply",
      ticket: "t-1",
    });
    await expect(
      insertCall({
        id: "c2",
        status: "pending",
        lockGroup: "reply",
        ticket: "t-1",
      })
    ).rejects.toThrow(/mcp_tool_calls_ticket_lock_idx/);
  });

  it("allows a pending row next to succeeded and failed ones for the same pair", async () => {
    await insertCall({
      id: "c1",
      status: "succeeded",
      lockGroup: "reply",
      ticket: "t-1",
    });
    await insertCall({
      id: "c2",
      status: "pending",
      lockGroup: "reply",
      ticket: "t-1",
    });
    await insertCall({
      id: "c3",
      status: "failed",
      lockGroup: "reply",
      ticket: "t-1",
    });
  });

  it("allows pending rows for different tickets or lock groups", async () => {
    await insertCall({
      id: "c1",
      status: "pending",
      lockGroup: "reply",
      ticket: "t-1",
    });
    await insertCall({
      id: "c2",
      status: "pending",
      lockGroup: "reply",
      ticket: "t-2",
    });
    await insertCall({
      id: "c3",
      status: "pending",
      lockGroup: "manage",
      ticket: "t-1",
    });
  });

  it("does not constrain pending rows with a NULL lock_group", async () => {
    await insertCall({ id: "c1", status: "pending", ticket: "t-1" });
    await insertCall({ id: "c2", status: "pending", ticket: "t-1" });
  });
});
