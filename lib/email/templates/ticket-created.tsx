import { createElement } from "react";
import { Button, Hr, Link, Section, Text } from "react-email";
import { createEmailStyles, EmailLayout } from "@/lib/email/components/layout";
import { renderEmailTemplate } from "@/lib/email/renderer";
import { renderCustomEmail } from "@/lib/email-templates";
import { getEmailBranding } from "@/lib/settings";

function TicketCreatedEmail({
  customerName,
  ticketNumber,
  ticketSubject,
  ticketUrl,
  myTicketsUrl,
  productName,
  logoUrl,
  accentColor,
}: {
  customerName: string;
  ticketNumber: number;
  ticketSubject: string;
  ticketUrl: string;
  myTicketsUrl: string;
  productName: string;
  logoUrl: string | null;
  accentColor: string;
}) {
  const emailStyles = createEmailStyles(accentColor);
  return (
    <EmailLayout
      logoUrl={logoUrl}
      preview={`[#${ticketNumber}] Your ticket has been received — ${ticketSubject}`}
      productName={productName}
    >
      <Text style={emailStyles.heading}>We received your ticket</Text>
      <Text style={emailStyles.paragraph}>Hi {customerName},</Text>
      <Text style={emailStyles.paragraph}>
        Your support ticket{" "}
        <strong style={emailStyles.highlight}>#{ticketNumber}</strong> has been
        received. Our team will review it and get back to you as soon as
        possible.
      </Text>
      <Text style={{ ...emailStyles.paragraph, color: "#6A89A7" }}>
        <strong>Subject:</strong> {ticketSubject}
      </Text>
      <Section style={{ margin: "24px 0" }}>
        <Button href={ticketUrl} style={emailStyles.button}>
          View Your Ticket
        </Button>
      </Section>
      <Hr style={{ borderColor: "#BDDDFC", margin: "24px 0" }} />
      <Text style={emailStyles.muted}>
        You can also find all your tickets by visiting{" "}
        <Link href={myTicketsUrl} style={emailStyles.link}>
          {myTicketsUrl}
        </Link>
        .
      </Text>
      <Text style={emailStyles.fallbackLink}>
        If the button does not work, paste this link into your browser:{" "}
        <Link href={ticketUrl} style={emailStyles.link}>
          {ticketUrl}
        </Link>
      </Text>
    </EmailLayout>
  );
}

export async function ticketCreatedTemplate(props: {
  customerName: string;
  ticketNumber: number;
  ticketSubject: string;
  ticketUrl: string;
  myTicketsUrl: string;
}) {
  const { productName, logoUrl, accentColor } = await getEmailBranding();

  const custom = await renderCustomEmail({
    type: "ticket_created",
    brandName: productName,
    logoUrl,
    accentColor,
    vars: {
      customerName: props.customerName,
      ticketNumber: String(props.ticketNumber),
      ticketSubject: props.ticketSubject,
      ticketUrl: props.ticketUrl,
      myTicketsUrl: props.myTicketsUrl,
    },
  });
  const defaultSubject = `[#${props.ticketNumber}] Your ticket has been received — ${props.ticketSubject}`;
  if (custom) {
    return { subject: custom.subject, html: custom.html, text: custom.text };
  }

  const html = await renderEmailTemplate(
    createElement(TicketCreatedEmail, {
      ...props,
      productName,
      logoUrl,
      accentColor,
    })
  );

  const text = `Hi ${props.customerName},

Your support ticket #${props.ticketNumber} has been received.

Subject: ${props.ticketSubject}

Our team will review it and get back to you as soon as possible.

View your ticket: ${props.ticketUrl}

Find all your tickets: ${props.myTicketsUrl}

— ${productName}`;

  return { subject: defaultSubject, html, text };
}
