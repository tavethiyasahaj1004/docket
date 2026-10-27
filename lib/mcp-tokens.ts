import { createHash } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import { and, desc, eq, getTableColumns, isNull } from "drizzle-orm";
import { ADMIN_ROLE, AGENT_ROLE } from "@/config/platform";
import { mcpAccessTokens, user } from "@/db/schema";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { isMcpServing } from "@/lib/mcp/http";
import { getPlatformSettings } from "@/lib/settings";
import type { DbOrTx } from "@/lib/user-deletion";

export const MCP_TOKEN_PREFIX = "dkm_";
/** Characters of the raw token kept for display (`dkm_` + 8). */
export const MCP_TOKEN_DISPLAY_PREFIX_LENGTH = 12;

export const MCP_SCOPES = [
  "tickets:read",
  "tickets:read_internal",
  "customers:read",
  "tickets:write",
  "tickets:manage",
  "tickets:reply",
  "reports:read",
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** Granted when a token is created without an explicit scope list. */
export const DEFAULT_MCP_SCOPES: readonly McpScope[] = [
  "tickets:read",
  "customers:read",
];

export const MCP_TOKEN_DEFAULT_TTL_DAYS = 30;
export const MCP_TOKEN_MAX_TTL_DAYS = 90;
export const MCP_TOKEN_NAME_MAX_LENGTH = 100;

export const MCP_REVOKED_REASONS = [
  "revoked_by_user",
  "revoked_by_admin",
  "sessions_signed_out",
  "user_banned",
  "role_changed",
  "account_not_permitted",
] as const;
export type McpRevokedReason = (typeof MCP_REVOKED_REASONS)[number];

/** A token row as handed to callers — the hash never leaves this module. */
export type McpAccessToken = Omit<
  typeof mcpAccessTokens.$inferSelect,
  "keyHash"
>;

// Every column except the hash, for selects/returning that hand rows out.
const { keyHash: _omitted, ...MCP_TOKEN_COLUMNS } =
  getTableColumns(mcpAccessTokens);

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function hashMcpToken(raw: string): string {
  return hashToken(raw);
}

export function isMcpScope(value: unknown): value is McpScope {
  return (
    typeof value === "string" &&
    (MCP_SCOPES as readonly string[]).includes(value)
  );
}

/** The most scopes a user of this role can ever hold on a token: agents get
 * everything but reports, admins everything, any other role (or a malformed one
 * such as "agent,admin") nothing. */
export function allowedMcpScopesForRole(
  role: string | null | undefined
): McpScope[] {
  if (role === ADMIN_ROLE) {
    return [...MCP_SCOPES];
  }
  if (role === AGENT_ROLE) {
    return MCP_SCOPES.filter((scope) => scope !== "reports:read");
  }
  return [];
}

/** A token's granted scopes intersected with its owner's CURRENT role ceiling
 * (in MCP_SCOPES order), so a demotion narrows existing tokens immediately. */
export function effectiveMcpScopes(
  tokenScopes: readonly string[],
  role: string | null | undefined
): McpScope[] {
  const allowed = allowedMcpScopesForRole(role);
  return MCP_SCOPES.filter(
    (scope) => allowed.includes(scope) && tokenScopes.includes(scope)
  );
}

/** Generates a new MCP token from cuid2 (CSPRNG-backed, per this project's ID
 * convention). `raw` is returned once; only `hash` persists. The `dkm_` prefix
 * tells MCP tokens apart from `dk_live_` API keys. */
export function generateMcpToken(): {
  raw: string;
  prefix: string;
  hash: string;
} {
  const raw = `${MCP_TOKEN_PREFIX}${createId()}${createId()}`;
  return {
    raw,
    prefix: raw.slice(0, MCP_TOKEN_DISPLAY_PREFIX_LENGTH),
    hash: hashToken(raw),
  };
}

/** Only exactly "agent" or "admin" may hold a token. */
export function isEligibleMcpRole(role: string | null | undefined): boolean {
  return role === AGENT_ROLE || role === ADMIN_ROLE;
}

/** Scopes a NEW token may be issued with right now. Release 1 is read-only:
 * write scopes stay defined in MCP_SCOPES for later phases but cannot be issued.
 * tickets:read_internal is withheld until its internal-notes opt-in rule is
 * decided. */
export const MCP_ISSUABLE_SCOPES: readonly McpScope[] = [
  "tickets:read",
  "customers:read",
  "reports:read",
];

export function isIssuableMcpScope(scope: McpScope): boolean {
  return MCP_ISSUABLE_SCOPES.includes(scope);
}

export type CreateMcpTokenResult =
  | { ok: true; token: McpAccessToken; rawToken: string }
  | {
      ok: false;
      reason:
        | "mcp_disabled"
        | "impersonated"
        | "not_permitted"
        | "invalid_name"
        | "invalid_scopes"
        | "scope_not_issuable"
        | "scope_not_allowed"
        | "invalid_expiry";
    };

export async function createMcpToken(input: {
  userId: string;
  name: string;
  scopes?: unknown;
  expiresInDays?: unknown;
  impersonatedBy: string | null;
}): Promise<CreateMcpTokenResult> {
  // A token outlives the session that minted it, so an impersonated session
  // (an admin acting as someone else) must never be able to create one.
  if (typeof input.impersonatedBy === "string" && input.impersonatedBy !== "") {
    return { ok: false, reason: "impersonated" };
  }

  const settings = await getPlatformSettings();
  // Same rule as the endpoint: switched on AND the https requirement holds.
  if (!isMcpServing(settings)) {
    return { ok: false, reason: "mcp_disabled" };
  }

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > MCP_TOKEN_NAME_MAX_LENGTH) {
    return { ok: false, reason: "invalid_name" };
  }

  let scopes: McpScope[];
  if (input.scopes === undefined) {
    scopes = [...DEFAULT_MCP_SCOPES];
  } else if (
    Array.isArray(input.scopes) &&
    input.scopes.length > 0 &&
    input.scopes.every(isMcpScope) &&
    new Set(input.scopes).size === input.scopes.length
  ) {
    scopes = input.scopes;
  } else {
    return { ok: false, reason: "invalid_scopes" };
  }
  if (!scopes.every(isIssuableMcpScope)) {
    return { ok: false, reason: "scope_not_issuable" };
  }

  let days = MCP_TOKEN_DEFAULT_TTL_DAYS;
  if (input.expiresInDays !== undefined) {
    const d = input.expiresInDays;
    if (
      typeof d !== "number" ||
      !Number.isInteger(d) ||
      d < 1 ||
      d > MCP_TOKEN_MAX_TTL_DAYS
    ) {
      return { ok: false, reason: "invalid_expiry" };
    }
    days = d;
  }

  const { raw, prefix, hash } = generateMcpToken();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const created = await db.transaction(async (tx) => {
    // FOR SHARE, not a plain read: inserting the token only takes FOR KEY SHARE
    // on the user row (the FK check), which does NOT conflict with a ban's
    // UPDATE. FOR SHARE does, so a concurrent ban and this insert serialize: the
    // ban either commits first (we see banned=true here and refuse) or waits for
    // our commit (its trigger then sees and revokes the new token). Either way
    // no live token survives a ban.
    const [owner] = await tx
      .select({ role: user.role, banned: user.banned, email: user.email })
      .from(user)
      .where(eq(user.id, input.userId))
      .for("share");
    if (!owner || !isEligibleMcpRole(owner.role) || owner.banned === true) {
      return { ok: false as const, reason: "not_permitted" as const };
    }

    const allowed = allowedMcpScopesForRole(owner.role);
    if (!scopes.every((scope) => allowed.includes(scope))) {
      return { ok: false as const, reason: "scope_not_allowed" as const };
    }

    const [row] = await tx
      .insert(mcpAccessTokens)
      .values({
        id: createId(),
        userId: input.userId,
        name,
        keyPrefix: prefix,
        keyHash: hash,
        scopes,
        expiresAt,
      })
      .returning(MCP_TOKEN_COLUMNS);
    return { ok: true as const, token: row, ownerEmail: owner.email };
  });

  if (!created.ok) {
    return created;
  }

  // Never the raw token or the hash in audit metadata.
  await audit({
    action: "mcp_token.created",
    actorEmail: created.ownerEmail,
    actorId: input.userId,
    description: `Created MCP token ${created.token.keyPrefix}…`,
    entityId: created.token.id,
    entityType: "mcp_token",
    metadata: {
      keyPrefix: created.token.keyPrefix,
      name: created.token.name,
      scopes: created.token.scopes,
      expiresAt: created.token.expiresAt.toISOString(),
    },
  });

  return { ok: true, token: created.token, rawToken: raw };
}

