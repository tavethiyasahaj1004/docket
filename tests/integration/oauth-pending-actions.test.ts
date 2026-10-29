import { createId } from "@paralleldrive/cuid2";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as approve } from "@/app/api/mcp/actions/[id]/approve/route";
import { POST as dismiss } from "@/app/api/mcp/actions/[id]/dismiss/route";
import { mcpPendingActions } from "@/db/schema";
import {
  createPendingAction,
  listActionablePendingActionsForViewer,
} from "@/lib/mcp/pending-actions";
import {
  doc,
  insertTickets,
  seedCustomers,
  seedDefaultConfig,
  tid,
  WORLD_TICKETS,
} from "./fixtures";
import {
  addToken,
  addUser,
  auditRows,
  setupMcpWorld,
  USERS,
} from "./mcp-helpers";
import { closeMcpClients } from "./mcp-read-helpers";
import {
  consentRow,
  createClient,
  runFlow,
  seedResource,
  signInAs,
} from "./oauth-helpers";

const world = setupMcpWorld();

const ALICE = USERS.alice.id; // agent
const BOB = USERS.bob.id; // admin
const TICKET = tid(101);
const REPLY = doc("a drafted reply");

let adminCookie: string;
let aliceCookie: string;
let clientId: string;

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await seedDefaultConfig(world.db);
  await seedCustomers(world.db);
  await insertTickets(world.db, WORLD_TICKETS);
  await seedResource(world);
  adminCookie = await signInAs(world, BOB, USERS.bob.email);
  aliceCookie = await signInAs(world, ALICE, USERS.alice.email);
  clientId = await createClient(adminCookie);
});
afterEach(async () => {
  await closeMcpClients();
  vi.restoreAllMocks();
});

function decide(
  verb: "approve" | "dismiss",
  actionId: string,
  headers: Record<string, string>
) {
  const handler = verb === "approve" ? approve : dismiss;
  return handler(
    new NextRequest(
      `http://localhost:3000/api/mcp/actions/${actionId}/${verb}`,
      { method: "POST", headers }
    ),
    { params: Promise.resolve({ id: actionId }) }
  );
}

async function actionRow(id: string) {
  const [row] = await world.sql`
    SELECT status, status_reason, credential_id, oauth_consent_id
    FROM mcp_pending_actions WHERE id = ${id}`;
  return row as {
    status: string;
    status_reason: string | null;
    credential_id: string | null;
    oauth_consent_id: string | null;
  };
}

async function grant(cookie = aliceCookie, userId: string = ALICE) {
  await runFlow({ cookie, clientId });
  const row = await consentRow(world, userId, clientId);
  return row.id as string;
}

describe("a request made on an OAuth grant", () => {
  it("is recorded against the grant, not a token", async () => {
    const consentId = await grant();
    const result = await createPendingAction({
      userId: ALICE,
      oauthConsentId: consentId,
      ticketId: TICKET,
      kind: "close",
    });
    expect(result.status).toBe("created");
    const id = (result as { action: { id: string } }).action.id;
    expect(await actionRow(id)).toMatchObject({
      status: "pending",
      credential_id: null,
      oauth_consent_id: consentId,
    });
    const [audit] = await auditRows(world.sql, "mcp.action_requested");
    expect(audit.metadata).toMatchObject({
      oauthConsentId: consentId,
      credentialId: null,
    });
  });

  it("shows the owner the client's name on their ticket banner", async () => {
    const consentId = await grant();
    await createPendingAction({
      userId: ALICE,
      oauthConsentId: consentId,
      ticketId: TICKET,
      kind: "reply",
      payload: { content: REPLY },
    });
    const rows = await listActionablePendingActionsForViewer(TICKET, ALICE);
    expect(rows).toHaveLength(1);
    expect(rows[0].credentialName).toBe("Test Assistant");
  });

  it("returns the existing request for a repeat, like a PAT does", async () => {
    const consentId = await grant();
    const input = {
      userId: ALICE,
      oauthConsentId: consentId,
      ticketId: TICKET,
      kind: "close" as const,
    };
    const first = await createPendingAction(input);
    const second = await createPendingAction(input);
    expect(first.status).toBe("created");
    expect(second.status).toBe("existing");
  });

  it("is refused for someone else's grant, a missing grant, a disabled client, or both credentials", async () => {
    const consentId = await grant();
    const base = { ticketId: TICKET, kind: "close" as const };
    expect(
      (
        await createPendingAction({
          ...base,
          userId: BOB,
          oauthConsentId: consentId,
        })
      ).status
    ).toBe("not_permitted");
    expect(
      (
        await createPendingAction({
          ...base,
          userId: ALICE,
          oauthConsentId: "nope",
        })
      ).status
    ).toBe("not_permitted");
    const pat = await addToken(world.db, ALICE);
    expect(
      (
        await createPendingAction({
          ...base,
          userId: ALICE,
          oauthConsentId: consentId,
          credentialId: pat.id,
        })
      ).status
    ).toBe("not_permitted");
    expect((await createPendingAction({ ...base, userId: ALICE })).status).toBe(
      "not_permitted"
    );
    await world.sql`UPDATE oauth_client SET disabled = true`;
    expect(
      (
        await createPendingAction({
          ...base,
          userId: ALICE,
          oauthConsentId: consentId,
        })
      ).status
    ).toBe("not_permitted");
  });

  it("is refused for an ineligible owner", async () => {
    const consentId = await grant();
    await world.sql`UPDATE "user" SET banned = true WHERE id = ${ALICE}`;
    // The ban trigger already removed the grant; the request is refused either way.
    expect(
      (
        await createPendingAction({
          userId: ALICE,
          oauthConsentId: consentId,
          ticketId: TICKET,
          kind: "close",
        })
      ).status
    ).toBe("not_permitted");
  });

  it("cannot hold both a PAT and a grant (CHECK constraint)", async () => {
    const consentId = await grant();
    const pat = await addToken(world.db, ALICE);
    await expect(
      world.db.insert(mcpPendingActions).values({
        id: createId(),
        kind: "close",
        ticketId: TICKET,
        requestedById: ALICE,
        credentialId: pat.id,
        oauthConsentId: consentId,
        expiresAt: new Date(Date.now() + 3_600_000),
      })
    ).rejects.toThrow();
  });
});

