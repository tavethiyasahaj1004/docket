import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_OAUTH_RESOURCE } from "@/lib/oauth";
import { addToken, setupMcpWorld, USERS } from "./mcp-helpers";
import { callTool, closeMcpClients, connectMcp } from "./mcp-read-helpers";
import {
  APP_URL,
  authFetch,
  authorize,
  consent,
  createClient,
  decodeJwtPayload,
  foreignKeyToken,
  forgeToken,
  ISSUER,
  mcpStatus,
  pkce,
  REDIRECT_URI,
  runFlow,
  seedResource,
  signInAs,
  tokenRequest,
  unsignedToken,
} from "./oauth-helpers";

const world = setupMcpWorld();

const ALICE = USERS.alice.id; // agent
const BOB = USERS.bob.id; // admin

let adminCookie: string;
let aliceCookie: string;
let clientId: string;

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await seedResource(world);
  adminCookie = await signInAs(world, BOB, USERS.bob.email);
  aliceCookie = await signInAs(world, ALICE, USERS.alice.email);
  clientId = await createClient(adminCookie);
});
afterEach(async () => {
  vi.useRealTimers();
  await closeMcpClients();
  vi.restoreAllMocks();
});

async function whoami(token: string) {
  const client = await connectMcp(token);
  const result = await callTool(client, "whoami");
  return result.data as {
    authMethod: string;
    scopes: string[];
    tools: string[];
    user: { role: string };
  };
}

function refresh(rt: string, extra: Record<string, string> = {}) {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: rt,
    client_id: clientId,
    ...extra,
  });
}

