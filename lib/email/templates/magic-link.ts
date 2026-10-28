import { createElement } from "react";
import { MagicLinkEmail } from "@/lib/email/components/magic-link";
import { renderEmailTemplate } from "@/lib/email/renderer";
import { getEmailBranding } from "@/lib/settings";

export async function magicLinkTemplate({
  email,
  magicLinkUrl,
}: {
  email: string;
  magicLinkUrl: string;
}) {
  const { productName, logoUrl, accentColor } = await getEmailBranding();
  const html = await renderEmailTemplate(
    createElement(MagicLinkEmail, {
      email,
      magicLinkUrl,
      productName,
      logoUrl,
      accentColor,
    })
  );

  const text = `Sign in to ${productName}

Use this link to sign in as ${email}:
${magicLinkUrl}

If you did not request this link, you can ignore this email.`;

  return { html, text };
}
