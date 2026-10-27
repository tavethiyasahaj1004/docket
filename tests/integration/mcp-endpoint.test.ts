import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE as accountRevoke } from "@/app/api/account/mcp-tokens/[id]/route";
import { DELETE as adminRevoke } from "@/app/api/admin/mcp/tokens/[id]/route";
import { DELETE as mcpDelete, GET as mcpGet } from "@/app/api/mcp/route";
import { env } from "@/lib/env";
import { hashMcpToken } from "@/lib/mcp-tokens";
import { callMcp, INITIALIZE_BODY, retryAfter } from "./mcp-endpoint-helpers";
import { addToken, PAST, setupMcpWorld, USERS } from "./mcp-helpers";

const world = setupMcpWorld();

const ALICE = USERS.alice.id; // agent
const BOB = USERS.bob.id; // admin
const CAROL = USERS.carol.id; // agent, banned

const asUser = (
  u: { id: string; name: string; email: string },
  role: string
) => ({
  "x-user-id": u.id,
  "x-user-name": u.name,
  "x-user-email": u.email,
  "x-user-role": role,
});
const ALICE_HEADERS = asUser(USERS.alice, "agent");
const BOB_HEADERS = asUser(USERS.bob, "admin");

async function lastUsedAt(tokenId: string) {
  const [row] = await world.sql`
    SELECT last_used_at FROM mcp_access_tokens WHERE id = ${tokenId}`;
  return row.last_used_at as string | null;
}

async function setEnabled(enabled: boolean) {
  await world.sql`UPDATE platform_settings SET mcp_enabled = ${enabled}`;
}

const consoleText = (spies: { mock: { calls: unknown[][] } }[]) =>
  spies
    .flatMap((s) => s.mock.calls)
    .map((args) => args.map((a) => String(a)).join(" "))
    .join("\n");