/** Revokes every still-live token of a user, returning what it revoked (for
 * per-token audit rows). Already-revoked rows are never touched, so their
 * original revoked_at/revoked_reason stay. */
export async function revokeAllMcpTokensForUser(
  tx: DbOrTx,
  userId: string,
  reason: McpRevokedReason
): Promise<{ id: string; keyPrefix: string; name: string }[]> {
  const now = new Date();
  return await tx
    .update(mcpAccessTokens)
    .set({ revokedAt: now, revokedReason: reason, updatedAt: now })
    .where(
      and(eq(mcpAccessTokens.userId, userId), isNull(mcpAccessTokens.revokedAt))
    )
    .returning({
      id: mcpAccessTokens.id,
      keyPrefix: mcpAccessTokens.keyPrefix,
      name: mcpAccessTokens.name,
    });
}

export type McpTokenStatus = "active" | "expired" | "revoked";

export type McpAccessTokenListItem = McpAccessToken & {
  status: McpTokenStatus;
};

function withStatus(token: McpAccessToken): McpAccessTokenListItem {
  let status: McpTokenStatus = "active";
  if (token.revokedAt) {
    status = "revoked";
  } else if (token.expiresAt.getTime() <= Date.now()) {
    status = "expired";
  }
  return { ...token, status };
}

