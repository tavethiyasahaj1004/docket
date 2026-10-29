import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// The https rule is stubbed per test (default: the real implementation).
const httpsRule = vi.hoisted(() => ({ override: null as boolean | null }));
vi.mock("@/lib/mcp/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/http")>();
  return {
    ...actual,
    isHttpsRequirementMet: (
      ...args: Parameters<typeof actual.isHttpsRequirementMet>
    ) => httpsRule.override ?? actual.isHttpsRequirementMet(...args),
  };
});

// Lets one test make the cancel sweep fail, to prove the setting and the
// cancellation are one transaction.
const coreFault = vi.hoisted(() => ({ throws: false }));
vi.mock("@/lib/mcp/pending-actions-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/mcp/pending-actions-core")>();
  return {
    ...actual,
    cancelPendingRepliesForGateOff: (
      ...args: Parameters<typeof actual.cancelPendingRepliesForGateOff>
    ) =>
      coreFault.throws
        ? Promise.reject(new Error("simulated cancel failure"))
        : actual.cancelPendingRepliesForGateOff(...args),
  };
});

import {
  GET as getSettings,
  PATCH as patchSettings,
} from "@/app/api/admin/mcp/settings/route";
import { mcpPendingActions } from "@/db/schema";
import { db } from "@/lib/db";
import { MCP_INSTRUCTIONS_MAX_CHARS } from "@/lib/mcp/limits";
import { MCP_INSTRUCTIONS } from "@/lib/mcp/server";
import { auditRows, setupMcpWorld } from "./mcp-helpers";
import {
  ALICE,
  approve,
  BOB,
  call,
  commentsOn,
  connectWith,
  dismiss,
  expectOk,
  FRANK,
  key,
  ledger,
  OPERATOR_SCOPES,
  outboxCount,
  pendingRow,
  pendingRows,
  SEC_BODY,
  seedPhase6World,
  setReplyGate,
  USERS,
} from "./mcp-phase6-helpers";
import { callTool, closeMcpClients } from "./mcp-read-helpers";

const world = setupMcpWorld();

const SETTINGS = "http://localhost:3000/api/admin/mcp/settings";
const as = (u: { id: string; name: string; email: string }, role: string) => ({
  "x-user-id": u.id,
  "x-user-name": u.name,
  "x-user-email": u.email,
  "x-user-role": role,
});
const ALICE_H = as(USERS.alice, "agent");
const BOB_H = as(USERS.bob, "admin");

const getS = (headers: Record<string, string> = BOB_H) =>
  getSettings(new NextRequest(SETTINGS, { headers }));
