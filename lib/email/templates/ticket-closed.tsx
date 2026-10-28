import { createElement } from "react";
import { Button, Hr, Link, Section, Text } from "react-email";
import { createEmailStyles, EmailLayout } from "@/lib/email/components/layout";
import { renderEmailTemplate } from "@/lib/email/renderer";
import { renderCustomEmail } from "@/lib/email-templates";
import { getEmailBranding } from "@/lib/settings";

function TicketClosedEmail({
  customerName,
  ticketNumber,
  ticketSubject,
  ticketUrl,
  productName,
  logoUrl,
  accentColor,
}: {
  customerName: string;
  ticketNumber: number;
  ticketSubject: string;
  ticketUrl: string;
  productName: string;
  logoUrl: string | null;
  accentColor: string;
}) {
  const emailStyles = createEmailStyles(accentColor);
  return (
    <EmailLayout
      logoUrl={logoUrl}
      preview={`[#${ticketNumber}] Your ticket has been closed — ${ticketSubject}`}
      productName={productName}
    >
      <Text style={emailStyles.heading}>Your ticket has been closed</Text>
      <Text style={emailStyles.paragraph}>Hi {customerName},</Text>
      <Text style={emailStyles.paragraph}>
        Your support ticket{" "}
        <strong style={emailStyles.highlight}>#{ticketNumber}</strong> has been
        marked as closed.
      </Text>
      <Text style={{ ...emailStyles.paragraph, color: "#6A89A7" }}>
        <strong>Subject:</strong> {ticketSubject}
      </Text>
      <Text style={emailStyles.paragraph}>
        If you still need help or have further questions, you can reopen the
        ticket at any time by clicking the button below.
      </Text>
      <Section style={{ margin: "24px 0" }}>
        <Button href={ticketUrl} style={emailStyles.button}>
          View Ticket
        </Button>
      </Section>
      <Hr style={{ borderColor: "#BDDDFC", margin: "24px 0" }} />
      <Text style={emailStyles.fallbackLink}>
        If the button does not work, paste this link into your browser:{" "}
        <Link href={ticketUrl} style={emailStyles.link}>
          {ticketUrl}
        </Link>
      </Text>
    </EmailLayout>
  );
}

export async function ticketClosedTemplate(props: {
  customerName: string;
  ticketNumber: number;
  ticketSubject: string;
  ticketUrl: string;
}) {
  const { productName, logoUrl, accentColor } = await getEmailBranding();

  const custom = await renderCustomEmail({
    type: "ticket_closed",
    brandName: productName,
    logoUrl,
    accentColor,
    vars: {
      customerName: props.customerName,
      ticketNumber: String(props.ticketNumber),
      ticketSubject: props.ticketSubject,
      ticketUrl: props.ticketUrl,
    },
  });
  const defaultSubject = `[#${props.ticketNumber}] Your ticket has been closed — ${props.ticketSubject}`;
  if (custom) {
    return { subject: custom.subject, html: custom.html, text: custom.text };
  }

  const html = await renderEmailTemplate(
    createElement(TicketClosedEmail, {
      ...props,
      productName,
      logoUrl,
      accentColor,
    })
  );

  const text = `Hi ${props.customerName},

Your support ticket #${props.ticketNumber} has been closed.

Subject: ${props.ticketSubject}

If you still need help, you can reopen the ticket here: ${props.ticketUrl}

— ${productName}`;

  return { subject: defaultSubject, html, text };
}
