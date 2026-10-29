import { describe, expect, it } from "vitest";
import {
  oauthGrantableScopes,
  splitScopes,
  ungrantableOAuthScopes,
} from "@/lib/mcp/oauth-policy";
import {
  isOAuthAvailableFor,
  MCP_OAUTH_RESOURCE,
  OAUTH_DEFAULT_SCOPES,
  OAUTH_SCOPES,
  protectedResourceMetadataUrl,
} from "@/lib/oauth";
import {
  isOAuthContinuationQuery,
  OAUTH_CHOOSABLE_SCOPES,
  OAUTH_DEFAULT_CHECKED,
  oauthResumeAuthorizeUrl,
} from "@/lib/oauth-scopes";

describe("isOAuthAvailableFor", () => {
  it.each([
    ["https://docket.example.com", true],
    ["https://docket.example.com:8443/", true],
    ["http://localhost:3000", true],
    ["http://127.0.0.1:3108", true],
    ["http://[::1]:3000", true],
    ["http://docket.example.test", false],
    ["http://192.168.1.10:3000", false],
    ["http://localhost.evil.test", false],
    ["ftp://localhost", false],
    ["not a url", false],
    ["", false],
  ])("%s -> %s", (url, expected) => {
    expect(isOAuthAvailableFor(url)).toBe(expected);
  });
});

describe("scopes", () => {
  it("issues exactly offline_access plus the issuable MCP scopes", () => {
    expect([...OAUTH_SCOPES].sort()).toEqual(
      [
        "offline_access",
        "tickets:read",
        "customers:read",
        "tickets:write",
        "reports:read",
      ].sort()
    );
    for (const never of [
      "tickets:read_internal",
      "tickets:manage",
      "tickets:reply",
      "openid",
      "profile",
      "email",
    ]) {
      expect(OAUTH_SCOPES).not.toContain(never);
    }
  });

  it("defaults a client to read-only plus offline_access", () => {
    expect([...OAUTH_DEFAULT_SCOPES].sort()).toEqual(
      ["customers:read", "offline_access", "tickets:read"].sort()
    );
  });

  it("offers tickets:read and customers:read pre-checked, nothing else", () => {
    expect([...OAUTH_DEFAULT_CHECKED]).toEqual([
      "tickets:read",
      "customers:read",
    ]);
    expect([...OAUTH_CHOOSABLE_SCOPES].sort()).toEqual(
      OAUTH_SCOPES.filter((s) => s !== "offline_access").sort()
    );
  });

  it("caps an agent below reports:read and an admin at everything issuable", () => {
    expect(oauthGrantableScopes("agent").sort()).toEqual(
      [
        "customers:read",
        "offline_access",
        "tickets:read",
        "tickets:write",
      ].sort()
    );
    expect(oauthGrantableScopes("admin").sort()).toEqual(
      [...OAUTH_SCOPES].sort()
    );
    expect(oauthGrantableScopes("user")).toEqual(["offline_access"]);
    expect(oauthGrantableScopes("agent,admin")).toEqual(["offline_access"]);
    expect(oauthGrantableScopes(null)).toEqual(["offline_access"]);
  });

  it("flags scopes a role may not grant, including unknown and never-issuable ones", () => {
    expect(
      ungrantableOAuthScopes("agent", ["tickets:read", "reports:read"])
    ).toEqual(["reports:read"]);
    expect(
      ungrantableOAuthScopes("admin", [
        "tickets:read_internal",
        "tickets:manage",
        "tickets:reply",
        "openid",
        "tickets:read",
      ])
    ).toEqual([
      "tickets:read_internal",
      "tickets:manage",
      "tickets:reply",
      "openid",
    ]);
    expect(ungrantableOAuthScopes("admin", [])).toEqual([]);
  });

  it("splits scope strings on single spaces and drops empties", () => {
    expect(splitScopes("a  b c ")).toEqual(["a", "b", "c"]);
    expect(splitScopes(null)).toEqual([]);
    expect(splitScopes("")).toEqual([]);
  });
});

describe("resource and metadata URLs", () => {
  it("binds tokens to the exact connector URL, without a trailing slash", () => {
    expect(MCP_OAUTH_RESOURCE).toBe("http://localhost:3000/api/mcp");
    expect(protectedResourceMetadataUrl()).toBe(
      "http://localhost:3000/.well-known/oauth-protected-resource/api/mcp"
    );
  });
});

describe("login continuation helpers", () => {
  it("recognises a signed OAuth query by sig + client_id", () => {
    expect(isOAuthContinuationQuery("?sig=abc&client_id=x&exp=1")).toBe(true);
    expect(isOAuthContinuationQuery("sig=abc")).toBe(false);
    expect(isOAuthContinuationQuery("client_id=x")).toBe(false);
    expect(isOAuthContinuationQuery("next=/tickets")).toBe(false);
    expect(isOAuthContinuationQuery("")).toBe(false);
  });

  it("builds the magic-link callback without the signature or bookkeeping", () => {
    const url = oauthResumeAuthorizeUrl(
      "response_type=code&client_id=c1&redirect_uri=https%3A%2F%2Fa.test%2Fcb&state=s&code_challenge=ch&code_challenge_method=S256&resource=r&scope=tickets%3Aread&prompt=login+consent&exp=99&sig=zzz&ba_iat=1&ba_pl=2&ba_param=sig&ba_param=exp"
    );
    const parsed = new URL(url, "http://x.test");
    expect(parsed.pathname).toBe("/api/auth/oauth2/authorize");
    const p = parsed.searchParams;
    expect(p.get("client_id")).toBe("c1");
    expect(p.get("redirect_uri")).toBe("https://a.test/cb");
    expect(p.get("state")).toBe("s");
    expect(p.get("code_challenge")).toBe("ch");
    expect(p.get("resource")).toBe("r");
    expect(p.get("scope")).toBe("tickets:read");
    expect(p.get("prompt")).toBe("consent");
    for (const gone of ["sig", "exp", "ba_iat", "ba_pl", "ba_param"]) {
      expect(p.has(gone)).toBe(false);
    }
  });

  it("drops the prompt parameter when only login was asked for", () => {
    const url = oauthResumeAuthorizeUrl("client_id=c&prompt=login&sig=s");
    expect(new URL(url, "http://x.test").searchParams.has("prompt")).toBe(
      false
    );
  });
});