describe("only the owner decides", () => {
  it("lets the owner approve a request that came in over OAuth", async () => {
    const consentId = await grant();
    const created = await createPendingAction({
      userId: ALICE,
      oauthConsentId: consentId,
      ticketId: TICKET,
      kind: "close",
    });
    const id = (created as { action: { id: string } }).action.id;

    const res = await decide("approve", id, { cookie: aliceCookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "approved", outcome: "closed" });
    expect((await actionRow(id)).status).toBe("approved");
    const [audit] = await auditRows(world.sql, "mcp.action_approved");
    expect(audit.actor_id).toBe(ALICE);
  });

  it("lets the owner dismiss one", async () => {
    const consentId = await grant();
    const created = await createPendingAction({
      userId: ALICE,
      oauthConsentId: consentId,
      ticketId: TICKET,
      kind: "close",
    });
    const id = (created as { action: { id: string } }).action.id;
    const res = await decide("dismiss", id, { cookie: aliceCookie });
    expect(res.status).toBe(200);
    expect((await actionRow(id)).status).toBe("dismissed");
  });

  it("answers another user (even an admin) exactly like an unknown id", async () => {
    const consentId = await grant();
    const created = await createPendingAction({
      userId: ALICE,
      oauthConsentId: consentId,
      ticketId: TICKET,
      kind: "close",
    });
    const id = (created as { action: { id: string } }).action.id;

    const asAdmin = await decide("approve", id, { cookie: adminCookie });
    const unknown = await decide("approve", "no-such-id", {
      cookie: adminCookie,
    });
    expect(asAdmin.status).toBe(404);
    expect(await asAdmin.json()).toEqual(await unknown.json());
    expect((await decide("dismiss", id, { cookie: adminCookie })).status).toBe(
      404
    );
    expect((await actionRow(id)).status).toBe("pending");
  });

  it("offers no way to approve with the OAuth access token itself", async () => {
    const flow = await runFlow({ cookie: aliceCookie, clientId });
    const consentId = (await consentRow(world, ALICE, clientId)).id as string;
    const created = await createPendingAction({
      userId: ALICE,
      oauthConsentId: consentId,
      ticketId: TICKET,
      kind: "close",
    });
    const id = (created as { action: { id: string } }).action.id;
    for (const verb of ["approve", "dismiss"] as const) {
      const res = await decide(verb, id, {
        authorization: `Bearer ${flow.tokens.access_token}`,
      });
      expect(res.status).toBe(404);
    }
    expect((await actionRow(id)).status).toBe("pending");
  });

  it("refuses an approval from an impersonated session", async () => {
    const consentId = await grant();
    const created = await createPendingAction({
      userId: ALICE,
      oauthConsentId: consentId,
      ticketId: TICKET,
      kind: "close",
    });
    const id = (created as { action: { id: string } }).action.id;
    await world.sql`UPDATE session SET impersonated_by = ${BOB} WHERE user_id = ${ALICE}`;
    // Without the cookie-cache entry, so the session is read from the database.
    const uncached = aliceCookie
      .split("; ")
      .filter((c) => c.includes("session_token"))
      .join("; ");
    expect(uncached).not.toBe("");
    expect((await decide("approve", id, { cookie: uncached })).status).toBe(
      404
    );
    expect((await actionRow(id)).status).toBe("pending");
  });
});

