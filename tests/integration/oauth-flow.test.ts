import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_OAUTH_RESOURCE } from "@/lib/oauth";
import { addToken, setupMcpWorld, USERS } from "./mcp-helpers";
import { callTool, closeMcpClients, connectMcp } from "./mcp-read-helpers";
import {
  APP_URL,
  authFetch,
  authorize,
  consent,
  consentRow,
  createClient,
  decodeJwtPayload,
  ISSUER,
  LOOPBACK_REDIRECT_URI,
  locationQuery,
  pkce,
  REDIRECT_URI,
  runFlow,
  seedResource,
  signInAs,
  tokenRequest,
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
  await closeMcpClients();
  vi.restoreAllMocks();
});

async function whoami(token: string) {
  const client = await connectMcp(token);
  const result = await callTool(client, "whoami");
  return result.data as {
    authMethod: string;
    scopes: string[];
    credential: { id: string; name: string };
    user: { id: string; role: string };
    tools: string[];
  };
}

describe("authorize -> consent -> token -> MCP", () => {
  it("connects an assistant and acts as the user with the granted scopes", async () => {
    const flow = await runFlow({ cookie: aliceCookie, clientId });

    // The redirect carries the state we sent, unchanged, and the issuer (RFC 9207).
    expect(flow.redirect.origin + flow.redirect.pathname).toBe(REDIRECT_URI);
    expect(flow.redirect.searchParams.get("state")).toBe("state-xyz");
    expect(flow.redirect.searchParams.get("iss")).toBe(ISSUER);

    const t = flow.tokens;
    expect(t.token_type).toBe("Bearer");
    expect(t.expires_in).toBe(3600);
    expect(t.refresh_token).toBeTruthy();
    expect(t.scope.split(" ").sort()).toEqual(
      ["customers:read", "offline_access", "tickets:read"].sort()
    );
    expect(t).not.toHaveProperty("id_token");

    const claims = decodeJwtPayload(t.access_token);
    expect(claims).toMatchObject({
      iss: ISSUER,
      aud: MCP_OAUTH_RESOURCE,
      sub: ALICE,
      azp: clientId,
    });
    expect(claims.cnf).toBeUndefined();

    const who = await whoami(t.access_token);
    expect(who.authMethod).toBe("oauth");
    expect(who.user).toMatchObject({ id: ALICE, role: "agent" });
    expect(who.scopes).toEqual(["tickets:read", "customers:read"]);
    expect(who.credential).toMatchObject({
      id: clientId,
      name: "Test Assistant",
    });
    expect(who.tools).toContain("list_tickets");
    expect(who.tools).not.toContain("save_reply_draft");
  });

  it("echoes an awkward state value exactly", async () => {
    const { challenge } = pkce();
    const state = "a b&c=d/é?%20#x";
    const res = await authorize(aliceCookie, { clientId, challenge, state });
    expect(res.status).toBe(302);
    // The consent page gets it inside the signed query...
    const q = locationQuery(res);
    expect(q.get("state")).toBe(state);
    // ...and denying returns it untouched to the client.
    const denied = await consent(
      aliceCookie,
      new URL(res.headers.get("location") ?? "", APP_URL).search.slice(1),
      { accept: false }
    );
    const { url } = (await denied.json()) as { url: string };
    expect(new URL(url).searchParams.get("state")).toBe(state);
  });

  it("binds the token to the MCP resource even when the client names none", async () => {
    const { verifier, challenge } = pkce();
    const res = await authorize(aliceCookie, {
      clientId,
      challenge,
      resource: null,
    });
    expect(locationQuery(res).get("resource")).toBe(MCP_OAUTH_RESOURCE);
    const accepted = await consent(
      aliceCookie,
      new URL(res.headers.get("location") ?? "", APP_URL).search.slice(1),
      { accept: true }
    );
    const { url } = (await accepted.json()) as { url: string };
    const code = new URL(url).searchParams.get("code") ?? "";
    // The token request also names no resource.
    const token = await tokenRequest({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(token.status).toBe(200);
    const body = (await token.json()) as { access_token: string };
    expect(decodeJwtPayload(body.access_token).aud).toBe(MCP_OAUTH_RESOURCE);
    expect((await whoami(body.access_token)).authMethod).toBe("oauth");
  });

  it("lets a PAT and an OAuth token work side by side for one user", async () => {
    const pat = await addToken(world.db, ALICE);
    const flow = await runFlow({ cookie: aliceCookie, clientId });
    const viaPat = await whoami(pat.raw);
    const viaOauth = await whoami(flow.tokens.access_token);
    expect(viaPat.authMethod).toBe("pat");
    expect(viaOauth.authMethod).toBe("oauth");
    expect(viaPat.user.id).toBe(viaOauth.user.id);
  });

  it("reuses the existing consent without asking again for the same scopes", async () => {
    await runFlow({ cookie: aliceCookie, clientId });
    const { challenge } = pkce();
    const again = await authorize(aliceCookie, { clientId, challenge });
    expect(again.status).toBe(302);
    const target = new URL(again.headers.get("location") ?? "");
    expect(target.origin + target.pathname).toBe(REDIRECT_URI);
    expect(target.searchParams.get("code")).toBeTruthy();
  });

  it("asks again when a client wants more than was granted", async () => {
    await runFlow({ cookie: aliceCookie, clientId });
    const { challenge } = pkce();
    const more = await authorize(aliceCookie, {
      clientId,
      challenge,
      scope: "tickets:read customers:read tickets:write offline_access",
    });
    expect(new URL(more.headers.get("location") ?? "", APP_URL).pathname).toBe(
      "/oauth/consent"
    );
  });

  it("sends a signed-out browser to the login page with the signed query", async () => {
    const { challenge } = pkce();
    const res = await authorize(undefined, { clientId, challenge });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "", APP_URL);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("sig")).toBeTruthy();
    expect(location.searchParams.get("client_id")).toBe(clientId);
  });

  it("resumes the authorization after a password sign-in", async () => {
    const { challenge } = pkce();
    const res = await authorize(undefined, { clientId, challenge });
    const login = new URL(res.headers.get("location") ?? "", APP_URL);
    // What the sign-in form posts: credentials plus the page's signed query.
    const signIn = await authFetch("/sign-in/email", {
      json: {
        email: USERS.alice.email,
        password: "correct horse battery staple",
        oauth_query: login.search.slice(1),
      },
    });
    expect(signIn.ok).toBe(true);
    const body = (await signIn.json()) as { redirect?: boolean; url?: string };
    expect(body.redirect).toBe(true);
    expect(new URL(body.url ?? "", APP_URL).pathname).toBe("/oauth/consent");
  });

  it("rejects a tampered signed query on sign-in", async () => {
    const { challenge } = pkce();
    const res = await authorize(undefined, { clientId, challenge });
    const login = new URL(res.headers.get("location") ?? "", APP_URL);
    login.searchParams.set("scope", "tickets:read customers:read reports:read");
    const signIn = await authFetch("/sign-in/email", {
      json: {
        email: USERS.alice.email,
        password: "correct horse battery staple",
        oauth_query: login.search.slice(1),
      },
    });
    expect(signIn.status).toBe(400);
  });
});

