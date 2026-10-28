import { ReplyComposerPreferencesCard } from "@/components/settings/reply-composer-preferences-card";
// import { SlaDisplayPreferencesCard } from "@/components/settings/sla-display-preferences-card";
import { requireAgent } from "@/lib/authz";
import {
  getSendReplyOnEnterPref,
  // getShowSlaAndOverduePref,
} from "@/lib/user-preferences";

export const metadata = { title: "Settings" };

// Personal (per-agent) preferences, as opposed to org-wide settings under
// /admin/*. New personal settings land here as additional cards.
export default async function SettingsPage() {
  const session = await requireAgent();
  // SLA is hidden for now (see docs/tickets.md § SLA) — the pref fetch and
  // the <SlaDisplayPreferencesCard> render below are commented out, not
  // deleted, so the feature can be restored by uncommenting.
  const [sendReplyOnEnter /* , showSlaAndOverdue */] = await Promise.all([
    getSendReplyOnEnterPref(session.id),
    // getShowSlaAndOverduePref(session.id),
  ]);

  // Page title + description come from the TopBar (components/agent/topbar.tsx).
  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      {/* <SlaDisplayPreferencesCard initialShowSlaAndOverdue={showSlaAndOverdue} /> */}
      <ReplyComposerPreferencesCard
        initialSendReplyOnEnter={sendReplyOnEnter}
      />
    </div>
  );
}
