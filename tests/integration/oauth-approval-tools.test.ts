import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createId } from "@paralleldrive/cuid2";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as approve } from "@/app/api/mcp/actions/[id]/approve/route";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { mcpHandler, toMcpAuthInfo } from "@/lib/mcp/server";
import {
  insertTickets,
  seedCustomers,
  seedDefaultConfig,
  tid,
  WORLD_TICKETS,
} from "./fixtures";
import { setupMcpWorld, USERS } from "./mcp-helpers";
import { callTool } from "./mcp-read-helpers";
import {
  consentRow,
  createClient,
  runFlow,
  seedResource,
  signInAs,
} from "./oauth-helpers";

// Phase 6's approval tools (close_ticket, reply_to_customer) record who asked
// on the pending request. For an OAuth caller that must be the grant
// (oauth_consent_id), never its client id in credential_id. OAuth cannot grant
// tickets:manage today, so the principal is built directly with that scope to
// exercise the tool path; the grant itself is real.

const world = setupMcpWorld();
const ALICE = USERS.alice.id; // agent
const TICKET = tid(101);

let aliceCookie: string;
let clientId: string;
const clients: Client[] = [];

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await seedDefaultConfig(world.db);
  await seedCustomers(world.db);
  await insertTickets(world.db, WORLD_TICKETS);
  await seedResource(world);
  const adminCookie = await signInAs(world, USERS.bob.id, USERS.bob.email);
  aliceCookie = await signInAs(world, ALICE, USERS.alice.email);
  clientId = await createClient(adminCookie);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  vi.restoreAllMocks();
});

function oauthPrincipal(consentId: string | undefined): McpPrincipal {
  return {
    userId: ALICE,
    name: USERS.alice.name,
    email: USERS.alice.email,
    role: "agent",
    scopes: ["tickets:read", "tickets:manage"],
    authMethod: "oauth",
    credentialId: clientId,
    credentialName: "Test Assistant",
    credentialExpiresAt: new Date(Date.now() + 3_600_000),
    clientId,
    consentId,
  };
}

async function connectAs(principal: McpPrincipal): Promise<Client> {
  const client = new Client({ name: "oauth-approval-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://localhost:3000/api/mcp"),
    {
      fetch: (url, init) =>
        mcpHandler.fetch(new Request(url, init), {
          authInfo: toMcpAuthInfo(principal, createId()),
        }),
    }
  );
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function grant() {
  await runFlow({ cookie: aliceCookie, clientId });
  const row = await consentRow(world, ALICE, clientId);
  return row.id as string;
}

async function requestRows() {
  return (await world.sql`
    SELECT id, status, status_reason, credential_id, oauth_consent_id
    FROM mcp_pending_actions ORDER BY created_at`) as unknown as {
    id: string;
    status: string;
    status_reason: string | null;
    credential_id: string | null;
    oauth_consent_id: string | null;
  }[];
}

async function ticketStatus() {
  const [row] =
    await world.sql`SELECT status FROM tickets WHERE id = ${TICKET}`;
  return row.status as string;
}

function approveAs(actionId: string, cookie: string) {
  return approve(
    new NextRequest(
      `http://localhost:3000/api/mcp/actions/${actionId}/approve`,
      { method: "POST", headers: { cookie } }
    ),
    { params: Promise.resolve({ id: actionId }) }
  );
}

describe("close_ticket called over an OAuth grant", () => {
  it("records the grant on the request and still needs the owner's approval", async () => {
    const consentId = await grant();
    const before = await ticketStatus();
    const client = await connectAs(oauthPrincipal(consentId));

    const r = await callTool(client, "close_ticket", {
      ticket: 101,
      clientRequestId: "oauth-close-0123456789abcdef",
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ status: "awaiting_approval" });

    const [row] = await requestRows();
    expect(row).toMatchObject({
      status: "pending",
      credential_id: null,
      oauth_consent_id: consentId,
    });
    // Asking closed nothing.
    expect(await ticketStatus()).toBe(before);

    // get_action_status finds it for the same OAuth caller.
    const status = await callTool(client, "get_action_status", {
      requestId: row.id,
    });
    expect(status.isError, status.text).toBe(false);
    expect(status.data).toMatchObject({ status: "pending" });

    // Only the owner, in Docket, decides.
    const res = await approveAs(row.id, aliceCookie);
    expect(res.status).toBe(200);
    expect((await requestRows())[0].status).toBe("approved");
    expect(await ticketStatus()).not.toBe(before);
  });

  it("is cancelled when the grant is revoked and can no longer be approved", async () => {
    const consentId = await grant();
    const client = await connectAs(oauthPrincipal(consentId));
    const r = await callTool(client, "close_ticket", {
      ticket: 101,
      clientRequestId: "oauth-close-revoke-0123456789ab",
    });
    expect(r.isError, r.text).toBe(false);

    await world.sql`DELETE FROM oauth_consent WHERE id = ${consentId}`;
    const [row] = await requestRows();
    expect(row).toMatchObject({
      status: "cancelled",
      status_reason: "token_revoked",
      oauth_consent_id: null,
    });
    const res = await approveAs(row.id, aliceCookie);
    expect(res.status).not.toBe(200);
  });

  it("refuses an OAuth caller with no grant id instead of using its client id", async () => {
    await grant();
    const client = await connectAs(oauthPrincipal(undefined));
    const r = await callTool(client, "close_ticket", {
      ticket: 101,
      clientRequestId: "oauth-close-nogrant-0123456789",
    });
    expect(r.isError).toBe(true);
    expect(await requestRows()).toHaveLength(0);
  });
});
