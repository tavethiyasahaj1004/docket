import { describe, expect, it } from "vitest";
import {
  checkHost,
  checkOrigin,
  isHttpsRequirementMet,
  isMcpServing,
  mcpJson,
  parseSingleJsonRpc,
  readBodyCapped,
} from "@/lib/mcp/http";

const APP = "http://localhost:3000";

function req(headers: Record<string, string> = {}, body?: BodyInit) {
  return new Request("http://localhost:3000/api/mcp", {
    method: "POST",
    headers,
    body,
  });
}

describe("isHttpsRequirementMet", () => {
  const cases: [string, string, boolean][] = [
    ["production", "https://help.example.com", true],
    ["production", "http://help.example.com", false],
    ["production", "http://localhost:3000", false],
    ["development", "http://localhost:3000", true],
    ["test", "http://localhost:3000", true],
    ["development", "https://help.example.com", true],
  ];
  for (const [nodeEnv, appUrl, expected] of cases) {
    it(`${nodeEnv} + ${appUrl} -> ${expected}`, () => {
      expect(isHttpsRequirementMet({ nodeEnv, appUrl })).toBe(expected);
    });
  }
});

describe("isMcpServing", () => {
  it("needs both the admin switch and the https rule", () => {
    const prod = { nodeEnv: "production" };
    expect(
      isMcpServing(
        { mcpEnabled: true },
        { ...prod, appUrl: "https://help.example.com" }
      )
    ).toBe(true);
    expect(
      isMcpServing(
        { mcpEnabled: false },
        { ...prod, appUrl: "https://help.example.com" }
      )
    ).toBe(false);
    // Enabled in the database but served over plain http in production: off.
    expect(
      isMcpServing({ mcpEnabled: true }, { ...prod, appUrl: "http://x.test" })
    ).toBe(false);
  });
});

describe("mcpJson", () => {
  it("is never cached and keeps extra headers", async () => {
    const res = mcpJson({ a: 1 }, 418, { Allow: "POST" });
    expect(res.status).toBe(418);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("allow")).toBe("POST");
    expect(await res.json()).toEqual({ a: 1 });
  });
});

describe("checkOrigin", () => {
  it("accepts a request with no Origin header", () => {
    expect(checkOrigin(req(), { appUrl: APP })).toBeNull();
  });

  it("accepts the app's own origin", () => {
    expect(
      checkOrigin(req({ origin: "http://localhost:3000" }), { appUrl: APP })
    ).toBeNull();
  });

  it("accepts an origin from the allowed list (trimmed, normalized)", () => {
    const allowedOrigins =
      " https://tools.example.com/ , not a url,,http://x.test ";
    expect(
      checkOrigin(req({ origin: "https://tools.example.com" }), {
        appUrl: APP,
        allowedOrigins,
      })
    ).toBeNull();
    expect(
      checkOrigin(req({ origin: "http://x.test" }), {
        appUrl: APP,
        allowedOrigins,
      })
    ).toBeNull();
  });

  it("rejects any other origin with 403", async () => {
    const res = checkOrigin(req({ origin: "https://evil.example" }), {
      appUrl: APP,
      allowedOrigins: "https://tools.example.com",
    });
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "Origin not allowed." });
    expect(res?.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects an unparseable Origin", () => {
    expect(checkOrigin(req({ origin: "null" }), { appUrl: APP })?.status).toBe(
      403
    );
  });
});

describe("checkHost", () => {
  it("requires a loopback Host when the app URL is loopback", async () => {
    expect(
      checkHost(req({ host: "localhost:3000" }), { appUrl: APP })
    ).toBeNull();
    expect(
      checkHost(req({ host: "127.0.0.1:3000" }), { appUrl: APP })
    ).toBeNull();
    expect(checkHost(req({ host: "[::1]:3000" }), { appUrl: APP })).toBeNull();
    const res = checkHost(req({ host: "evil.example" }), { appUrl: APP });
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "Host not allowed." });
  });

  it("also protects a 127.0.0.1 or ::1 app URL", () => {
    expect(
      checkHost(req({ host: "evil.example" }), {
        appUrl: "http://127.0.0.1:3000",
      })?.status
    ).toBe(403);
    expect(
      checkHost(req({ host: "evil.example" }), { appUrl: "http://[::1]:3000" })
        ?.status
    ).toBe(403);
  });

  it("is skipped for a non-loopback app URL (proxies may rewrite Host)", () => {
    expect(
      checkHost(req({ host: "internal-service:8080" }), {
        appUrl: "https://help.example.com",
      })
    ).toBeNull();
  });
});

describe("readBodyCapped", () => {
  it("returns the text of a small body", async () => {
    const out = await readBodyCapped(req({}, "hello"), 10);
    expect(out).toEqual({ ok: true, text: "hello" });
  });

  it("returns empty text when there is no body", async () => {
    const out = await readBodyCapped(
      new Request("http://localhost:3000/api/mcp"),
      10
    );
    expect(out).toEqual({ ok: true, text: "" });
  });

  it("rejects by declared Content-Length without reading", async () => {
    const out = await readBodyCapped(
      req({ "content-length": "11" }, "x".repeat(11)),
      10
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.response.status).toBe(413);
      expect(await out.response.json()).toEqual({
        error: "Request body too large.",
      });
    }
  });

  it("rejects a stream that overflows with no or a lying Content-Length", async () => {
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = new TextEncoder().encode("x".repeat(6));
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      });
    const base = { method: "POST", duplex: "half" } as const;
    const noHeader = new Request("http://localhost:3000/api/mcp", {
      ...base,
      body: stream(),
    });
    const lying = new Request("http://localhost:3000/api/mcp", {
      ...base,
      headers: { "content-length": "1" },
      body: stream(),
    });
    for (const request of [noHeader, lying]) {
      const out = await readBodyCapped(request, 10);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.response.status).toBe(413);
      }
    }
  });

  it("accepts a body of exactly the cap", async () => {
    const out = await readBodyCapped(req({}, "x".repeat(10)), 10);
    expect(out.ok).toBe(true);
  });
});

describe("parseSingleJsonRpc", () => {
  it("accepts a single message", () => {
    const out = parseSingleJsonRpc('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    expect(out).toEqual({
      ok: true,
      message: { jsonrpc: "2.0", id: 1, method: "ping" },
    });
  });

  it("rejects invalid JSON with a JSON-RPC parse error (400)", async () => {
    const out = parseSingleJsonRpc("{nope");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.response.status).toBe(400);
      expect(await out.response.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32_700, message: "Parse error" },
        id: null,
      });
    }
  });

  it("rejects a batch array", async () => {
    const out = parseSingleJsonRpc(
      '[{"jsonrpc":"2.0","id":1,"method":"ping"}]'
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.response.status).toBe(400);
      expect(await out.response.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32_600, message: "Batch requests are not supported." },
        id: null,
      });
    }
  });
});
