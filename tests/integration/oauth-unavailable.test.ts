import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addToken, setupMcpWorld, USERS } from "./mcp-helpers";

// A deployment whose public URL is plain http on a real hostname cannot offer
// OAuth (tokens would cross the wire in the clear). It must still start, serve
// personal access tokens exactly as before, and say plainly that OAuth is off.
const world = setupMcpWorld();

const PLAIN_HTTP_URL = "http://docket.example.test";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "unavailable-test", version: "0.0.0" },
  },
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", PLAIN_HTTP_URL);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

async function postMcp(token?: string) {
  const { POST } = await import("@/app/api/mcp/route");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    // The app URL is not loopback, so no DNS-rebinding host check applies.
    host: "docket.example.test",
  };
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  return await POST(
    new NextRequest(`${PLAIN_HTTP_URL}/api/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(INITIALIZE),
    })
  );
}

describe("NEXT_PUBLIC_APP_URL is plain http on a non-loopback host", () => {
  it("loads the module graph and registers no OAuth plugins", async () => {
    const { auth } = await import("@/lib/auth");
    const ids = auth.options.plugins.map((p: { id: string }) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["admin", "magic-link"]));
    for (const oauth of ["jwt", "oauth-provider", "cimd"]) {
      expect(ids).not.toContain(oauth);
    }
    const warnings = warn.mock.calls
      .map((args: unknown[]) => String(args[0]))
      .filter((m: string) => m.includes("OAuth for MCP is disabled"));
    expect(warnings).toHaveLength(1);
    const { isOAuthAvailable } = await import("@/lib/oauth");
    expect(isOAuthAvailable()).toBe(false);
  });

  it("loads every route that touches the auth instance", async () => {
    await expect(
      import("@/app/api/auth/[...all]/route")
    ).resolves.toBeDefined();
    await expect(
      import("@/app/.well-known/oauth-protected-resource/[[...path]]/route")
    ).resolves.toBeDefined();
    await expect(
      import("@/app/.well-known/oauth-authorization-server/[[...path]]/route")
    ).resolves.toBeDefined();
  });

  it("answers discovery with the constant no-OAuth 404, for any path", async () => {
    const prm = await import(
      "@/app/.well-known/oauth-protected-resource/[[...path]]/route"
    );
    const meta = await import(
      "@/app/.well-known/oauth-authorization-server/[[...path]]/route"
    );
    for (const [get, name] of [
      [prm.GET, "oauth-protected-resource"],
      [meta.GET, "oauth-authorization-server"],
    ] as const) {
      for (const path of [[], ["api", "mcp"], ["api", "auth"], ["x", "y"]]) {
        const res = await get(
          new Request(`${PLAIN_HTTP_URL}/.well-known/${name}`),
          { params: Promise.resolve({ path: path.length ? path : undefined }) }
        );
        expect(res.status).toBe(404);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.json()).toEqual({
          error:
            "This server does not support OAuth. Use a personal access token.",
        });
      }
    }
  });

  it("does not route any OAuth endpoint under /api/auth", async () => {
    const route = await import("@/app/api/auth/[...all]/route");
    for (const path of ["/oauth2/authorize?client_id=x", "/jwks", "/token"]) {
      const res = await route.GET(
        new Request(`${PLAIN_HTTP_URL}/api/auth${path}`)
      );
      expect(res.status, path).toBe(404);
    }
  });

  it("keeps the 401 challenge byte-for-byte as before", async () => {
    const missing = await postMcp();
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe(
      'Bearer realm="docket"'
    );

    const bogus = await postMcp("dkm_unknownunknownunknown");
    expect(bogus.status).toBe(401);
    expect(bogus.headers.get("www-authenticate")).toBe(
      'Bearer realm="docket", error="invalid_token", error_description="invalid token"'
    );

    // A JWT-shaped bearer is just an invalid token here: nothing parses it.
    const jwtLike = await postMcp("aaa.bbb.ccc");
    expect(jwtLike.status).toBe(401);
    expect(jwtLike.headers.get("www-authenticate")).toBe(
      'Bearer realm="docket", error="invalid_token", error_description="invalid token"'
    );
  });

  it("still serves personal access tokens", async () => {
    const pat = await addToken(world.db, USERS.alice.id);
    const res = await postMcp(pat.raw);
    expect(res.status).toBe(200);
  });
});
