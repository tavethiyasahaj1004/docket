import { createHash } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import { and, desc, eq, isNull } from "drizzle-orm";
import { apiKeys } from "@/db/schema";
import { db } from "@/lib/db";

export type ApiKey = typeof apiKeys.$inferSelect;

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Generates a new API key from cuid2 (CSPRNG-backed, per this project's ID
 * convention). `raw` is returned once; only `hash` persists. The `dk_live_`
 * prefix avoids Stripe's `sk_live_`, which trips GitHub push protection on doc
 * examples. Older `sk_live_` keys stay valid — verifyApiKey() matches the hash. */
export function generateApiKey(): {
  raw: string;
  prefix: string;
  hash: string;
} {
  const raw = `dk_live_${createId()}${createId()}`;
  return { raw, prefix: raw.slice(0, 16), hash: hashKey(raw) };
}

export async function createApiKey(input: {
  name: string;
  createdById: string;
  createdByName: string;
  portalUrlTemplate?: string | null;
}): Promise<{ record: ApiKey; rawKey: string }> {
  const { raw, prefix, hash } = generateApiKey();
  const [record] = await db
    .insert(apiKeys)
    .values({
      id: createId(),
      name: input.name,
      keyPrefix: prefix,
      keyHash: hash,
      createdById: input.createdById,
      createdByName: input.createdByName,
      portalUrlTemplate: input.portalUrlTemplate ?? null,
      createdAt: new Date(),
    })
    .returning();
  return { record, rawKey: raw };
}

export async function listApiKeys(): Promise<ApiKey[]> {
  return db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt));
}

/** Partial update — only fields present in `updates` are changed. */
export async function updateApiKey(
  id: string,
  updates: { name?: string; portalUrlTemplate?: string | null }
): Promise<ApiKey | undefined> {
  if (Object.keys(updates).length === 0) {
    const [row] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, id))
      .limit(1);
    return row;
  }
  const [row] = await db
    .update(apiKeys)
    .set(updates)
    .where(eq(apiKeys.id, id))
    .returning();
  return row;
}

export async function revokeApiKey(
  id: string
): Promise<{ id: string; name: string; keyPrefix: string } | null> {
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
    });
  return row ?? null;
}

/** Looks up an active (non-revoked) key by its raw secret. Updates
 * `lastUsedAt` best-effort — never blocks or throws on that write. */
export async function verifyApiKey(
  raw: string
): Promise<{ id: string; name: string } | null> {
  const hash = hashKey(raw);
  const [row] = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);
  if (!row || row.revokedAt) {
    return null;
  }
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.id))
    .catch((err) => console.error("[api-keys.last-used]", err));
  return { id: row.id, name: row.name };
}
