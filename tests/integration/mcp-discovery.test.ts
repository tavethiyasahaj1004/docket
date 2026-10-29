import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as authServerGet } from "@/app/.well-known/oauth-authorization-server/[[...path]]/route";
import { GET as resourceGet } from "@/app/.well-known/oauth-protected-resource/[[...path]]/route";
import {
  GET as authGet,
  POST as authPost,
} from "@/app/api/auth/[...all]/route";
import { setupMcpWorld } from "./mcp-helpers";
import { APP_URL, ISSUER } from "./oauth-helpers";

const world = setupMcpWorld();

const NOT_SUPPORTED = {
  error: "This server does not support OAuth. Use a personal access token.",
};

function discover(
  get: typeof resourceGet,
  name: string,
  path: string[] = []
): Promise<Response> {
  const url = `${APP_URL}/.well-known/${[name, ...path].join("/")}`;
  return get(new Request(url), {
    params: Promise.resolve({ path: path.length ? path : undefined }),
  });
}

const prm = (path?: string[]) =>
  discover(resourceGet, "oauth-protected-resource", path);
const asMeta = (path?: string[]) =>
  discover(authServerGet, "oauth-authorization-server", path);

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("protected resource metadata (RFC 9728)", () => {
  it.each([[[]], [["api", "mcp"]]])("is served at path %j", async (path) => {
    const res = await prm(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      resource: `${APP_URL}/api/mcp`,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      scopes_supported: [
        "tickets:read",
        "customers:read",
        "tickets:write",
        "reports:read",
      ],
    });
  });

  it.each([
    [["api"]],
    [["api", "auth"]],
    [["api", "mcp", "extra"]],
    [["a", "b", "c"]],
    [["mcp"]],
  ])("answers 404 for the unknown sub-path %j", async (path) => {
    const res = await prm(path);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found." });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("authorization server metadata (RFC 8414)", () => {
  it.each([[[]], [["api", "auth"]]])("is served at path %j", async (path) => {
    const res = await asMeta(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const meta = await res.json();

    expect(meta.issuer).toBe(ISSUER);
    expect(meta.authorization_endpoint).toBe(`${ISSUER}/oauth2/authorize`);
    expect(meta.token_endpoint).toBe(`${ISSUER}/oauth2/token`);
    expect(meta.revocation_endpoint).toBe(`${ISSUER}/oauth2/revoke`);
    expect(meta.jwks_uri).toBe(`${ISSUER}/jwks`);
    expect(meta.response_types_supported).toEqual(["code"]);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect([...meta.grant_types_supported].sort()).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
    expect(meta.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
    expect([...meta.scopes_supported].sort()).toEqual(
      [
        "offline_access",
        "tickets:read",
        "customers:read",
        "tickets:write",
        "reports:read",
      ].sort()
    );
    // No dynamic registration, no introspection, no openid.
    expect(meta.registration_endpoint).toBeUndefined();
    expect(meta.introspection_endpoint).toBeUndefined();
    expect(meta.scopes_supported).not.toContain("openid");
  });

  it.each([
    [["api"]],
    [["api", "mcp"]],
    [["x", "y"]],
    [["api", "auth", "z"]],
  ])("answers 404 for the unknown sub-path %j", async (path) => {
    const res = await asMeta(path);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found." });
  });
});

describe("when MCP is switched off", () => {
  beforeEach(async () => {
    await world.sql`UPDATE platform_settings SET mcp_enabled = false`;
  });

  it("serves the constant no-OAuth 404 from both discovery routes", async () => {
    for (const res of [
      await prm(),
      await prm(["api", "mcp"]),
      await asMeta(),
      await asMeta(["api", "auth"]),
      // Even an unknown sub-path gives the same answer: nothing is revealed.
      await prm(["zzz"]),
      await asMeta(["zzz"]),
    ]) {
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.json()).toEqual(NOT_SUPPORTED);
    }
  });

  it("answers the same when no settings row exists at all", async () => {
    await world.sql`DELETE FROM platform_settings`;
    expect((await prm()).status).toBe(404);
    expect(await (await asMeta()).json()).toEqual(NOT_SUPPORTED);
  });

  it("makes every OAuth endpoint under /api/auth refuse", async () => {
    for (const [path, method] of [
      ["/oauth2/authorize?client_id=x", "GET"],
      ["/oauth2/token", "POST"],
      ["/oauth2/consent", "POST"],
      ["/oauth2/revoke", "POST"],
      ["/jwks", "GET"],
    ] as const) {
      const request = new Request(`${APP_URL}/api/auth${path}`, {
        method,
        headers: { "content-type": "application/json", origin: APP_URL },
        body: method === "POST" ? "{}" : undefined,
      });
      const res = await (method === "GET"
        ? authGet(request)
        : authPost(request));
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json()).toEqual({
        error: "MCP is disabled on this server.",
      });
    }
  });
});

describe("the /api/auth surface exposes only what Docket uses", () => {
  const blocked: [string, "GET" | "POST"][] = [
    ["/oauth2/register", "POST"],
    ["/oauth2/create-client", "POST"],
    ["/oauth2/get-clients", "GET"],
    ["/oauth2/get-client", "GET"],
    ["/oauth2/update-client", "POST"],
    ["/oauth2/delete-client", "POST"],
    ["/oauth2/client/rotate-secret", "POST"],
    ["/oauth2/introspect", "POST"],
    ["/oauth2/userinfo", "GET"],
    ["/oauth2/end-session", "GET"],
    ["/oauth2/get-consents", "GET"],
    ["/oauth2/delete-consent", "POST"],
    ["/oauth2/update-consent", "POST"],
    ["/oauth2/public-client", "GET"],
    ["/oauth2/continue", "POST"],
    ["/admin/oauth2/create-client", "POST"],
    ["/admin/oauth2/resources/x", "GET"],
    ["/token", "GET"],
    ["/.well-known/oauth-authorization-server", "GET"],
    ["/.well-known/openid-configuration", "GET"],
    ["/mcp/anything", "GET"],
  ];

  it.each(blocked)("%s is not routable", async (path, method) => {
    const request = new Request(`${APP_URL}/api/auth${path}`, {
      method,
      headers: { "content-type": "application/json", origin: APP_URL },
      body: method === "POST" ? "{}" : undefined,
    });
    const res = await (method === "GET" ? authGet(request) : authPost(request));
    expect(res.status).toBe(404);
  });

  it("rejects the wrong method on an allowed endpoint", async () => {
    const res = await authGet(new Request(`${APP_URL}/api/auth/oauth2/token`));
    expect(res.status).toBe(405);
  });
});
