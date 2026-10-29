// A user's OAuth grants to MCP clients (Release 4): listing them and revoking
// them. A grant is an oauth_consent row; deleting it (together with the refresh
// and stored access tokens that rode on it) is what ends the client's access,
// because lib/mcp/oauth-verify.ts rejects any access token whose grant is gone.
// Revoking also cancels the pending MCP approval requests that came in on the
// grant, like revoking a personal access token does.
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  mcpPendingActions,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  user,
} from "@/db/schema";
import type { AuditInput } from "@/lib/audit";
import { db } from "@/lib/db";
import type { CancelledPendingAction } from "@/lib/mcp/pending-actions-core";
import type { DbOrTx } from "@/lib/user-deletion";

export type RevokedOAuthGrant = {
  consentId: string;
  userId: string;
  clientId: string;
  clientName: string;
};

export type OAuthRevokeReason =
  | "revoked_by_user"
  | "revoked_by_admin"
  | "sessions_signed_out"
  | "user_banned";

/** Which grants to revoke: all of a user's (ban, sign out everywhere), one
 * client's for a user, or one grant by id (optionally only if `ownerId` owns it,
 * so a user can never touch someone else's). */
export type OAuthGrantFilter =
  | { userId: string }
  | { userId: string; clientId: string }
  | { consentId: string; ownerId?: string };

/** Revokes the matching grants: cancels their pending approval requests, deletes
 * the refresh and stored access tokens of each (user, client) pair, then the
 * grant itself. Returns what it removed (for audit rows) and the cancelled
 * requests. Safe to call when nothing matches. */
export async function revokeOAuthGrants(
  tx: DbOrTx,
  filter: OAuthGrantFilter
): Promise<{
  revoked: RevokedOAuthGrant[];
  cancelled: CancelledPendingAction[];
}> {
  const where =
    "consentId" in filter
      ? and(
          eq(oauthConsent.id, filter.consentId),
          filter.ownerId === undefined
            ? undefined
            : eq(oauthConsent.userId, filter.ownerId)
        )
      : and(
          eq(oauthConsent.userId, filter.userId),
          "clientId" in filter
            ? eq(oauthConsent.clientId, filter.clientId)
            : undefined
        );

  const grants = await tx
    .select({
      consentId: oauthConsent.id,
      userId: oauthConsent.userId,
      clientId: oauthConsent.clientId,
      clientName: oauthClient.name,
    })
    .from(oauthConsent)
    .leftJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(where);
  if (grants.length === 0) {
    return { revoked: [], cancelled: [] };
  }
  const consentIds = grants.map((g) => g.consentId);

  // Pending requests first: once the grant row is deleted they no longer match.
  const cancelled = await tx
    .update(mcpPendingActions)
    .set({
      status: "cancelled",
      statusReason: "token_revoked",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mcpPendingActions.status, "pending"),
        inArray(mcpPendingActions.oauthConsentId, consentIds)
      )
    )
    .returning({
      id: mcpPendingActions.id,
      ticketId: mcpPendingActions.ticketId,
      kind: mcpPendingActions.kind,
      credentialId: mcpPendingActions.credentialId,
      oauthConsentId: mcpPendingActions.oauthConsentId,
      requestedById: mcpPendingActions.requestedById,
    });

  for (const g of grants) {
    if (g.userId === null) {
      continue;
    }
    await tx
      .delete(oauthAccessToken)
      .where(
        and(
          eq(oauthAccessToken.userId, g.userId),
          eq(oauthAccessToken.clientId, g.clientId)
        )
      );
    await tx
      .delete(oauthRefreshToken)
      .where(
        and(
          eq(oauthRefreshToken.userId, g.userId),
          eq(oauthRefreshToken.clientId, g.clientId)
        )
      );
  }
  await tx.delete(oauthConsent).where(inArray(oauthConsent.id, consentIds));

  return {
    revoked: grants.map((g) => ({
      consentId: g.consentId,
      userId: g.userId ?? "",
      clientId: g.clientId,
      clientName: g.clientName ?? g.clientId,
    })),
    cancelled,
  };
}