let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("disabled by default", () => {
  it("a fresh database has MCP off", async () => {
    await world.sql`DELETE FROM platform_settings`;
    await world.sql`INSERT INTO platform_settings (id) VALUES ('default')`;
    const [row] = await world.sql`SELECT mcp_enabled FROM platform_settings`;
    expect(row.mcp_enabled).toBe(false);
  });

  it("answers 404 with or without a token, before auth, and never touches last_used_at", async () => {
    await setEnabled(false);
    const token = await addToken(world.db, ALICE);

    for (const options of [{ token: token.raw }, {}, { token: "dkm_bogus" }]) {
      const res = await callMcp(options);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(await res.json()).toEqual({
        error: "MCP is disabled on this server.",
      });
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(await lastUsedAt(token.id)).toBeNull();
  });

  it("is also disabled when there is no settings row at all", async () => {
    await world.sql`DELETE FROM platform_settings`;
    const token = await addToken(world.db, ALICE);
    const res = await callMcp({ token: token.raw });
    expect(res.status).toBe(404);
  });
});

describe("authentication failures", () => {
  const BASIC_CHALLENGE = 'Bearer realm="docket"';

  it("answers a missing token with the bare challenge and no error param", async () => {
    const cases = [
      {},
      { authorization: "Basic dXNlcjpwYXNz" },
      { authorization: "Bearer " },
      { authorization: "Bearer" },
      { authorization: "   " },
    ];
    for (const options of cases) {
      const res = await callMcp(options);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(BASIC_CHALLENGE);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "Missing bearer token." });
    }
    expect(consoleText([warn])).toContain(
      "[mcp] auth_failed reason=missing prefix=none"
    );
  });

  it("accepts the Bearer scheme case-insensitively", async () => {
    const token = await addToken(world.db, ALICE);
    const res = await callMcp({ authorization: `bearer ${token.raw}` });
    expect(res.status).toBe(200);
  });

  it("rejects an expired token without touching last_used_at", async () => {
    const token = await addToken(world.db, ALICE, { expiresAt: PAST });
    const res = await callMcp({ token: token.raw });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer realm="docket", error="invalid_token", error_description="token expired"'
    );
    expect(await res.json()).toEqual({ error: "token expired" });
    await new Promise((r) => setTimeout(r, 100));
    expect(await lastUsedAt(token.id)).toBeNull();
  });

  it("treats a token expiring exactly now as expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T10:00:30.000Z"));
    const token = await addToken(world.db, ALICE, {
      expiresAt: new Date(Date.now()),
    });
    const res = await callMcp({ token: token.raw });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "token expired" });

    // One millisecond earlier it would still be valid.
    vi.setSystemTime(new Date("2026-06-01T10:00:29.999Z"));
    expect((await callMcp({ token: token.raw })).status).toBe(200);
  });

  it("rejects a token revoked through the account API on the next call", async () => {
    const token = await addToken(world.db, ALICE);
    expect((await callMcp({ token: token.raw })).status).toBe(200);

    const revoke = await accountRevoke(
      new NextRequest(
        `http://localhost:3000/api/account/mcp-tokens/${token.id}`,
        {
          method: "DELETE",
          headers: ALICE_HEADERS,
        }
      ),
      { params: Promise.resolve({ id: token.id }) }
    );
    expect(revoke.status).toBe(200);

    const res = await callMcp({ token: token.raw });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer realm="docket", error="invalid_token", error_description="token revoked"'
    );
    expect(await res.json()).toEqual({ error: "token revoked" });
  });

  it("rejects a token revoked through the admin API on the next call", async () => {
    const token = await addToken(world.db, ALICE);
    expect((await callMcp({ token: token.raw })).status).toBe(200);

    const revoke = await adminRevoke(
      new NextRequest(
        `http://localhost:3000/api/admin/mcp/tokens/${token.id}`,
        {
          method: "DELETE",
          headers: BOB_HEADERS,
        }
      ),
      { params: Promise.resolve({ id: token.id }) }
    );
    expect(revoke.status).toBe(200);

    const res = await callMcp({ token: token.raw });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "token revoked" });
  });

  it("rejects a token whose owner is not permitted", async () => {
    const token = await addToken(world.db, CAROL);
    const res = await callMcp({ token: token.raw });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "account not permitted" });
  });

  it("says only 'invalid token' for a wrong prefix or an unknown dkm_ token", async () => {
    for (const raw of [
      "abc123",
      "dk_live_something",
      "dkm_doesnotexistatall",
    ]) {
      const res = await callMcp({ token: raw });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(
        'Bearer realm="docket", error="invalid_token", error_description="invalid token"'
      );
      expect(await res.json()).toEqual({ error: "invalid token" });
    }
  });

  it("logs the prefix and reason but never the token or its hash", async () => {
    const expired = await addToken(world.db, ALICE, { expiresAt: PAST });
    const unknown = "dkm_unknownsecretmaterial0123456789";
    await callMcp({ token: expired.raw });
    await callMcp({ token: unknown });
    await callMcp({ token: "plainsecretwithoutprefix" });

    const text = consoleText([warn, log, error]);
    expect(text).toContain(
      `[mcp] auth_failed reason=expired prefix=${expired.raw.slice(0, 12)}`
    );
    expect(text).toContain(
      "[mcp] auth_failed reason=invalid prefix=dkm_unknown"
    );
    expect(text).toContain("[mcp] auth_failed reason=invalid prefix=none");
    expect(text).not.toContain(expired.raw);
    expect(text).not.toContain(expired.hash);
    expect(text).not.toContain(hashMcpToken(unknown));
    expect(text).not.toContain(unknown);
    expect(text).not.toContain("plainsecretwithoutprefix");
  });
});

