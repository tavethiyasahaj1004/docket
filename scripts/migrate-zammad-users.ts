// Creates a Docket agent per Zammad agent/admin, then backfills comment authors
// (by display name) and ticket assignees (exact). Idempotent: matches by email,
// only fills null FKs. New accounts share MIGRATION_USER_PASSWORD. Docs: §7.

import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { AGENT_ROLE } from "@/config/platform";
import {
  ticketActivity,
  ticketAttachments,
  ticketComments,
  tickets,
  user,
} from "@/db/schema";
import { auth } from "@/lib/auth";
import { db, dbClient } from "@/lib/db";

// Host/dev runs load .env via `tsx --env-file-if-exists=.env` (see package.json),
// which must happen before the first import: @/lib/db reads DATABASE_URL at
// module load, and ESM hoists imports above any top-level statement here.

// ── Config ──────────────────────────────────────────────────────────────────
const ZAMMAD_BASE_URL = (process.env.ZAMMAD_BASE_URL ?? "").replace(/\/+$/, "");
const ZAMMAD_API_TOKEN = process.env.ZAMMAD_API_TOKEN ?? "";
const DEFAULT_PASSWORD = process.env.MIGRATION_USER_PASSWORD ?? "";
const DRY_RUN = process.env.MIGRATION_DRY_RUN === "1";
const PER_PAGE = 100;

const MIN_PASSWORD_LENGTH = 12;

if (!DRY_RUN && DEFAULT_PASSWORD.length < MIN_PASSWORD_LENGTH) {
  console.error(
    "MIGRATION_USER_PASSWORD is required and must be at least " +
      `${MIN_PASSWORD_LENGTH} characters. Every account this script creates ` +
      "shares it until each person changes it, so it must not be guessable.\n\n" +
      "  Generate one:  openssl rand -base64 24\n"
  );
  process.exit(1);
}

if (!(ZAMMAD_BASE_URL && ZAMMAD_API_TOKEN)) {
  console.error(
    "Missing ZAMMAD_BASE_URL and/or ZAMMAD_API_TOKEN. See the header of this file."
  );
  process.exit(1);
}

if (DEFAULT_PASSWORD.length < 8) {
  console.error("MIGRATION_USER_PASSWORD must be at least 8 characters.");
  process.exit(1);
}

// ── Zammad REST client (global fetch) ─────────────────────────────────────────
const ZAMMAD_HEADERS = {
  Authorization: `Token token=${ZAMMAD_API_TOKEN}`,
  "Content-Type": "application/json",
};

async function zammadGet<T>(
  pathname: string,
  params?: Record<string, string | number>
): Promise<T> {
  const url = new URL(`${ZAMMAD_BASE_URL}/api/v1${pathname}`);
  for (const [k, v] of Object.entries(params ?? {})) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: ZAMMAD_HEADERS });
  if (!res.ok) {
    throw new Error(`Zammad GET ${pathname} → ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

// ── Zammad shapes (only the fields we read) ───────────────────────────────────
interface ZRole {
  id: number;
  name: string;
}
interface ZUser {
  email?: string;
  firstname?: string;
  id: number;
  lastname?: string;
  login?: string;
  role_ids?: number[];
}

function zUserName(u: ZUser): string {
  const name = `${u.firstname ?? ""} ${u.lastname ?? ""}`.trim();
  return name || u.email || u.login || `Zammad user ${u.id}`;
}

// Zammad role name → id. Falls back to the stock seed ids (1 Admin, 2 Agent)
// if the roles endpoint is unreachable — same defensive pattern as
// migrate-zammad.ts's loadStateMap/loadPriorityMap.
async function resolveStaffRoleIds(): Promise<Set<number>> {
  try {
    const roles = await zammadGet<ZRole[]>("/roles");
    const ids = roles
      .filter((r) => /admin|agent/i.test(r.name))
      .map((r) => r.id);
    if (ids.length > 0) {
      return new Set(ids);
    }
  } catch (err) {
    console.warn(`  ! could not fetch Zammad roles: ${(err as Error).message}`);
  }
  return new Set([1, 2]);
}

// Docket user id for an email, or null if nobody here has it. lower() on
// both sides — Zammad and Better Auth don't agree on email case, and a
// case-mismatched address is exactly how an assignee goes missing.
const localUserIdByEmail = new Map<string, string | null>();
async function resolveLocalUserIdByEmail(
  email: string
): Promise<string | null> {
  const key = email.trim().toLowerCase();
  if (!key) {
    return null;
  }
  const cached = localUserIdByEmail.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${key}`)
    .limit(1);
  const id = row?.id ?? null;
  localUserIdByEmail.set(key, id);
  return id;
}