describe("what /api/mcp does with a bearer token", () => {
  it("accepts a freshly issued token", async () => {
    const flow = await runFlow({ cookie: aliceCookie, clientId });
    expect((await mcpStatus(flow.tokens.access_token)).status).toBe(200);
  });

  it("answers 401 with the discovery challenge when no token is sent", async () => {
    const { status, www, body } = await mcpStatus("");
    expect(status).toBe(401);
    expect(www).toBe(
      `Bearer realm="docket", resource_metadata="${APP_URL}/.well-known/oauth-protected-resource/api/mcp", scope="tickets:read customers:read offline_access"`
    );
    expect(body).toEqual({ error: "Missing bearer token." });
  });

  it.each([
    ["garbage", "not-a-token"],
    ["a three-part non-JWT", "aaa.bbb.ccc"],
    ["a dkm_-looking unknown PAT", "dkm_unknownunknownunknown"],
  ])("rejects %s as an invalid token with the challenge", async (_l, token) => {
    const { status, www } = await mcpStatus(token);
    expect(status).toBe(401);
    expect(www).toContain('realm="docket"');
    expect(www).toContain("resource_metadata=");
    expect(www).toContain('error="invalid_token"');
    expect(www).toContain('error_description="invalid token"');
  });

  it("rejects a token for another audience", async () => {
    await runFlow({ cookie: aliceCookie, clientId });
    const token = await forgeToken({
      sub: ALICE,
      azp: clientId,
      aud: "https://other.example.test/mcp",
    });
    const { status, www } = await mcpStatus(token);
    expect(status).toBe(401);
    expect(www).toContain('error_description="invalid token"');
  });

  it("rejects a token with an extra audience entry", async () => {
    await runFlow({ cookie: aliceCookie, clientId });
    const token = await forgeToken({
      sub: ALICE,
      azp: clientId,
      aud: [MCP_OAUTH_RESOURCE, "https://other.example.test/mcp"],
    });
    // A token that is also meant for another resource is not ours to accept.
    expect((await mcpStatus(token)).status).toBe(401);
  });

  it("rejects a token from the wrong issuer", async () => {
    await runFlow({ cookie: aliceCookie, clientId });
    const token = await forgeToken({
      sub: ALICE,
      azp: clientId,
      iss: "https://evil.example.test/api/auth",
    });
    expect((await mcpStatus(token)).status).toBe(401);
  });

  it("rejects a token signed by a key Docket does not know", async () => {
    await runFlow({ cookie: aliceCookie, clientId });
    const token = foreignKeyToken({ sub: ALICE, azp: clientId });
    const { status, www } = await mcpStatus(token);
    expect(status).toBe(401);
    expect(www).toContain('error_description="invalid token"');
  });

  it("rejects an unsigned (alg none) token", async () => {
    await runFlow({ cookie: aliceCookie, clientId });
    const token = unsignedToken({ sub: ALICE, azp: clientId });
    expect((await mcpStatus(token)).status).toBe(401);
  });

  it("rejects a session JWT from the jwt plugin (no azp, wrong audience)", async () => {
    await runFlow({ cookie: aliceCookie, clientId });
    const token = await forgeToken({
      sub: ALICE,
      aud: APP_URL,
      iss: APP_URL,
    });
    expect((await mcpStatus(token)).status).toBe(401);
  });

  it("is not reachable: GET /api/auth/token does not hand out session JWTs", async () => {
    const res = await authFetch("/token", { cookie: aliceCookie });
    expect(res.status).toBe(404);
  });

  it("rejects a validly signed token that is missing required claims", async () => {
    await runFlow({ cookie: aliceCookie, clientId });
    for (const claims of [
      { sub: ALICE }, // no azp
      { azp: clientId }, // no sub
      { sub: ALICE, azp: clientId, scope: undefined },
    ]) {
      const token = await forgeToken(claims);
      expect((await mcpStatus(token)).status).toBe(401);
    }
  });

  it("rejects a DPoP-bound token (cnf claim) because only Bearer is accepted", async () => {
    await runFlow({ cookie: aliceCookie, clientId });
    const token = await forgeToken({
      sub: ALICE,
      azp: clientId,
      cnf: { jkt: "thumbprint" },
    });
    const { status, www } = await mcpStatus(token);
    expect(status).toBe(401);
    expect(www).toContain('error_description="invalid token"');
  });

  it("rejects a forged token for a user who never granted that client access", async () => {
    // Correct signature, issuer, audience and claims: only the grant is missing.
    const token = await forgeToken({ sub: ALICE, azp: clientId });
    const { status, www } = await mcpStatus(token);
    expect(status).toBe(401);
    expect(www).toContain('error_description="token revoked"');
  });

  it("rejects an expired token with 'token expired'", async () => {
    const flow = await runFlow({ cookie: aliceCookie, clientId });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    const { status, www } = await mcpStatus(flow.tokens.access_token);
    expect(status).toBe(401);
    expect(www).toContain('error_description="token expired"');
  });

  it("reports an authenticated-but-removed account as 'account not permitted'", async () => {
    const flow = await runFlow({ cookie: aliceCookie, clientId });
    await world.sql`UPDATE "user" SET role = 'user' WHERE id = ${ALICE}`;
    const { status, www } = await mcpStatus(flow.tokens.access_token);
    expect(status).toBe(401);
    expect(www).toContain('error_description="account not permitted"');
  });

  it("applies the same per-IP failure throttle as PATs", async () => {
    let last = 0;
    for (let i = 0; i < 70; i++) {
      last = (await mcpStatus(`forged-${i}`)).status;
      if (last === 429) {
        break;
      }
    }
    expect(last).toBe(429);
  });

  it("never logs the token", async () => {
    const flow = await runFlow({ cookie: aliceCookie, clientId });
    const logged: string[] = [];
    for (const m of ["warn", "log", "error", "info"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logged.push(a.map(String).join(" "));
      });
    }
    await mcpStatus(`${flow.tokens.access_token}x`);
    await mcpStatus(flow.tokens.access_token);
    expect(logged.join("\n")).not.toContain(flow.tokens.access_token.slice(10));
  });
});