const patchS = (body: unknown, headers: Record<string, string> = BOB_H) =>
  patchSettings(
    new NextRequest(SETTINGS, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );

async function gateInDb() {
  const [row] =
    await world.sql`SELECT mcp_customer_replies_enabled AS on FROM platform_settings`;
  return row?.on as boolean | undefined;
}

const quiet: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(async () => {
  httpsRule.override = null;
  coreFault.throws = false;
  for (const method of ["log", "warn", "error", "info"] as const) {
    quiet.push(vi.spyOn(console, method).mockImplementation(() => undefined));
  }
  await seedPhase6World(world);
});

afterEach(async () => {
  await closeMcpClients();
  vi.restoreAllMocks();
  quiet.length = 0;
});

async function operator(userId: string = ALICE) {
  return (await connectWith(world, userId, OPERATOR_SCOPES)).client;
}

const REPLY_ARGS = {
  ticket: 101,
  body: SEC_BODY,
  clientRequestId: key("gate-1"),
};

/* ----------------------------------------------------------- registration */

describe("reply_to_customer registration", () => {
  it("is off by default: absent from tools/list and unknown when called, even with tickets:reply", async () => {
    expect(await gateInDb()).toBe(false);
    const client = await operator();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("reply_to_customer");
    expect(names).toContain("get_action_status");

    const r = await callTool(client, "reply_to_customer", REPLY_ARGS);
    expect(r.protocolError).toMatch(/unknown tool|not found/i);
    // Refused before any handler: no trace row, no request.
    expect(await ledger()).toHaveLength(0);
    expect(await pendingRows()).toHaveLength(0);
  });

  it("appears once the setting is on, after reopen_ticket and before get_action_status", async () => {
    await setReplyGate(world, true);
    const client = await operator();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).slice(-6)).toEqual([
      "assign_ticket",
      "set_ticket_status",
      "close_ticket",
      "reopen_ticket",
      "reply_to_customer",
      "get_action_status",
    ]);
    // Deterministic: a second list is identical.
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
      tools.map((t) => t.name)
    );
  });

  it("whoami lists reply_to_customer only while the setting is on", async () => {
    const client = await operator();
    const tools = async () =>
      (expectOk(await call(client, "whoami", {})).tools as string[]).slice();
    expect(await tools()).not.toContain("reply_to_customer");
    await setReplyGate(world, true);
    expect(await tools()).toContain("reply_to_customer");
  });

  it("needs tickets:reply as well: the setting alone is not enough", async () => {
    await setReplyGate(world, true);
    const { client } = await connectWith(world, ALICE, [
      "tickets:read",
      "tickets:manage",
    ]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("reply_to_customer");
    expect(names).toContain("close_ticket");
  });

  it("follows the setting on the next request without reconnecting", async () => {
    const client = await operator();
    await setReplyGate(world, true);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(
      "reply_to_customer"
    );
    await setReplyGate(world, false);
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(
      "reply_to_customer"
    );
    expect(
      (await callTool(client, "reply_to_customer", REPLY_ARGS)).protocolError
    ).toMatch(/unknown tool|not found/i);
  });

  it("puts the user-interaction hint on exactly close_ticket, reply_to_customer and assign_ticket", async () => {
    await setReplyGate(world, true);
    const client = await connectWith(world, ALICE, [
      "tickets:read",
      "customers:read",
      "tickets:write",
      "tickets:manage",
      "tickets:reply",
    ]).then((c) => c.client);
    const { tools } = await client.listTools();
    const hinted = tools
      .filter(
        (t) => t._meta?.["anthropic/requiresUserInteraction"] !== undefined
      )
      .map((t) => t.name)
      .sort();
    expect(hinted).toEqual([
      "assign_ticket",
      "close_ticket",
      "reply_to_customer",
    ]);
    for (const t of tools.filter((x) => hinted.includes(x.name))) {
      expect(t._meta?.["anthropic/requiresUserInteraction"], t.name).toBe(true);
    }
  });

  it("annotates reply_to_customer as non-idempotent and open-world, with a short description", async () => {
    await setReplyGate(world, true);
    const { tools } = await (await operator()).listTools();
    const tool = tools.find((t) => t.name === "reply_to_customer");
    expect(tool?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(tool?.description?.length ?? 0).toBeLessThanOrEqual(1000);
    expect(tool?.description?.startsWith("Only REQUESTS")).toBe(true);
    for (const t of tools) {
      expect(t.description?.length ?? 0, t.name).toBeLessThanOrEqual(1000);
    }
  });

  it("reports server version 0.3.0 and instructions within the cap", async () => {
    const client = await operator();
    expect(client.getServerVersion()?.version).toBe("0.3.0");
    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(
      MCP_INSTRUCTIONS_MAX_CHARS
    );
  });
});

/* -------------------------------------------------------- the admin API */