/** The audit row for one revoked grant. `actor` is whoever revoked it. */
export function grantRevokedAudit(
  grant: RevokedOAuthGrant,
  input: {
    actorId: string;
    actorEmail?: string | null;
    reason: OAuthRevokeReason;
    description?: string;
  }
): AuditInput {
  return {
    action: "mcp_oauth.grant_revoked",
    actorEmail: input.actorEmail,
    actorId: input.actorId,
    description:
      input.description ??
      `Revoked access of "${grant.clientName}" to MCP (${input.reason})`,
    entityId: grant.consentId,
    entityType: "mcp_oauth_grant",
    metadata: {
      clientId: grant.clientId,
      clientName: grant.clientName,
      targetUserId: grant.userId,
      reason: input.reason,
    },
  };
}

export type OAuthGrantListItem = {
  id: string;
  clientId: string;
  clientName: string;
  clientUri: string | null;
  scopes: string[];
  grantedAt: Date;
  updatedAt: Date;
  clientDisabled: boolean;
};

const GRANT_COLUMNS = {
  id: oauthConsent.id,
  clientId: oauthConsent.clientId,
  clientName: oauthClient.name,
  clientUri: oauthClient.uri,
  scopes: oauthConsent.scopes,
  grantedAt: oauthConsent.createdAt,
  updatedAt: oauthConsent.updatedAt,
  clientDisabled: oauthClient.disabled,
};

type GrantRow = {
  id: string;
  clientId: string;
  clientName: string | null;
  clientUri: string | null;
  scopes: string[];
  grantedAt: Date;
  updatedAt: Date;
  clientDisabled: boolean | null;
};

function toItem(row: GrantRow): OAuthGrantListItem {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.clientName ?? row.clientId,
    clientUri: row.clientUri,
    scopes: row.scopes,
    grantedAt: row.grantedAt,
    updatedAt: row.updatedAt,
    clientDisabled: row.clientDisabled === true,
  };
}

/** A user's own grants, newest first. */
export async function listOAuthGrantsForUser(
  userId: string
): Promise<OAuthGrantListItem[]> {
  const rows = await db
    .select(GRANT_COLUMNS)
    .from(oauthConsent)
    .leftJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(eq(oauthConsent.userId, userId))
    .orderBy(desc(oauthConsent.createdAt), desc(oauthConsent.id));
  return rows.map(toItem);
}

/** Every user's grants (admin view), newest first, with the owner. */
export async function listAllOAuthGrants(): Promise<
  (OAuthGrantListItem & {
    owner: { id: string; name: string; email: string };
  })[]
> {
  const rows = await db
    .select({
      ...GRANT_COLUMNS,
      ownerId: user.id,
      ownerName: user.name,
      ownerEmail: user.email,
    })
    .from(oauthConsent)
    .innerJoin(user, eq(user.id, oauthConsent.userId))
    .leftJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .orderBy(desc(oauthConsent.createdAt), desc(oauthConsent.id));
  return rows.map((row) => ({
    ...toItem(row),
    owner: { id: row.ownerId, name: row.ownerName, email: row.ownerEmail },
  }));
}

export type OAuthClientListItem = {
  clientId: string;
  name: string;
  uri: string | null;
  disabled: boolean;
  createdAt: Date | null;
  grantCount: number;
};

/** Every known OAuth client (they appear on first use via their metadata
 * document), with how many users currently grant them access. */
export async function listOAuthClients(): Promise<OAuthClientListItem[]> {
  const rows = await db
    .select({
      clientId: oauthClient.clientId,
      name: oauthClient.name,
      uri: oauthClient.uri,
      disabled: oauthClient.disabled,
      createdAt: oauthClient.createdAt,
      grantCount: sql<number>`count(${oauthConsent.id})::int`,
    })
    .from(oauthClient)
    .leftJoin(oauthConsent, eq(oauthConsent.clientId, oauthClient.clientId))
    .groupBy(oauthClient.id)
    .orderBy(asc(oauthClient.name), asc(oauthClient.clientId));
  return rows.map((row) => ({
    clientId: row.clientId,
    name: row.name ?? row.clientId,
    uri: row.uri,
    disabled: row.disabled === true,
    createdAt: row.createdAt,
    grantCount: row.grantCount,
  }));
}

/** One grant by id (optionally only if owned by `ownerId`). */
export async function getOAuthGrant(
  consentId: string,
  ownerId?: string
): Promise<OAuthGrantListItem | null> {
  const [row] = await db
    .select(GRANT_COLUMNS)
    .from(oauthConsent)
    .leftJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(
      and(
        eq(oauthConsent.id, consentId),
        ownerId === undefined ? undefined : eq(oauthConsent.userId, ownerId)
      )
    )
    .limit(1);
  return row ? toItem(row) : null;
}
