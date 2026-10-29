import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import { and, eq } from "drizzle-orm";
import { account, oauthConsent, oauthResource } from "@/db/schema";
import { auth } from "@/lib/auth";
import { MCP_OAUTH_RESOURCE } from "@/lib/oauth";
import { callMcp } from "./mcp-endpoint-helpers";
import type { McpWorld } from "./mcp-helpers";

export const APP_URL = "http://localhost:3000";
export const REDIRECT_URI = "https://assistant.example.test/callback";
export const LOOPBACK_REDIRECT_URI = "http://127.0.0.1:33418/callback";
export const PASSWORD = "correct horse battery staple";

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Better Auth seeds the resource row lazily once per process; the test reset
 * truncates it, so put it back before each test. */
export async function seedResource(world: McpWorld) {
  await world.db.insert(oauthResource).values({
    id: createId(),
    identifier: MCP_OAUTH_RESOURCE,
    name: "Docket MCP",
    disabled: false,
    policyVersion: 1,
  });
}

/** A public (PKCE-only) client, created server-side like the CIMD path would. */
export async function createClient(
  adminCookie: string,
  over: Partial<{
    redirectUris: string[];
    scope: string;
    name: string;
    applicationType: "web" | "native";
  }> = {}
): Promise<string> {
  const created = (await auth.api.adminCreateOAuthClient({
    headers: new Headers({ cookie: adminCookie }),
    body: {
      redirect_uris: over.redirectUris ?? [REDIRECT_URI, LOOPBACK_REDIRECT_URI],
      scope:
        over.scope ??
        "tickets:read customers:read tickets:write reports:read offline_access",
      client_name: over.name ?? "Test Assistant",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: over.applicationType ?? "native",
      resources: [MCP_OAUTH_RESOURCE],
    },
  })) as { client_id: string };
  return created.client_id;
}

/** Gives the user a password and signs them in; returns the Cookie header. */
export async function signInAs(
  world: McpWorld,
  userId: string,
  email: string
): Promise<string> {
  const ctx = await auth.$context;
  const [existing] = await world.db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.userId, userId));
  if (!existing) {
    await world.db.insert(account).values({
      id: createId(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: await ctx.password.hash(PASSWORD),
    });
  }
  const res = (await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  })) as Response;
  if (!res.ok) {
    throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  }
  return cookieHeader(res);
}

export function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

export function authRequest(
  path: string,
  init: RequestInit & {
    cookie?: string;
    json?: unknown;
    form?: Record<string, string>;
  } = {}
): Request {
  const headers = new Headers(init.headers);
  headers.set("origin", APP_URL);
  if (init.cookie) {
    headers.set("cookie", init.cookie);
  }
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  } else if (init.form) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(init.form).toString();
  }
  return new Request(`${APP_URL}/api/auth${path}`, {
    method: init.method ?? (body ? "POST" : "GET"),
    headers,
    body,
    redirect: "manual",
  });
}

export function authFetch(
  path: string,
  init: Parameters<typeof authRequest>[1] = {}
): Promise<Response> {
  return auth.handler(authRequest(path, init));
}

export type AuthorizeParams = {
  clientId: string;
  redirectUri?: string;
  scope?: string | null;
  state?: string;
  challenge?: string | null;
  method?: string;
  resource?: string | null;
};

export function authorizeQuery(p: AuthorizeParams): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri ?? REDIRECT_URI,
    state: p.state ?? "state-xyz",
  });
  if (p.scope !== null) {
    q.set("scope", p.scope ?? "tickets:read customers:read offline_access");
  }
  if (p.challenge !== null && p.challenge !== undefined) {
    q.set("code_challenge", p.challenge);
    q.set("code_challenge_method", p.method ?? "S256");
  }
  if (p.resource !== null) {
    q.set("resource", p.resource ?? MCP_OAUTH_RESOURCE);
  }
  return q.toString();
}

export function authorize(cookie: string | undefined, p: AuthorizeParams) {
  return authFetch(`/oauth2/authorize?${authorizeQuery(p)}`, { cookie });
}

/** The query string of a redirect Location (login/consent page or client). */
export function locationQuery(res: Response): URLSearchParams {
  const location = res.headers.get("location");
  if (!location) {
    throw new Error(`no Location header (status ${res.status})`);
  }
  return new URL(location, APP_URL).searchParams;
}