describe("GET and PATCH /api/admin/mcp/settings: customerRepliesEnabled", () => {
  it("is off by default and readable by an admin only", async () => {
    const res = await getS();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      enabled: true,
      customerRepliesEnabled: false,
    });
    expect((await getS(ALICE_H)).status).toBe(403);
    expect((await getS({})).status).toBe(403);
  });

  it("turns on and off with one audit row each, actor = the admin", async () => {
    const on = await patchS({ customerRepliesEnabled: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ customerRepliesEnabled: true });
    expect(await gateInDb()).toBe(true);
    expect((await (await getS()).json()).customerRepliesEnabled).toBe(true);

    const off = await patchS({ customerRepliesEnabled: false });
    expect(await off.json()).toEqual({ customerRepliesEnabled: false });
    expect(await gateInDb()).toBe(false);

    const rows = await auditRows(world.sql, "mcp.customer_replies_changed");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        actor_id: BOB,
        actor_email: USERS.bob.email,
        entity_type: "platform_settings",
        entity_id: "default",
      });
    }
    expect(rows.map((r) => r.metadata)).toEqual(
      expect.arrayContaining([
        { from: false, to: true },
        { from: true, to: false },
      ])
    );
  });

  it("writes no audit row when the value does not change", async () => {
    await patchS({ customerRepliesEnabled: false });
    await patchS({ customerRepliesEnabled: true });
    await patchS({ customerRepliesEnabled: true });
    expect(
      await auditRows(world.sql, "mcp.customer_replies_changed")
    ).toHaveLength(1);
  });

  it("refuses a non-admin and changes nothing", async () => {
    for (const headers of [ALICE_H, {}]) {
      const res = await patchS({ customerRepliesEnabled: true }, headers);
      expect(res.status).toBe(403);
    }
    expect(await gateInDb()).toBe(false);
    expect(
      await auditRows(world.sql, "mcp.customer_replies_changed")
    ).toHaveLength(0);
  });

  it("rejects a non-boolean value, and keeps the original error when neither field is sent", async () => {
    const bad = await patchS({ customerRepliesEnabled: "yes" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      error: "customerRepliesEnabled must be true or false.",
    });
    for (const body of [{}, { enabled: "true" }, "{nope", "null", "[]"]) {
      const res = await patchS(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({
        error: "enabled must be true or false.",
      });
    }
    expect(await gateInDb()).toBe(false);
  });

  it("does not need https to be turned on or off; the MCP-enable rule is unchanged", async () => {
    httpsRule.override = false;
    expect((await patchS({ customerRepliesEnabled: true })).status).toBe(200);
    expect(await gateInDb()).toBe(true);
    expect((await patchS({ customerRepliesEnabled: false })).status).toBe(200);

    const refused = await patchS({ enabled: true });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error:
        "MCP can only be enabled when NEXT_PUBLIC_APP_URL uses https:// in production.",
    });
    // A refused enable writes nothing from the same body either.
    const both = await patchS({ enabled: true, customerRepliesEnabled: true });
    expect(both.status).toBe(409);
    expect(await gateInDb()).toBe(false);
  });

  it("keeps the existing enabled behaviour: response shape and audit", async () => {
    const res = await patchS({ enabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
    expect(await auditRows(world.sql, "mcp.enabled_changed")).toHaveLength(1);
    expect(await gateInDb()).toBe(false);
  });

  it("accepts both fields in one request", async () => {
    const res = await patchS({ enabled: true, customerRepliesEnabled: true });
    expect(await res.json()).toEqual({
      enabled: true,
      customerRepliesEnabled: true,
    });
  });
});

/* ------------------------------------------------- turning the gate off */

