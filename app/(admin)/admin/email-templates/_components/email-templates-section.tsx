"use client";

import { useState } from "react";
import { EmailBrandingSettingsForm } from "./email-branding-settings-form";
import { EmailSendingSettingsForm } from "./email-sending-settings-form";
import {
  EmailTemplatesManager,
  type TemplateItem,
} from "./email-templates-manager";

interface Props {
  initialAccentColor: string | null;
  initialTemplates: TemplateItem[];
  initialTicketEmailNotificationsEnabled: boolean;
}

export function EmailTemplatesSection({
  initialAccentColor,
  initialTemplates,
  initialTicketEmailNotificationsEnabled,
}: Props) {
  const [ticketEmailNotificationsEnabled, setTicketEmailNotificationsEnabled] =
    useState(initialTicketEmailNotificationsEnabled);

  return (
    <>
      <EmailBrandingSettingsForm initialAccentColor={initialAccentColor} />
      <EmailSendingSettingsForm
        enabled={ticketEmailNotificationsEnabled}
        onChange={setTicketEmailNotificationsEnabled}
      />
      <EmailTemplatesManager
        initialTemplates={initialTemplates}
        ticketEmailNotificationsEnabled={ticketEmailNotificationsEnabled}
      />
    </>
  );
}
