import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { ADMIN_ROLE, AGENT_ROLE } from "@/config/platform";
import { user } from "@/db/schema";
import { getVerifiedSession } from "@/lib/authz";
import { db } from "@/lib/db";

// Pure routing logic, so every exit must be *terminal* for the state that sent
// us here. /login isn't, for a broken session — its "already signed in" guard
// bounces straight back. Those go to /api/session-reset, which unlike a page can
// clear the cookies before landing on /login.
export const dynamic = "force-dynamic";

export default async function PostAuthPage() {
  // Arriving without a real session means the browser holds cookies that no
  // longer resolve. Clear them rather than redirecting, so they can't keep
  // satisfying the proxy's cookie-cache read on every protected route.
  const session = await getVerifiedSession();
  if (!session) {
    redirect("/api/session-reset");
  }

  const [freshUser] = await db
    .select({ role: user.role, banned: user.banned })
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1);

  // Session survives but its user doesn't, or they were banned out of band —
  // there is nothing to sign in as. Clear the cookies rather than redirecting
  // into a loop.
  if (!freshUser || freshUser.banned) {
    redirect("/api/session-reset");
  }

  if (freshUser.role === ADMIN_ROLE) {
    redirect("/tickets");
  }
  if (freshUser.role === AGENT_ROLE) {
    redirect("/tickets");
  }

  // No role assigned yet — show a pending access page
  redirect("/unauthorized");
}