describe("turning customer replies off", () => {
  async function pendingSetup() {
    await setReplyGate(world, true);
    const alice = await operator();
    const frank = await operator(FRANK);
    const reply1 = expectOk(await call(alice, "reply_to_customer", REPLY_ARGS))
      .requestId as string;
    const reply2 = expectOk(
      await call(frank, "reply_to_customer", {
        ticket: 102,
        body: "Another reply",
        clientRequestId: key("gate-2"),
      })
    ).requestId as string;
    const close = expectOk(
      await call(alice, "close_ticket", {
        ticket: 101,
        clientRequestId: key("gate-3"),
      })
    ).requestId as string;
    return { alice, reply1, reply2, close };
  }

  it("cancels every pending reply request, audits each, and leaves close requests alone", async () => {
    const { alice, reply1, reply2, close } = await pendingSetup();

    const res = await patchS({ customerRepliesEnabled: false });
    expect(res.status).toBe(200);

    for (const id of [reply1, reply2]) {
      expect(await pendingRow(id)).toMatchObject({
        status: "cancelled",
        statusReason: "replies_disabled",
      });
    }
    expect(await pendingRow(close)).toMatchObject({
      status: "pending",
      statusReason: null,
    });

    const cancelled = await auditRows(world.sql, "mcp.action_cancelled");
    expect(cancelled).toHaveLength(2);
    for (const row of cancelled) {
      expect(row).toMatchObject({
        actor_id: BOB,
        actor_email: USERS.bob.email,
        entity_type: "mcp_pending_action",
      });
      expect(row.metadata).toMatchObject({
        reason: "replies_disabled",
        kind: "reply",
        via: "mcp",
      });
    }
    expect(cancelled.map((r) => r.entity_id).sort()).toEqual(
      [reply1, reply2].sort()
    );
    expect(JSON.stringify(cancelled)).not.toContain(SEC_BODY);

    // The assistant can see what happened.
    const status = expectOk(
      await call(alice, "get_action_status", { requestId: reply1 })
    );
    expect(status).toMatchObject({
      status: "cancelled",
      reason: "replies_disabled",
    });
  });

  it("does not touch requests that were already decided, and turning on cancels nothing", async () => {
    const { reply1, reply2 } = await pendingSetup();
    expect((await dismiss(reply1)).status).toBe(200);
    expect((await approve(reply2, "frank")).status).toBe(200);

    await patchS({ customerRepliesEnabled: false });
    expect((await pendingRow(reply1)).status).toBe("dismissed");
    expect((await pendingRow(reply2)).status).toBe("approved");
    expect(await auditRows(world.sql, "mcp.action_cancelled")).toHaveLength(0);

    await patchS({ customerRepliesEnabled: true });
    expect(await auditRows(world.sql, "mcp.action_cancelled")).toHaveLength(0);
  });

  it("is atomic: if the cancellation fails the setting stays on and the reply stays pending", async () => {
    const { reply1 } = await pendingSetup();
    coreFault.throws = true;
    await expect(patchS({ customerRepliesEnabled: false })).rejects.toThrow();
    expect(await gateInDb()).toBe(true);
    expect((await pendingRow(reply1)).status).toBe("pending");
    expect(
      await auditRows(world.sql, "mcp.customer_replies_changed")
    ).toHaveLength(0);
  });

  it("a reply requested before the switch can no longer be approved or dismissed while it is off", async () => {
    await setReplyGate(world, true);
    const client = await operator();
    const requestId = expectOk(
      await call(client, "reply_to_customer", REPLY_ARGS)
    ).requestId as string;
    const commentsBefore = (await commentsOn("t-101")).length;
    const emailsBefore = await outboxCount();

    // The setting is flipped without the cancel sweep (as a race or a manual
    // database edit would): the approval itself must still refuse.
    await setReplyGate(world, false);

    const refused = await approve(requestId);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: "This request is no longer pending.",
    });
    expect((await dismiss(requestId)).status).toBe(409);
    expect((await commentsOn("t-101")).length).toBe(commentsBefore);
    expect(await outboxCount()).toBe(emailsBefore);
    expect((await pendingRow(requestId)).status).toBe("pending");

    // Back on, the same request can be approved: only the gate stood in the way.
    await setReplyGate(world, true);
    expect((await approve(requestId)).status).toBe(200);
    expect((await commentsOn("t-101")).length).toBe(commentsBefore + 1);
  });

  it("still approves a close request while replies are off", async () => {
    await setReplyGate(world, true);
    const client = await operator();
    const requestId = expectOk(
      await call(client, "close_ticket", {
        ticket: 101,
        clientRequestId: key("gate-4"),
      })
    ).requestId as string;
    await patchS({ customerRepliesEnabled: false });
    expect(await approve(requestId)).toEqual({
      status: 200,
      body: { status: "approved", outcome: "closed" },
    });
  });

  it("refuses a reply request that raced the switch: the request cannot exist after it", async () => {
    await setReplyGate(world, true);
    const client = await operator();
    await patchS({ customerRepliesEnabled: false });
    const r = await callTool(client, "reply_to_customer", REPLY_ARGS);
    expect(r.protocolError).toMatch(/unknown tool|not found/i);
    expect(
      (await db.select().from(mcpPendingActions)).filter(
        (a) => a.kind === "reply"
      )
    ).toHaveLength(0);
  });
});