/** A user's own tokens, newest first, without the hash. */
export async function listMcpTokensForUser(
  userId: string
): Promise<McpAccessTokenListItem[]> {
  const rows = await db
    .select(MCP_TOKEN_COLUMNS)
    .from(mcpAccessTokens)
    .where(eq(mcpAccessTokens.userId, userId))
    .orderBy(desc(mcpAccessTokens.createdAt), desc(mcpAccessTokens.id));
  return rows.map(withStatus);
}

/** Every user's tokens (admin view), newest first, with the owner and without
 * the hash. */
export async function listAllMcpTokens(): Promise<
  (McpAccessTokenListItem & {
    owner: { id: string; name: string; email: string; role: string };
  })[]
> {
  const rows = await db
    .select({
      token: MCP_TOKEN_COLUMNS,
      owner: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    })
    .from(mcpAccessTokens)
    .innerJoin(user, eq(user.id, mcpAccessTokens.userId))
    .orderBy(desc(mcpAccessTokens.createdAt), desc(mcpAccessTokens.id));
  return rows.map((row) => ({ ...withStatus(row.token), owner: row.owner }));
}

/** Revokes one token. `ownerId` restricts it to that user's own tokens. Returns
 * the revoked row, or null if there is no such (matching) live token — an
 * existing revocation is never cleared or overwritten. */
export async function revokeMcpToken(input: {
  tokenId: string;
  ownerId?: string;
  reason: "revoked_by_user" | "revoked_by_admin";
}): Promise<McpAccessToken | null> {
  const now = new Date();
  const conditions = [
    eq(mcpAccessTokens.id, input.tokenId),
    isNull(mcpAccessTokens.revokedAt),
  ];
  if (input.ownerId !== undefined) {
    conditions.push(eq(mcpAccessTokens.userId, input.ownerId));
  }
  const [row] = await db
    .update(mcpAccessTokens)
    .set({ revokedAt: now, revokedReason: input.reason, updatedAt: now })
    .where(and(...conditions))
    .returning(MCP_TOKEN_COLUMNS);
  return row ?? null;
}

/** One token by id (optionally only if owned by `ownerId`), without the hash. */
export async function getMcpToken(
  tokenId: string,
  ownerId?: string
): Promise<(McpAccessToken & { userId: string }) | null> {
  const conditions = [eq(mcpAccessTokens.id, tokenId)];
  if (ownerId !== undefined) {
    conditions.push(eq(mcpAccessTokens.userId, ownerId));
  }
  const [row] = await db
    .select(MCP_TOKEN_COLUMNS)
    .from(mcpAccessTokens)
    .where(and(...conditions))
    .limit(1);
  return row ?? null;
}

export type VerifyMcpTokenResult =
  | {
      ok: true;
      token: McpAccessToken;
      user: { id: string; name: string; email: string; role: string };
      scopes: McpScope[];
    }
  | {
      ok: false;
      reason: "invalid" | "expired" | "revoked" | "not_permitted";
      prefix: string | null;
    };

/** Resolves a raw bearer token to its owner and effective scopes. The "MCP
 * enabled" admin switch is checked by the HTTP layer before this runs. Never
 * logs or returns the raw token or its hash. Updates `lastUsedAt` best-effort. */
export async function verifyMcpToken(
  raw: string
): Promise<VerifyMcpTokenResult> {
  if (!raw.startsWith(MCP_TOKEN_PREFIX)) {
    return { ok: false, reason: "invalid", prefix: null };
  }

  const [row] = await db
    .select({
      token: MCP_TOKEN_COLUMNS,
      owner: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        banned: user.banned,
      },
    })
    .from(mcpAccessTokens)
    .innerJoin(user, eq(user.id, mcpAccessTokens.userId))
    .where(eq(mcpAccessTokens.keyHash, hashToken(raw)))
    .limit(1);
  if (!row) {
    return { ok: false, reason: "invalid", prefix: null };
  }

  const { token, owner } = row;
  const prefix = token.keyPrefix;
  const now = new Date();

  if (token.revokedAt) {
    return { ok: false, reason: "revoked", prefix };
  }
  if (token.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "expired", prefix };
  }

  if (!isEligibleMcpRole(owner.role) || owner.banned === true) {
    // Backstop for anything the user-table trigger could not see (e.g. a token
    // inserted for an already-ineligible user): revoke on use, permanently. A set
    // `banned` flag always blocks, as in proxy.ts, even if `banExpires` has passed.
    await db
      .update(mcpAccessTokens)
      .set({
        revokedAt: now,
        revokedReason: "account_not_permitted",
        updatedAt: now,
      })
      .where(
        and(eq(mcpAccessTokens.id, token.id), isNull(mcpAccessTokens.revokedAt))
      )
      .catch((err) => console.error("[mcp-tokens.backstop]", err));
    return { ok: false, reason: "not_permitted", prefix };
  }

  db.update(mcpAccessTokens)
    .set({ lastUsedAt: now })
    .where(eq(mcpAccessTokens.id, token.id))
    .catch((err) => console.error("[mcp-tokens.last-used]", err));

  return {
    ok: true,
    token,
    user: {
      id: owner.id,
      name: owner.name,
      email: owner.email,
      role: owner.role,
    },
    scopes: effectiveMcpScopes(token.scopes, owner.role),
  };
}
