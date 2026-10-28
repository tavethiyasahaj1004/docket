import {
  EMAIL_TEMPLATE_TYPES,
  getAllEmailTemplates,
} from "@/lib/email-templates";
import { getPlatformSettings } from "@/lib/settings";
import { EmailTemplatesSection } from "./_components/email-templates-section";

export const metadata = { title: "Email Templates" };

export default async function EmailTemplatesPage() {
  const [rows, settings] = await Promise.all([
    getAllEmailTemplates(),
    getPlatformSettings(),
  ]);

  const templates = EMAIL_TEMPLATE_TYPES.map((meta) => ({
    type: meta.type,
    label: meta.label,
    description: meta.description,
    defaultSubject: meta.defaultSubject,
    defaultBody: meta.defaultBody,
    gatedByTicketToggle: meta.gatedByTicketToggle,
    mergeTags: meta.mergeTags,
    subject: rows[meta.type]?.subject ?? null,
    body: rows[meta.type]?.body ?? null,
  }));

  // Page title + description come from the TopBar (components/agent/topbar.tsx).
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <EmailTemplatesSection
        initialAccentColor={settings.emailAccentColor}
        initialTemplates={templates}
        initialTicketEmailNotificationsEnabled={
          settings.ticketEmailNotificationsEnabled
        }
      />
    </div>
  );
}
