import { desc, eq } from "drizzle-orm";
import {
  AccountIdentityForms,
  DeleteAccountForm,
} from "@/components/profile/account-forms";
import { ExportDataCard } from "@/components/profile/export-data-card";
import { PasswordCard } from "@/components/profile/password-card";
import {
  type SessionRow,
  SessionsCard,
} from "@/components/profile/sessions-card";
import {
  account,
  session as sessionTable,
  user as userTable,
} from "@/db/schema";
import { requireSession } from "@/lib/authz";
import { db } from "@/lib/db";
import { getPlatformSettings } from "@/lib/settings";

export const metadata = { title: "Your Profile" };

// This page's queries need the CURRENT session's token (to flag it "Current"
// in the sessions list) — requireSession() hits the DB directly for that,
// unlike getSessionUser() which only reads identity out of middleware
// headers. See lib/authz.ts.
export default async function ProfilePage() {
  const current = await requireSession();

  const [freshUser, sessions, accounts, settings] = await Promise.all([
    // current.user.name/email come from Better Auth's 60s cookie cache
    // (lib/auth.ts), so they can still show the pre-edit value right after
    // updateNameAction/changeEmailAction write the DB directly. Re-read the
    // row fresh so this page (where those edits happen) never echoes stale
    // cached data back at the user who just saved it.
    db
      .select({ name: userTable.name, email: userTable.email })
      .from(userTable)
      .where(eq(userTable.id, current.user.id))
      .then((rows) => rows[0]),
    db
      .select({
        id: sessionTable.id,
        createdAt: sessionTable.createdAt,
        expiresAt: sessionTable.expiresAt,
        ipAddress: sessionTable.ipAddress,
        userAgent: sessionTable.userAgent,
        token: sessionTable.token,
      })
      .from(sessionTable)
      .where(eq(sessionTable.userId, current.user.id))
      .orderBy(desc(sessionTable.createdAt)),
    db
      .select({ providerId: account.providerId })
      .from(account)
      .where(eq(account.userId, current.user.id)),
    getPlatformSettings(),
  ]);

  if (!freshUser) {
    return null;
  }

  const sessionRows: SessionRow[] = sessions.map((s) => ({
    id: s.id,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    ipAddress: s.ipAddress,
    userAgent: s.userAgent,
    isCurrent: s.token === current.session.token,
  }));

  const hasPassword = accounts.some((a) => a.providerId === "credential");

  // Page title + description come from the TopBar (components/agent/topbar.tsx).
  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <AccountIdentityForms email={freshUser.email} name={freshUser.name} />

      {settings.passwordLoginEnabled && (
        <PasswordCard hasPassword={hasPassword} />
      )}

      <SessionsCard sessions={sessionRows} />

      <ExportDataCard />

      <DeleteAccountForm email={freshUser.email} />
    </div>
  );
}
