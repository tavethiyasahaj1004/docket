import { Button, Link, Section, Text } from "react-email";
import { PRODUCT_NAME } from "@/config/platform";
import { createEmailStyles, EmailLayout } from "@/lib/email/components/layout";

export function ResetPasswordEmail({
  email,
  resetUrl,
  productName = PRODUCT_NAME,
  logoUrl,
  accentColor,
}: {
  email: string;
  resetUrl: string;
  productName?: string;
  logoUrl?: string | null;
  accentColor?: string;
}) {
  const emailStyles = createEmailStyles(accentColor);
  return (
    <EmailLayout
      logoUrl={logoUrl}
      preview={`Set your ${productName} password`}
      productName={productName}
    >
      <Text style={emailStyles.heading}>Set your password</Text>
      <Text style={emailStyles.paragraph}>
        Use the button below to set a password for{" "}
        <strong style={emailStyles.highlight}>{email}</strong>.
      </Text>
      <Section style={{ margin: "24px 0" }}>
        <Button href={resetUrl} style={emailStyles.button}>
          Set Password
        </Button>
      </Section>
      <Text style={emailStyles.muted}>
        This link expires in 1 hour and can only be used once. If you didn't
        request this, you can safely ignore this email.
      </Text>
      <Text style={emailStyles.fallbackLink}>
        If the button does not work, paste this link into your browser:{" "}
        <Link href={resetUrl} style={emailStyles.link}>
          {resetUrl}
        </Link>
      </Text>
    </EmailLayout>
  );
}