describe("scopes narrow with the account and the grant", () => {
  it("narrows an admin's reports:read when they are demoted to agent", async () => {
    const flow = await runFlow({
      cookie: adminCookie,
      clientId,
      scope: "tickets:read reports:read offline_access",
    });
    expect((await whoami(flow.tokens.access_token)).scopes).toEqual([
      "tickets:read",
      "reports:read",
    ]);
    await world.sql`UPDATE "user" SET role = 'agent' WHERE id = ${BOB}`;
    const after = await whoami(flow.tokens.access_token);
    expect(after.scopes).toEqual(["tickets:read"]);
    expect(after.tools).not.toContain("get_report_tickets_by_agent");
  });

  it("narrows to the user's current consent when it is re-granted with less", async () => {
    const flow = await runFlow({
      cookie: aliceCookie,
      clientId,
      scope: "tickets:read customers:read tickets:write offline_access",
    });
    expect((await whoami(flow.tokens.access_token)).scopes).toContain(
      "tickets:write"
    );
    await world.sql`UPDATE oauth_consent SET scopes = ARRAY['tickets:read','offline_access'] WHERE user_id = ${ALICE}`;
    expect((await whoami(flow.tokens.access_token)).scopes).toEqual([
      "tickets:read",
    ]);
  });

  it("never lets a token carry tickets:read_internal even if its claim says so", async () => {
    const flow = await runFlow({ cookie: aliceCookie, clientId });
    await world.sql`UPDATE oauth_consent SET scopes = ARRAY['tickets:read','tickets:read_internal','tickets:manage','tickets:reply'] WHERE user_id = ${ALICE}`;
    const token = await forgeToken({
      sub: ALICE,
      azp: clientId,
      scope: "tickets:read tickets:read_internal tickets:manage tickets:reply",
      iat: Math.floor(Date.now() / 1000) + 1,
    });
    void flow;
    const who = await whoami(token);
    expect(who.scopes).toEqual(["tickets:read"]);
  });

  it("stops a disabled client's tokens", async () => {
    const flow = await runFlow({ cookie: aliceCookie, clientId });
    await world.sql`UPDATE oauth_client SET disabled = true`;
    const { status, www } = await mcpStatus(flow.tokens.access_token);
    expect(status).toBe(401);
    expect(www).toContain('error_description="token revoked"');
  });

  it("does not accept a token minted before the grant it claims to ride on", async () => {
    const flow = await runFlow({ cookie: aliceCookie, clientId });
    // Revoke and re-grant: the old token predates the new grant.
    await world.sql`DELETE FROM oauth_consent WHERE user_id = ${ALICE}`;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 30_000);
    await runFlow({ cookie: aliceCookie, clientId });
    vi.useRealTimers();
    const { status, www } = await mcpStatus(flow.tokens.access_token);
    expect(status).toBe(401);
    expect(www).toContain('error_description="token revoked"');
  });
});