describe("origin and host", () => {
  it("rejects a disallowed Origin with 403, before auth", async () => {
    const res = await callMcp({ headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Origin not allowed." });
  });

  it("accepts the app origin, an allowed-list origin, and no Origin", async () => {
    const token = await addToken(world.db, ALICE);
    const previous = env.MCP_ALLOWED_ORIGINS;
    env.MCP_ALLOWED_ORIGINS = "https://tools.example.com, http://other.test";
    try {
      for (const origin of [
        undefined,
        "http://localhost:3000",
        "https://tools.example.com",
        "http://other.test",
      ]) {
        const res = await callMcp({
          token: token.raw,
          headers: origin ? { origin } : {},
        });
        expect(res.status, String(origin)).toBe(200);
      }
      const denied = await callMcp({
        token: token.raw,
        headers: { origin: "https://tools.example.com.evil.test" },
      });
      expect(denied.status).toBe(403);
    } finally {
      env.MCP_ALLOWED_ORIGINS = previous;
    }
  });

  it("rejects a non-loopback Host when the app URL is loopback", async () => {
    const token = await addToken(world.db, ALICE);
    const bad = await callMcp({
      token: token.raw,
      headers: { host: "evil.example" },
    });
    expect(bad.status).toBe(403);
    expect(await bad.json()).toEqual({ error: "Host not allowed." });

    const good = await callMcp({
      token: token.raw,
      headers: { host: "localhost:3000" },
    });
    expect(good.status).toBe(200);
  });
});

describe("request shape", () => {
  const OVER = 1_048_577;

  it("rejects a body over 1 MB with 413, with and without a token", async () => {
    const token = await addToken(world.db, ALICE);
    const body = "x".repeat(OVER);
    for (const options of [{ token: token.raw }, {}]) {
      const res = await callMcp({ ...options, body });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "Request body too large." });
    }
    const declared = await callMcp({
      token: token.raw,
      body,
      headers: { "content-length": String(OVER) },
    });
    expect(declared.status).toBe(413);
  });

  it("rejects a JSON-RPC batch and invalid JSON with 400", async () => {
    const token = await addToken(world.db, ALICE);
    const batch = await callMcp({ token: token.raw, body: [INITIALIZE_BODY] });
    expect(batch.status).toBe(400);
    expect(await batch.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32_600, message: "Batch requests are not supported." },
      id: null,
    });

    const bad = await callMcp({ token: token.raw, body: "{not json" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32_700, message: "Parse error" },
      id: null,
    });
  });

  it("answers GET and DELETE with 405 and Allow: POST", async () => {
    for (const handler of [mcpGet, mcpDelete]) {
      const res = handler();
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "Method not allowed." });
    }
  });

  it("serves a normal request with no-store", async () => {
    const token = await addToken(world.db, ALICE);
    const res = await callMcp({ token: token.raw });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("rate limits", () => {
  // Pin Date mid-window so a seeded counter and the route agree on the window.
  const NOW = new Date("2026-06-01T10:00:30.000Z");
  const WINDOW_START = "2026-06-01T10:00:00.000Z";

  async function seedHits(bucketKey: string, count: number) {
    await world.sql`
      INSERT INTO rate_limit_hits (id, bucket_key, window_start, count)
      VALUES (${`hit-${bucketKey}`}, ${bucketKey}, ${WINDOW_START}::timestamptz, ${count})`;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  it("allows the 120th call in a window and rejects the 121st with Retry-After", async () => {
    const token = await addToken(world.db, ALICE);
    await seedHits(`mcp:${ALICE}`, 119);
    expect((await callMcp({ token: token.raw })).status).toBe(200);

    const res = await callMcp({ token: token.raw });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Rate limit exceeded." });
    expect(retryAfter(res)).toBe(30);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("limits per user, not per token or globally", async () => {
    const alice = await addToken(world.db, ALICE);
    const bob = await addToken(world.db, BOB, {
      scopes: ["tickets:read"],
    });
    await seedHits(`mcp:${ALICE}`, 120);
    expect((await callMcp({ token: alice.raw })).status).toBe(429);
    expect((await callMcp({ token: bob.raw })).status).toBe(200);
  });

  it("limits failed authentications to 20 per minute per token prefix", async () => {
    const raw = "dkm_prefixabc-not-a-real-token";
    for (let i = 0; i < 20; i++) {
      const res = await callMcp({ token: raw });
      expect(res.status, `attempt ${i + 1}`).toBe(401);
    }
    const res = await callMcp({ token: raw });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "Too many failed authentication attempts.",
    });
    expect(retryAfter(res)).toBe(30);
    expect(res.headers.get("www-authenticate")).toBeNull();

    // A different prefix is unaffected.
    expect((await callMcp({ token: "dkm_otherprefix-xyz" })).status).toBe(401);
  });

  it("limits failed authentications to 60 per minute per IP", async () => {
    const ip = "203.0.113.9";
    await seedHits(`mcp-auth-fail-ip:${ip}`, 59);
    const headers = { "x-forwarded-for": ip };
    expect((await callMcp({ headers })).status).toBe(401);
    const res = await callMcp({ headers });
    expect(res.status).toBe(429);
    expect(retryAfter(res)).toBe(30);

    // Another address is unaffected.
    expect(
      (await callMcp({ headers: { "x-forwarded-for": "203.0.113.10" } })).status
    ).toBe(401);
  });

  it("does not count successful calls against the failure budgets", async () => {
    const token = await addToken(world.db, ALICE);
    await seedHits("mcp-auth-fail-ip:unknown", 60);
    expect((await callMcp({ token: token.raw })).status).toBe(200);
  });
});
