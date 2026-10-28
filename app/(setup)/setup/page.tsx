import { redirect } from "next/navigation";
import { SetupWizard } from "@/app/(setup)/_components/setup-wizard";
import { getVerifiedSession } from "@/lib/authz";
import { hasAdminUser, isSetupComplete } from "@/lib/setup";

export const metadata = {
  title: "Set up",
};

// The setup check queries the database, which must happen per request — a
// build-time prerender either fails (no database in the Docker builder) or
// bakes a stale answer into static HTML.
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  // Once the wizard has actually been finished (its last step called
  // POST /api/setup/finish), this page is done for good — send anyone who
  // lands here to the normal sign-in page.
  if (await isSetupComplete()) {
    redirect("/login");
  }

  // The admin account is created a step before the wizard finishes, so if one
  // already exists here the later client-only step state was lost — usually a
  // reload on the Integrations step. Resume there, don't recreate the account.
  if (await hasAdminUser()) {
    const session = await getVerifiedSession();
    if (!session) {
      // No way to resume the (session-gated) Integrations forms. Send them
      // to sign back in — they can finish integrations from Admin →
      // Integrations afterward.
      redirect("/login");
    }
    return <SetupWizard initialStep="integrations" />;
  }

  return <SetupWizard />;
}