describe("refresh tokens", () => {
  it("rotates the refresh token and issues a fresh access token", async () => {
    const flow = await runFlow({ cookie: aliceCookie, clientId });
    const rt1 = flow.tokens.refresh_token ?? "";
    const res = await refresh(rt1);
    expect(res.status).toBe(200);
    const next = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(next.refresh_token).not.toBe(rt1);
    expect(next.access_token).not.toBe(flow.tokens.access_token);
    expect(next.scope.split(" ").sort()).toEqual(
      ["customers:read", "offline_access", "tickets:read"].sort()
    );
    expect(decodeJwtPayload(next.access_token).aud).toBe(MCP_OAUTH_RESOURCE);
    expect((await whoami(next.access_token)).authMethod).toBe("oauth");
  });

  it("answers an immediate retry with the very same tokens (30 s reuse window)", async () => {
    const flow = await runFlow({ cookie: aliceCookie, clientId });
    const rt1 = flow.tokens.refresh_token ?? "";
    const first = (await (await refresh(rt1)).json()) as {
      access_token: string;
      refresh_token: string;
    };
    const retry = await refresh(rt1);
    expect(retry.status).toBe(200);
    const again = (await retry.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(again).toMatchObject(first);
  });

  it("treats a reuse after the window as theft and kills the whole family", async () => {
    const flow = await runFlow({ cookie: aliceCookie, clientId });
    const rt1 = flow.tokens.refresh_token ?? "";
    const second = (await (await refresh(rt1)).json()) as {
      refresh_token: string;
    };
    await world.sql`UPDATE oauth_refresh_token SET rotation_replay_expires_at = now() - interval '1 minute' WHERE rotation_replay_expires_at IS NOT NULL`;
    const late = await refresh(rt1);
    expect(late.status).toBe(400);
    expect(((await late.json()) as { error: string }).error).toBe(
      "invalid_grant"
    );
    // The newest token is dead too.
    expect((await refresh(second.refresh_token)).status).toBe(400);
  });

  it("will not widen the scope on refresh", async () => {
    const flow = await runFlow({ cookie: aliceCookie, clientId });
    const res = await refresh(flow.tokens.refresh_token ?? "", {
      scope: "tickets:read customers:read tickets:write offline_access",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a refresh token presented by another client", async () => {
    const flow = await runFlow({ cookie: aliceCookie, clientId });
    const other = await createClient(adminCookie, { name: "Other" });
    const res = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: flow.tokens.refresh_token ?? "",
      client_id: other,
    });
    expect(res.status).toBe(400);
  });

  it("issues no refresh token without offline_access", async () => {
    const flow = await runFlow({
      cookie: aliceCookie,
      clientId,
      scope: "tickets:read customers:read",
    });
    expect(flow.tokens.refresh_token).toBeUndefined();
  });

  it("fails once the grant has been revoked", async () => {
    const flow = await runFlow({ cookie: aliceCookie, clientId });
    await world.sql`DELETE FROM oauth_consent WHERE user_id = ${ALICE}`;
    await world.sql`DELETE FROM oauth_refresh_token WHERE user_id = ${ALICE}`;
    expect((await refresh(flow.tokens.refresh_token ?? "")).status).toBe(400);
  });

  it("revokes a refresh token through RFC 7009", async () => {
    const flow = await runFlow({ cookie: aliceCookie, clientId });
    const rt = flow.tokens.refresh_token ?? "";
    const res = await authFetch("/oauth2/revoke", {
      form: {
        token: rt,
        token_type_hint: "refresh_token",
        client_id: clientId,
      },
    });
    expect(res.status).toBe(200);
    expect((await refresh(rt)).status).toBe(400);
    // A JWT access token is stateless: it stays good until it expires or the
    // grant is revoked (the documented limit of RFC 7009 for JWT tokens).
    expect((await mcpStatus(flow.tokens.access_token)).status).toBe(200);
  });

  it("ignores a revocation request for someone else's token", async () => {
    const flow = await runFlow({ cookie: aliceCookie, clientId });
    const other = await createClient(adminCookie, { name: "Other" });
    await authFetch("/oauth2/revoke", {
      form: {
        token: flow.tokens.refresh_token ?? "",
        token_type_hint: "refresh_token",
        client_id: other,
      },
    });
    expect((await refresh(flow.tokens.refresh_token ?? "")).status).toBe(200);
  });
});

describe("PAT compatibility", () => {
  it("keeps the PAT 401 headers exact apart from the discovery pointer", async () => {
    const revoked = await addToken(world.db, ALICE, {
      revokedAt: new Date(),
      revokedReason: "revoked_by_user",
    });
    const { status, www } = await mcpStatus(revoked.raw);
    expect(status).toBe(401);
    expect(www).toBe(
      `Bearer realm="docket", resource_metadata="${APP_URL}/.well-known/oauth-protected-resource/api/mcp", scope="tickets:read customers:read offline_access", error="invalid_token", error_description="token revoked"`
    );
  });

  it("still authenticates a PAT with its own scopes", async () => {
    const pat = await addToken(world.db, ALICE, {
      scopes: ["tickets:read", "tickets:write"],
    });
    const who = await whoami(pat.raw);
    expect(who.authMethod).toBe("pat");
    expect(who.scopes).toEqual(["tickets:read", "tickets:write"]);
  });

  it("does not let an OAuth token pose as a PAT or the reverse", async () => {
    const flow = await runFlow({ cookie: aliceCookie, clientId });
    expect((await mcpStatus(`dkm_${flow.tokens.access_token}`)).status).toBe(
      401
    );
  });
});

describe("misc protocol checks", () => {
  it("redirects with an issuer parameter on errors too (RFC 9207)", async () => {
    const { challenge } = pkce();
    const res = await authorize(aliceCookie, {
      clientId,
      challenge,
      scope: "tickets:read openid",
    });
    const target = new URL(res.headers.get("location") ?? "", APP_URL);
    expect(target.origin + target.pathname).toBe(REDIRECT_URI);
    expect(target.searchParams.get("iss")).toBe(ISSUER);
    expect(target.searchParams.get("state")).toBe("state-xyz");
  });

  it("answers an unknown client without redirecting anywhere", async () => {
    const { challenge } = pkce();
    const res = await authorize(aliceCookie, {
      clientId: "no-such-client",
      challenge,
    });
    const target = new URL(res.headers.get("location") ?? "", APP_URL);
    expect(target.origin).toBe(APP_URL);
    expect(target.searchParams.get("error")).toBe("invalid_client");
  });

  it("rejects a consent POST without the signed query", async () => {
    const res = await consent(aliceCookie, "", { accept: true });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
