import { createElement } from "react";
import { ResetPasswordEmail } from "@/lib/email/components/reset-password";
import { renderEmailTemplate } from "@/lib/email/renderer";
import { getEmailBranding } from "@/lib/settings";

export async function resetPasswordTemplate({
  email,
  resetUrl,
}: {
  email: string;
  resetUrl: string;
}) {
  const { productName, logoUrl, accentColor } = await getEmailBranding();
  const html = await renderEmailTemplate(
    createElement(ResetPasswordEmail, {
      email,
      resetUrl,
      productName,
      logoUrl,
      accentColor,
    })
  );

  const text = `Set your ${productName} password

Use this link to set a password for ${email}:
${resetUrl}

This link expires in 1 hour and can only be used once. If you did not request this, you can ignore this email.`;

  return { html, text };
}