export function consent(
  cookie: string,
  oauthQuery: string,
  body: { accept: boolean; scope?: string }
) {
  return authFetch("/oauth2/consent", {
    cookie,
    json: { ...body, oauth_query: oauthQuery },
  });
}

export function tokenRequest(form: Record<string, string>) {
  return authFetch("/oauth2/token", { form });
}

export type Tokens = {
  access_token: string;
  refresh_token?: string;
  scope: string;
  expires_in: number;
  token_type: string;
};

export type FlowResult = {
  clientId: string;
  tokens: Tokens;
  code: string;
  redirect: URL;
  verifier: string;
};

/** authorize -> consent page -> accept -> code -> token, all in process. */
export async function runFlow(opts: {
  cookie: string;
  clientId: string;
  scope?: string;
  /** What the user allows on the consent screen (default: all requested). */
  grant?: string;
  redirectUri?: string;
}): Promise<FlowResult> {
  const { verifier, challenge } = pkce();
  const authz = await authorize(opts.cookie, {
    clientId: opts.clientId,
    scope: opts.scope,
    challenge,
    redirectUri: opts.redirectUri,
  });
  if (authz.status !== 302) {
    throw new Error(`authorize: ${authz.status} ${await authz.text()}`);
  }
  const consentLocation = new URL(authz.headers.get("location") ?? "", APP_URL);
  if (consentLocation.pathname !== "/oauth/consent") {
    throw new Error(`authorize went to ${consentLocation.toString()}`);
  }
  const accepted = await consent(opts.cookie, consentLocation.search.slice(1), {
    accept: true,
    scope: opts.grant,
  });
  if (!accepted.ok) {
    throw new Error(`consent: ${accepted.status} ${await accepted.text()}`);
  }
  const { url } = (await accepted.json()) as { url: string };
  const redirect = new URL(url);
  const code = redirect.searchParams.get("code");
  if (!code) {
    throw new Error(`no code in ${url}`);
  }
  const tokenRes = await tokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri ?? REDIRECT_URI,
    code_verifier: verifier,
    resource: MCP_OAUTH_RESOURCE,
  });
  if (!tokenRes.ok) {
    throw new Error(`token: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  return {
    clientId: opts.clientId,
    tokens: (await tokenRes.json()) as Tokens,
    code,
    redirect,
    verifier,
  };
}

export async function consentRow(
  world: McpWorld,
  userId: string,
  clientId: string
) {
  const [row] = await world.db
    .select()
    .from(oauthConsent)
    .where(
      and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId))
    );
  return row;
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8")
  );
}

export const ISSUER = `${APP_URL}/api/auth`;

/** A JWT signed with Docket's real signing key but with caller-chosen claims, to
 * prove the endpoint checks more than the signature. */
export async function forgeToken(
  claims: Record<string, unknown>
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const { token } = (await auth.api.signJWT({
    body: {
      payload: {
        iss: ISSUER,
        aud: MCP_OAUTH_RESOURCE,
        iat: now,
        exp: now + 600,
        scope: "tickets:read",
        ...claims,
      },
    },
  })) as { token: string };
  return token;
}

/** A well-formed EdDSA JWT signed by a key Docket has never seen. */
export function foreignKeyToken(claims: Record<string, unknown>): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: "at+jwt", kid: "foreign" })
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      iss: ISSUER,
      aud: MCP_OAUTH_RESOURCE,
      iat: now,
      exp: now + 600,
      scope: "tickets:read",
      ...claims,
    })
  ).toString("base64url");
  const signature = sign(null, Buffer.from(`${header}.${body}`), privateKey);
  return `${header}.${body}.${signature.toString("base64url")}`;
}

/** An unsigned ("alg": "none") token with plausible claims. */
export function unsignedToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc({
    iss: ISSUER,
    aud: MCP_OAUTH_RESOURCE,
    iat: now,
    exp: now + 600,
    scope: "tickets:read",
    ...claims,
  })}.`;
}

/** Calls /api/mcp with a bearer token and returns status + parsed challenge. */
export async function mcpStatus(token: string) {
  const res = await callMcp({ token });
  return {
    status: res.status,
    www: res.headers.get("www-authenticate"),
    body: (await res.json().catch(() => null)) as unknown,
  };
}