// Owner email of a Zammad ticket — only needed for tickets migrated before
// migrate-zammad.ts started recording the owner locally. "" = no owner (or no
// email on the owner). Owner lookups are cached, so this is one GET per ticket.
const emailByZammadUserId = new Map<number, string>();
async function fetchZammadOwnerEmail(
  zammadTicketId: string | number
): Promise<string> {
  const zTicket = await zammadGet<{ owner_id?: number }>(
    `/tickets/${zammadTicketId}`
  );
  // Stock Zammad reserves owner id 1 for the "-" placeholder (= unassigned).
  const ownerId = zTicket.owner_id ?? 0;
  if (ownerId <= 1) {
    return "";
  }
  const cached = emailByZammadUserId.get(ownerId);
  if (cached !== undefined) {
    return cached;
  }
  const owner = await zammadGet<ZUser>(`/users/${ownerId}`);
  const email = (owner.email ?? "").trim().toLowerCase();
  emailByZammadUserId.set(ownerId, email);
  return email;
}

async function* iterateZammadUsers(): AsyncGenerator<ZUser> {
  let page = 1;
  for (;;) {
    const batch = await zammadGet<ZUser[]>("/users", {
      page,
      per_page: PER_PAGE,
    });
    if (!Array.isArray(batch) || batch.length === 0) {
      return;
    }
    for (const u of batch) {
      yield u;
    }
    if (batch.length < PER_PAGE) {
      return;
    }
    page += 1;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
interface StaffMember {
  email: string;
  name: string;
  // null only in dry-run for a user that doesn't exist yet (no id to assign).
  userId: string | null;
}

async function main() {
  console.log(
    `\nZammad → Docket user migration${DRY_RUN ? " (DRY RUN — no writes)" : ""}`
  );
  console.log(`  source: ${ZAMMAD_BASE_URL}\n`);

  const staffRoleIds = await resolveStaffRoleIds();

  let seen = 0;
  let created = 0;
  let skippedExisting = 0;
  let skippedNoEmail = 0;
  const staff: StaffMember[] = [];

  for await (const zUser of iterateZammadUsers()) {
    const roleIds = zUser.role_ids ?? [];
    if (!roleIds.some((id) => staffRoleIds.has(id))) {
      continue; // not agent/admin in Zammad — leave as an inline ticket customer
    }
    seen += 1;

    const email = (zUser.email ?? "").trim().toLowerCase();
    const name = zUserName(zUser);

    if (!email) {
      console.warn(
        `  ! skipping "${name}" (Zammad id ${zUser.id}) — no email.`
      );
      skippedNoEmail += 1;
      continue;
    }

    const [existing] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);

    if (existing) {
      skippedExisting += 1;
      staff.push({ name, email, userId: existing.id });
      console.log(
        `  = ${name} <${email}> already exists — will still backfill.`
      );
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [dry-run] would create ${name} <${email}> as agent.`);
      created += 1;
      staff.push({ name, email, userId: null });
      continue;
    }

    const result = await auth.api.signUpEmail({
      body: { email, name, password: DEFAULT_PASSWORD },
    });
    await db
      .update(user)
      .set({ role: AGENT_ROLE, emailVerified: true, updatedAt: new Date() })
      .where(eq(user.id, result.user.id));

    staff.push({ name, email, userId: result.user.id });
    created += 1;
    console.log(`  ✓ created ${name} <${email}>`);
  }

  // ── Backfill: connect historical comments/attachments to the new users ──────
  // Dry run previews the same match (count only, no write) so the operator can
  // see what a real run would connect before committing to it.
  let commentsConnected = 0;
  let attachmentsConnected = 0;

  for (const s of staff) {
    const nameMatch = eq(ticketComments.authorName, s.name);
    const attachmentNameMatch = eq(ticketAttachments.uploadedByName, s.name);

    if (DRY_RUN || !s.userId) {
      const [{ n: commentCount }] = await db
        .select({ n: count() })
        .from(ticketComments)
        .where(
          and(
            isNull(ticketComments.authorId),
            eq(ticketComments.authorRole, AGENT_ROLE),
            nameMatch
          )
        );
      const [{ n: attachmentCount }] = await db
        .select({ n: count() })
        .from(ticketAttachments)
        .where(
          and(
            isNull(ticketAttachments.uploadedById),
            eq(ticketAttachments.uploadedByRole, AGENT_ROLE),
            attachmentNameMatch
          )
        );

      commentsConnected += commentCount;
      attachmentsConnected += attachmentCount;
      if (commentCount > 0 || attachmentCount > 0) {
        console.log(
          `  [dry-run] would connect ${s.name}: ${commentCount} comment(s), ` +
            `${attachmentCount} attachment(s)`
        );
      }
      continue;
    }

    const connectedComments = await db
      .update(ticketComments)
      .set({ authorId: s.userId })
      .where(
        and(
          isNull(ticketComments.authorId),
          eq(ticketComments.authorRole, AGENT_ROLE),
          nameMatch
        )
      )
      .returning({ id: ticketComments.id });

    const connectedAttachments = await db
      .update(ticketAttachments)
      .set({ uploadedById: s.userId })
      .where(
        and(
          isNull(ticketAttachments.uploadedById),
          eq(ticketAttachments.uploadedByRole, AGENT_ROLE),
          attachmentNameMatch
        )
      )
      .returning({ id: ticketAttachments.id });

    commentsConnected += connectedComments.length;
    attachmentsConnected += connectedAttachments.length;

    if (connectedComments.length > 0 || connectedAttachments.length > 0) {
      console.log(
        `  ↳ ${s.name}: connected ${connectedComments.length} comment(s), ` +
          `${connectedAttachments.length} attachment(s)`
      );
    }
  }

  // ── Backfill: assignee on migrated tickets ─────────────────────────────────
  // Usually these were imported before the owner had an account, so they read
  // "Unassigned". Resolve the owner off the `zammad_migrated` row (re-reading
  // Zammad for older imports). updatedAt is untouched — the list sorts by it.
  const unassignedMigrated = await db
    .select({
      ticketId: ticketActivity.ticketId,
      metadata: ticketActivity.metadata,
    })
    .from(ticketActivity)
    .innerJoin(tickets, eq(tickets.id, ticketActivity.ticketId))
    .where(
      and(
        eq(ticketActivity.action, "zammad_migrated"),
        isNull(tickets.assignedAgentId)
      )
    );

  const pendingByOwnerEmail = new Map<
    string,
    { userId: string; ticketIds: string[] }
  >();
  const ownersWithoutAccount = new Set<string>();
  let ownerlessInZammad = 0;
  let ownerLookupFailed = 0;

  if (unassignedMigrated.length > 0) {
    console.log(
      `\n  Checking ${unassignedMigrated.length} unassigned migrated ticket(s) for a Zammad owner…`
    );
  }

  // A dry run creates nobody, so seed the lookup with what a real run would
  // create — otherwise the preview understates the links. The placeholder id
  // never reaches the DB; the UPDATE below is skipped in dry runs.
  if (DRY_RUN) {
    for (const s of staff) {
      localUserIdByEmail.set(s.email, s.userId ?? "(dry-run)");
    }
  }

  for (const row of unassignedMigrated) {
    const meta = (row.metadata ?? {}) as {
      zammadOwnerEmail?: string | null;
      zammadOwnerId?: number | null;
      zammadTicketId?: string | number;
    };
    let ownerEmail = (meta.zammadOwnerEmail ?? "").trim().toLowerCase();
    // The owner keys are written for every ticket migrated since this backfill
    // existed (null = no owner in Zammad), so their presence means the answer
    // is already local — only older imports need to ask Zammad.
    const ownerRecordedLocally = "zammadOwnerId" in meta;

    if (!(ownerEmail || ownerRecordedLocally) && meta.zammadTicketId != null) {
      try {
        ownerEmail = await fetchZammadOwnerEmail(meta.zammadTicketId);
      } catch (err) {
        // One unreadable ticket (deleted in Zammad, token scope, network)
        // shouldn't abort the sweep — the rest still get linked.
        ownerLookupFailed += 1;
        console.warn(
          `  ! could not read the owner of Zammad ticket ${meta.zammadTicketId}: ${(err as Error).message}`
        );
        continue;
      }
    }

    if (!ownerEmail) {
      ownerlessInZammad += 1; // genuinely unassigned in Zammad too — leave it
      continue;
    }

    const localUserId = await resolveLocalUserIdByEmail(ownerEmail);
    if (!localUserId) {
      ownersWithoutAccount.add(ownerEmail);
      continue;
    }

    const entry = pendingByOwnerEmail.get(ownerEmail);
    if (entry) {
      entry.ticketIds.push(row.ticketId);
    } else {
      pendingByOwnerEmail.set(ownerEmail, {
        userId: localUserId,
        ticketIds: [row.ticketId],
      });
    }
  }

  let ticketsAssigned = 0;
  for (const [ownerEmail, { userId, ticketIds }] of pendingByOwnerEmail) {
    ticketsAssigned += ticketIds.length;
    if (DRY_RUN) {
      console.log(
        `  [dry-run] would assign ${ticketIds.length} ticket(s) to <${ownerEmail}>`
      );
      continue;
    }
    // Chunked so a big migration can't blow past Postgres's bind-parameter
    // limit; the isNull guard keeps a concurrent manual assignment from being
    // overwritten between the SELECT above and this UPDATE.
    for (let i = 0; i < ticketIds.length; i += 500) {
      await db
        .update(tickets)
        .set({ assignedAgentId: userId })
        .where(
          and(
            inArray(tickets.id, ticketIds.slice(i, i + 500)),
            isNull(tickets.assignedAgentId)
          )
        );
    }
    console.log(
      `  ↳ <${ownerEmail}>: assigned ${ticketIds.length} migrated ticket(s)`
    );
  }

  console.log("\n──────── Summary ────────");
  console.log(`  Zammad staff seen:        ${seen}`);
  console.log(`  users created:            ${created}`);
  console.log(`  skipped (already existed):${skippedExisting}`);
  console.log(`  skipped (no email):       ${skippedNoEmail}`);
  console.log(`  comments connected:       ${commentsConnected}`);
  console.log(`  attachments connected:    ${attachmentsConnected}`);
  console.log(`  ticket assignees linked:  ${ticketsAssigned}`);
  if (ownerlessInZammad > 0) {
    console.log(
      `  (${ownerlessInZammad} migrated ticket(s) had no owner in Zammad either — left unassigned)`
    );
  }
  if (ownersWithoutAccount.size > 0) {
    console.log(
      `\n  ${ownersWithoutAccount.size} Zammad ticket owner(s) still have no Docket account, ` +
        "so their tickets stay unassigned:\n" +
        [...ownersWithoutAccount].map((e) => `    - ${e}`).join("\n") +
        "\n  (usually staff who lost their Zammad agent/admin role, or were deleted — " +
        "add them under Admin → Users and re-run this script to link their tickets.)"
    );
  }
  if (ownerLookupFailed > 0) {
    console.log(
      `\n  ${ownerLookupFailed} ticket(s) could not be checked against Zammad (see warnings above) — re-run to retry.`
    );
  }
  if (!DRY_RUN && created > 0) {
    console.log(
      "\n  Every account created here shares the password you set in " +
        "MIGRATION_USER_PASSWORD. Ask each person to change it at first sign-in."
    );
  }
  console.log("");
}

main()
  .then(async () => {
    await dbClient.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("\nMigration aborted:", err);
    await dbClient.end().catch(() => undefined);
    process.exit(1);
  });

// Runnable commands (dry run first, then the real one) are in
// docs/deployment-and-zammad-migration.md §7.1–7.2 — kept there rather than
// duplicated here so there is one copy to keep correct.
