import { createElement } from "react";
import { Button, Hr, Link, Section, Text } from "react-email";
import { createEmailStyles, EmailLayout } from "@/lib/email/components/layout";
import { renderEmailTemplate } from "@/lib/email/renderer";
import { renderCustomEmail } from "@/lib/email-templates";
import { getEmailBranding } from "@/lib/settings";

function TicketRepliedEmail({
  customerName,
  ticketNumber,
  ticketSubject,
  replyPreview,
  ticketUrl,
  agentName,
  productName,
  logoUrl,
  accentColor,
}: {
  customerName: string;
  ticketNumber: number;
  ticketSubject: string;
  replyPreview: string;
  ticketUrl: string;
  agentName: string;
  productName: string;
  logoUrl: string | null;
  accentColor: string;
}) {
  const truncated = replyPreview.length === 500;
  const emailStyles = createEmailStyles(accentColor);

  return (
    <EmailLayout
      logoUrl={logoUrl}
      preview={`[#${ticketNumber}] New reply on your ticket — ${ticketSubject}`}
      productName={productName}
    >
      <Text style={emailStyles.heading}>New reply on your ticket</Text>
      <Text style={emailStyles.paragraph}>Hi {customerName},</Text>
      <Text style={emailStyles.paragraph}>
        <strong style={emailStyles.highlight}>{agentName}</strong> from the{" "}
        {productName} support team has replied to your ticket{" "}
        <strong style={emailStyles.highlight}>#{ticketNumber}</strong>.
      </Text>
      <Section
        style={{
          backgroundColor: "#F7F9FB",
          borderLeft: `3px solid ${accentColor}`,
          borderRadius: "4px",
          margin: "16px 0",
          padding: "12px 16px",
        }}
      >
        <Text style={{ ...emailStyles.paragraph, margin: 0 }}>
          {replyPreview}
          {truncated && <span style={{ color: "#6A89A7" }}>…</span>}
        </Text>
      </Section>
      {truncated && (
        <Text style={emailStyles.muted}>
          Message truncated —{" "}
          <Link href={ticketUrl} style={emailStyles.link}>
            read the full reply
          </Link>
          .
        </Text>
      )}
      <Section style={{ margin: "24px 0" }}>
        <Button href={ticketUrl} style={emailStyles.button}>
          View Ticket &amp; Reply
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

export async function ticketRepliedTemplate(props: {
  customerName: string;
  ticketNumber: number;
  ticketSubject: string;
  replyContent: string;
  ticketUrl: string;
  agentName: string;
}) {
  const { productName, logoUrl, accentColor } = await getEmailBranding();
  const replyPreview = props.replyContent.slice(0, 500);

  const custom = await renderCustomEmail({
    type: "ticket_replied",
    brandName: productName,
    logoUrl,
    accentColor,
    vars: {
      customerName: props.customerName,
      ticketNumber: String(props.ticketNumber),
      ticketSubject: props.ticketSubject,
      agentName: props.agentName,
      replyPreview,
      ticketUrl: props.ticketUrl,
    },
  });
  const defaultSubject = `[#${props.ticketNumber}] New reply on your ticket — ${props.ticketSubject}`;
  if (custom) {
    return { subject: custom.subject, html: custom.html, text: custom.text };
  }

  const html = await renderEmailTemplate(
    createElement(TicketRepliedEmail, {
      customerName: props.customerName,
      ticketNumber: props.ticketNumber,
      ticketSubject: props.ticketSubject,
      replyPreview,
      ticketUrl: props.ticketUrl,
      agentName: props.agentName,
      productName,
      logoUrl,
      accentColor,
    })
  );

  const text = `Hi ${props.customerName},

${props.agentName} from the ${productName} support team replied to your ticket #${props.ticketNumber}.

Subject: ${props.ticketSubject}

---
${replyPreview}${props.replyContent.length > 500 ? "…" : ""}
---

View your ticket and reply: ${props.ticketUrl}

— ${productName}`;

  return { subject: defaultSubject, html, text };
}