describe("PKCE", () => {
  async function redirectError(params: Parameters<typeof authorize>[1]) {
    const res = await authorize(aliceCookie, params);
    expect(res.status).toBe(302);
    const target = new URL(res.headers.get("location") ?? "", APP_URL);
    return target;
  }

  it("refuses an authorization request without a code_challenge", async () => {
    const target = await redirectError({ clientId, challenge: null });
    expect(target.origin + target.pathname).toBe(REDIRECT_URI);
    expect(target.searchParams.get("error")).toBe("invalid_request");
    expect(target.searchParams.get("code")).toBeNull();
    expect(await consentRow(world, ALICE, clientId)).toBeUndefined();
  });

  it("refuses the plain method", async () => {
    const target = await redirectError({
      clientId,
      challenge: "plain-challenge-value",
      method: "plain",
    });
    expect(target.searchParams.get("error")).toBe("invalid_request");
    expect(target.searchParams.get("code")).toBeNull();
  });

  it("refuses a challenge with no method", async () => {
    const res = await authFetch(
      `/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=abc&scope=tickets%3Aread&resource=${encodeURIComponent(MCP_OAUTH_RESOURCE)}`,
      { cookie: aliceCookie }
    );
    const target = new URL(res.headers.get("location") ?? "", APP_URL);
    expect(target.searchParams.get("error")).toBe("invalid_request");
  });

  it("rejects a wrong code_verifier and burns the code", async () => {
    const { challenge } = pkce();
    const res = await authorize(aliceCookie, { clientId, challenge });
    const accepted = await consent(
      aliceCookie,
      new URL(res.headers.get("location") ?? "", APP_URL).search.slice(1),
      { accept: true }
    );
    const { url } = (await accepted.json()) as { url: string };
    const code = new URL(url).searchParams.get("code") ?? "";

    const wrong = await tokenRequest({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce().verifier,
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe(
      "invalid_grant"
    );
  });

  it("rejects a missing code_verifier", async () => {
    const { challenge } = pkce();
    const res = await authorize(aliceCookie, { clientId, challenge });
    const accepted = await consent(
      aliceCookie,
      new URL(res.headers.get("location") ?? "", APP_URL).search.slice(1),
      { accept: true }
    );
    const { url } = (await accepted.json()) as { url: string };
    const code = new URL(url).searchParams.get("code") ?? "";
    const missing = await tokenRequest({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    });
    expect(missing.status).toBe(400);
  });

  it("accepts a code only once", async () => {
    const { verifier, challenge } = pkce();
    const res = await authorize(aliceCookie, { clientId, challenge });
    const accepted = await consent(
      aliceCookie,
      new URL(res.headers.get("location") ?? "", APP_URL).search.slice(1),
      { accept: true }
    );
    const { url } = (await accepted.json()) as { url: string };
    const code = new URL(url).searchParams.get("code") ?? "";
    const form = {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    };
    expect((await tokenRequest(form)).status).toBe(200);
    expect((await tokenRequest(form)).status).toBe(400);
  });

  it("rejects a token request with a different redirect_uri", async () => {
    const { verifier, challenge } = pkce();
    const res = await authorize(aliceCookie, { clientId, challenge });
    const accepted = await consent(
      aliceCookie,
      new URL(res.headers.get("location") ?? "", APP_URL).search.slice(1),
      { accept: true }
    );
    const { url } = (await accepted.json()) as { url: string };
    const code = new URL(url).searchParams.get("code") ?? "";
    const swapped = await tokenRequest({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: LOOPBACK_REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(swapped.status).toBe(400);
  });
});

describe("redirect URIs", () => {
  async function attempt(redirectUri: string) {
    const { challenge } = pkce();
    const res = await authorize(aliceCookie, {
      clientId,
      challenge,
      redirectUri,
    });
    const location = res.headers.get("location") ?? "";
    return { status: res.status, location, target: new URL(location, APP_URL) };
  }

  it.each([
    ["an unregistered host", "https://evil.example.test/callback"],
    ["a different path", "https://assistant.example.test/other"],
    ["a trailing path segment", "https://assistant.example.test/callback/x"],
    ["a query added", "https://assistant.example.test/callback?x=1"],
    ["a subdomain", "https://a.assistant.example.test/callback"],
    ["a different port", "https://assistant.example.test:8443/callback"],
    ["userinfo in front", "https://x@assistant.example.test/callback"],
  ])("never redirects to %s", async (_label, uri) => {
    const { target, location } = await attempt(uri);
    expect(target.origin).toBe(APP_URL);
    expect(location).not.toContain("evil.example.test");
    expect(target.searchParams.get("code")).toBeNull();
    expect(target.searchParams.get("error")).toBe("invalid_redirect");
  });

  it.each([
    ["http instead of https", "http://assistant.example.test/callback"],
    ["a look-alike loopback host", "http://localhost.evil.test:33418/callback"],
  ])("never redirects to %s", async (_label, uri) => {
    const { target, location } = await attempt(uri);
    expect(target.origin).toBe(APP_URL);
    expect(location).not.toContain("evil.example.test");
    expect(target.searchParams.get("code")).toBeNull();
    expect(["invalid_redirect", "invalid_request"]).toContain(
      target.searchParams.get("error")
    );
  });

  it("accepts a loopback redirect on a different port", async () => {
    const { target } = await attempt("http://127.0.0.1:50001/callback");
    expect(target.pathname).toBe("/oauth/consent");
  });

  it("rejects a loopback redirect on a different path", async () => {
    const { target } = await attempt("http://127.0.0.1:50001/elsewhere");
    expect(target.searchParams.get("error")).toBe("invalid_redirect");
  });

  it("cannot register a non-loopback http redirect URI", async () => {
    await expect(
      createClient(adminCookie, {
        redirectUris: ["http://assistant.example.test/callback"],
      })
    ).rejects.toThrow();
  });

  it("cannot register a client with a scope Docket never issues", async () => {
    await expect(
      createClient(adminCookie, {
        scope: "tickets:read tickets:read_internal",
      })
    ).rejects.toThrow();
  });
});

describe("consent", () => {
  async function toConsent(
    cookie: string,
    scope = "tickets:read customers:read tickets:write offline_access"
  ) {
    const { challenge } = pkce();
    const res = await authorize(cookie, { clientId, challenge, scope });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "", APP_URL);
    expect(location.pathname).toBe("/oauth/consent");
    return location.search.slice(1);
  }

  it("redirects a denial to the client with access_denied and the state", async () => {
    const query = await toConsent(aliceCookie);
    const denied = await consent(aliceCookie, query, { accept: false });
    expect(denied.status).toBe(200);
    const { url } = (await denied.json()) as { url: string };
    const target = new URL(url);
    expect(target.origin + target.pathname).toBe(REDIRECT_URI);
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("state")).toBe("state-xyz");
    expect(target.searchParams.get("code")).toBeNull();
    expect(await consentRow(world, ALICE, clientId)).toBeUndefined();
  });

  it("downgrades the grant to what the user left ticked", async () => {
    const flow = await runFlow({
      cookie: aliceCookie,
      clientId,
      scope: "tickets:read customers:read tickets:write offline_access",
      grant: "tickets:read customers:read offline_access",
    });
    expect(flow.tokens.scope.split(" ")).not.toContain("tickets:write");
    const who = await whoami(flow.tokens.access_token);
    expect(who.scopes).toEqual(["tickets:read", "customers:read"]);
    expect(who.tools).not.toContain("save_reply_draft");
    expect(who.tools).not.toContain("update_ticket_tags");

    // The same client given tickets:write does get the write tools.
    const full = await runFlow({
      cookie: aliceCookie,
      clientId,
      scope: "tickets:read customers:read tickets:write offline_access",
    });
    const fullWho = await whoami(full.tokens.access_token);
    expect(fullWho.scopes).toContain("tickets:write");
    expect(fullWho.tools).toContain("save_reply_draft");
  });

  it("rejects granting a scope the client never asked for", async () => {
    const query = await toConsent(aliceCookie, "tickets:read offline_access");
    const res = await consent(aliceCookie, query, {
      accept: true,
      scope: "tickets:read tickets:write",
    });
    expect(res.status).toBe(400);
    expect(await consentRow(world, ALICE, clientId)).toBeUndefined();
  });

  it("stores the narrowed scopes on the grant", async () => {
    const query = await toConsent(aliceCookie);
    await consent(aliceCookie, query, {
      accept: true,
      scope: "tickets:read offline_access",
    });
    const row = await consentRow(world, ALICE, clientId);
    expect([...row.scopes].sort()).toEqual(["offline_access", "tickets:read"]);
  });

  describe("server-side enforcement (a hand-made request, not the page)", () => {
    it("refuses an agent granting reports:read (explicit scope)", async () => {
      const query = await toConsent(
        aliceCookie,
        "tickets:read reports:read offline_access"
      );
      const res = await consent(aliceCookie, query, {
        accept: true,
        scope: "tickets:read reports:read",
      });
      expect(res.status).toBe(403);
      expect(await consentRow(world, ALICE, clientId)).toBeUndefined();
    });

    it("refuses an agent granting reports:read (scope taken from the request)", async () => {
      const query = await toConsent(
        aliceCookie,
        "tickets:read reports:read offline_access"
      );
      const res = await consent(aliceCookie, query, { accept: true });
      expect(res.status).toBe(403);
      expect(await consentRow(world, ALICE, clientId)).toBeUndefined();
    });

    it("lets an admin grant reports:read", async () => {
      const flow = await runFlow({
        cookie: adminCookie,
        clientId,
        scope: "tickets:read reports:read offline_access",
      });
      const who = await whoami(flow.tokens.access_token);
      expect(who.scopes).toEqual(["tickets:read", "reports:read"]);
      expect(who.user.role).toBe("admin");
    });

    it("refuses a plain 'user' role", async () => {
      const dave = await signInAs(world, USERS.dave.id, USERS.dave.email);
      const query = await toConsent(dave, "tickets:read offline_access");
      const res = await consent(dave, query, { accept: true });
      expect(res.status).toBe(403);
      expect(await consentRow(world, USERS.dave.id, clientId)).toBeUndefined();
    });

    it("refuses a user banned after signing in", async () => {
      const query = await toConsent(aliceCookie, "tickets:read offline_access");
      await world.sql`UPDATE "user" SET banned = true WHERE id = ${ALICE}`;
      const res = await consent(aliceCookie, query, { accept: true });
      expect(res.status).toBe(403);
      expect(await consentRow(world, ALICE, clientId)).toBeUndefined();
    });

    it("refuses a user demoted after signing in", async () => {
      const query = await toConsent(aliceCookie, "tickets:read offline_access");
      await world.sql`UPDATE "user" SET role = 'user' WHERE id = ${ALICE}`;
      const res = await consent(aliceCookie, query, { accept: true });
      expect(res.status).toBe(403);
    });

    it("refuses an impersonated session", async () => {
      const query = await toConsent(aliceCookie, "tickets:read offline_access");
      await world.sql`UPDATE session SET impersonated_by = ${BOB} WHERE user_id = ${ALICE}`;
      const res = await consent(aliceCookie, query, { accept: true });
      expect(res.status).toBe(403);
      expect(await consentRow(world, ALICE, clientId)).toBeUndefined();
    });

    it("still lets an ineligible user deny", async () => {
      const dave = await signInAs(world, USERS.dave.id, USERS.dave.email);
      const query = await toConsent(dave, "tickets:read offline_access");
      const res = await consent(dave, query, { accept: false });
      expect(res.status).toBe(200);
    });

    it("refuses to issue a code from a stale consent once the user is impersonated", async () => {
      await runFlow({ cookie: aliceCookie, clientId });
      await world.sql`UPDATE session SET impersonated_by = ${BOB} WHERE user_id = ${ALICE}`;
      const { challenge } = pkce();
      const res = await authorize(aliceCookie, { clientId, challenge });
      // The consent exists, so the provider would mint a code; the code policy
      // stops it. No redirect carrying a code.
      expect(res.headers.get("location") ?? "").not.toContain("code=");
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("cannot obtain tickets:read_internal, tickets:manage or tickets:reply", async () => {
      for (const scope of [
        "tickets:read_internal",
        "tickets:manage",
        "tickets:reply",
        "openid",
      ]) {
        const { challenge } = pkce();
        const res = await authorize(aliceCookie, {
          clientId,
          challenge,
          scope: `tickets:read ${scope}`,
        });
        const target = new URL(res.headers.get("location") ?? "", APP_URL);
        expect(target.searchParams.get("error"), scope).toBe("invalid_scope");
        expect(target.searchParams.get("code")).toBeNull();
      }
      const query = await toConsent(aliceCookie, "tickets:read offline_access");
      const res = await consent(aliceCookie, query, {
        accept: true,
        scope: "tickets:read_internal",
      });
      expect(res.ok).toBe(false);
      expect(await consentRow(world, ALICE, clientId)).toBeUndefined();
    });
  });
});

describe("dynamic registration and unsupported grants are not available", () => {
  it("has no registration endpoint", async () => {
    const res = await authFetch("/oauth2/register", {
      json: { redirect_uris: ["https://evil.example.test/cb"] },
    });
    // Disabled in the library, and not routable over HTTP at all.
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("client_id");
  });

  it("does not issue client_credentials tokens", async () => {
    const res = await tokenRequest({
      grant_type: "client_credentials",
      client_id: clientId,
      scope: "tickets:read",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).not.toContain("access_token");
  });
});