describe("revoking the grant cancels its requests", () => {
  async function pending() {
    const consentId = await grant();
    const created = await createPendingAction({
      userId: ALICE,
      oauthConsentId: consentId,
      ticketId: TICKET,
      kind: "close",
    });
    return {
      consentId,
      id: (created as { action: { id: string } }).action.id,
    };
  }

  it("matches a revoked PAT: same status code and body for approve and dismiss", async () => {
    // A PAT-backed request, revoked.
    const pat = await addToken(world.db, ALICE);
    const viaPat = await createPendingAction({
      userId: ALICE,
      credentialId: pat.id,
      ticketId: tid(109),
      kind: "close",
    });
    const patActionId = (viaPat as { action: { id: string } }).action.id;
    await world.sql`UPDATE mcp_access_tokens SET revoked_at = now() WHERE id = ${pat.id}`;
    expect(await actionRow(patActionId)).toMatchObject({
      status: "cancelled",
      status_reason: "token_revoked",
    });

    // An OAuth-backed request, revoked.
    const { id, consentId } = await pending();
    await world.sql`DELETE FROM oauth_consent WHERE id = ${consentId}`;
    expect(await actionRow(id)).toMatchObject({
      status: "cancelled",
      status_reason: "token_revoked",
      oauth_consent_id: null,
    });

    for (const verb of ["approve", "dismiss"] as const) {
      const a = await decide(verb, patActionId, { cookie: aliceCookie });
      const b = await decide(verb, id, { cookie: aliceCookie });
      expect(b.status).toBe(a.status);
      expect(await b.json()).toEqual(await a.json());
    }
  });

  it("cancels through the account API with an audit row per request", async () => {
    const { id, consentId } = await pending();
    const { DELETE } = await import(
      "@/app/api/account/mcp/oauth-grants/[id]/route"
    );
    const res = await DELETE(
      new NextRequest(
        `http://localhost:3000/api/account/mcp/oauth-grants/${consentId}`,
        {
          method: "DELETE",
          headers: {
            "x-user-id": ALICE,
            "x-user-name": USERS.alice.name,
            "x-user-email": USERS.alice.email,
            "x-user-role": "agent",
          },
        }
      ),
      { params: Promise.resolve({ id: consentId }) }
    );
    expect(res.status).toBe(200);
    expect(await actionRow(id)).toMatchObject({
      status: "cancelled",
      status_reason: "token_revoked",
    });
    const [audit] = await auditRows(world.sql, "mcp.action_cancelled");
    expect(audit).toMatchObject({ actor_id: ALICE, entity_id: id });
    expect(audit.metadata).toMatchObject({ reason: "token_revoked" });
    expect((await decide("approve", id, { cookie: aliceCookie })).status).toBe(
      404
    );
  });

  it("is cancelled by a ban (trigger) and does not come back on unban", async () => {
    const { id } = await pending();
    await world.sql`UPDATE "user" SET banned = true WHERE id = ${ALICE}`;
    expect((await actionRow(id)).status).toBe("cancelled");
    await world.sql`UPDATE "user" SET banned = false WHERE id = ${ALICE}`;
    expect((await actionRow(id)).status).toBe("cancelled");
  });

  it("is cancelled by a role change away from agent/admin (trigger)", async () => {
    const { id } = await pending();
    await world.sql`UPDATE "user" SET role = 'user' WHERE id = ${ALICE}`;
    expect(await actionRow(id)).toMatchObject({
      status: "cancelled",
      status_reason: "token_revoked",
    });
  });

  it("is not cancelled by revoking some other user's grant", async () => {
    const { id } = await pending();
    await grant(adminCookie, BOB);
    await world.sql`DELETE FROM oauth_consent WHERE user_id = ${BOB}`;
    expect((await actionRow(id)).status).toBe("pending");
  });

  it("stays cancelled when the same assistant is connected again", async () => {
    const { id, consentId } = await pending();
    await world.sql`DELETE FROM oauth_consent WHERE id = ${consentId}`;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10_000);
    await grant();
    vi.useRealTimers();
    expect((await actionRow(id)).status).toBe("cancelled");
    expect((await decide("approve", id, { cookie: aliceCookie })).status).toBe(
      404
    );
  });
});

describe("PAT-backed requests are unchanged", () => {
  it("still create, list and approve exactly as before", async () => {
    const pat = await addToken(world.db, ALICE, { name: "Alice laptop" });
    const created = await createPendingAction({
      userId: ALICE,
      credentialId: pat.id,
      ticketId: TICKET,
      kind: "close",
    });
    expect(created.status).toBe("created");
    const id = (created as { action: { id: string } }).action.id;
    expect(await actionRow(id)).toMatchObject({
      credential_id: pat.id,
      oauth_consent_id: null,
    });
    const rows = await listActionablePendingActionsForViewer(TICKET, ALICE);
    expect(rows[0].credentialName).toBe("Alice laptop");
    expect((await decide("approve", id, { cookie: aliceCookie })).status).toBe(
      200
    );
  });

  it("a revoked PAT is still refused at creation", async () => {
    const pat = await addToken(world.db, ALICE, { revokedAt: new Date() });
    expect(
      (
        await createPendingAction({
          userId: ALICE,
          credentialId: pat.id,
          ticketId: TICKET,
          kind: "close",
        })
      ).status
    ).toBe("not_permitted");
  });
});

void addUser;
