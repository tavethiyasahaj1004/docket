import { createElement } from "react";
import { Button, Hr, Link, Section, Text } from "react-email";
import { createEmailStyles, EmailLayout } from "@/lib/email/components/layout";
import { renderEmailTemplate } from "@/lib/email/renderer";
import { renderCustomEmail } from "@/lib/email-templates";
import { getEmailBranding } from "@/lib/settings";

interface TicketMergedProps {
  customerName: string;
  /** The tickets merged away (closed, now forwarding to the target), oldest
   * first. One merge can fold in several — they share one email. */
  mergedTickets: { ticketNumber: number; subject: string }[];
  /** The ticket the conversation continues in. */
  ticketNumber: number;
  ticketSubject: string;
  ticketUrl: string;
}

/** "#1043" / "#1043 and #1044" / "#1043, #1044 and #1045". */
function listNumbers(mergedTickets: TicketMergedProps["mergedTickets"]) {
  const numbers = mergedTickets.map((t) => `#${t.ticketNumber}`);
  return numbers.length <= 1
    ? (numbers[0] ?? "")
    : `${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
}

function TicketMergedEmail({
  customerName,
  mergedTickets,
  ticketNumber,
  ticketSubject,
  ticketUrl,
  productName,
  logoUrl,
  accentColor,
}: TicketMergedProps & {
  productName: string;
  logoUrl: string | null;
  accentColor: string;
}) {
  const emailStyles = createEmailStyles(accentColor);
  const single = mergedTickets.length === 1 ? mergedTickets[0] : null;
  const numbers = listNumbers(mergedTickets);
  return (
    <EmailLayout
      logoUrl={logoUrl}
      preview={
        single
          ? `[#${single.ticketNumber}] Your ticket has been merged into #${ticketNumber}`
          : `Your tickets ${numbers} have been merged into #${ticketNumber}`
      }
      productName={productName}
    >
      <Text style={emailStyles.heading}>Your tickets have been combined</Text>
      <Text style={emailStyles.paragraph}>Hi {customerName},</Text>
      {single ? (
        <Text style={emailStyles.paragraph}>
          Your support ticket{" "}
          <strong style={emailStyles.highlight}>#{single.ticketNumber}</strong>{" "}
          ({single.subject}) was about the same request as ticket{" "}
          <strong style={emailStyles.highlight}>#{ticketNumber}</strong>, so we
          merged them into one. All your messages and attachments are now in{" "}
          <strong style={emailStyles.highlight}>#{ticketNumber}</strong>, and
          our team will continue there.
        </Text>
      ) : (
        <>
          <Text style={emailStyles.paragraph}>
            These support tickets were about the same request as ticket{" "}
            <strong style={emailStyles.highlight}>#{ticketNumber}</strong>, so
            we merged them into it:
          </Text>
          <ul style={{ ...emailStyles.paragraph, paddingLeft: "20px" }}>
            {mergedTickets.map((t) => (
              <li key={t.ticketNumber}>
                <strong style={emailStyles.highlight}>#{t.ticketNumber}</strong>{" "}
                ({t.subject})
              </li>
            ))}
          </ul>
          <Text style={emailStyles.paragraph}>
            All your messages and attachments are now in{" "}
            <strong style={emailStyles.highlight}>#{ticketNumber}</strong>, and
            our team will continue there.
          </Text>
        </>
      )}
      <Text style={{ ...emailStyles.paragraph, color: "#6A89A7" }}>
        <strong>Subject:</strong> {ticketSubject}
      </Text>
      <Text style={emailStyles.paragraph}>
        Please reply on ticket #{ticketNumber} from now on. Your old{" "}
        {single ? `link for #${single.ticketNumber}` : `links for ${numbers}`}{" "}
        also {single ? "opens" : "open"} it.
      </Text>
      <Section style={{ margin: "24px 0" }}>
        <Button href={ticketUrl} style={emailStyles.button}>
          View Ticket #{ticketNumber}
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

export async function ticketMergedTemplate(props: TicketMergedProps) {
  const { productName, logoUrl, accentColor } = await getEmailBranding();

  const custom = await renderCustomEmail({
    type: "ticket_merged",
    brandName: productName,
    logoUrl,
    accentColor,
    vars: {
      customerName: props.customerName,
      // Templates write "#{{mergedTicketNumber}}", so several numbers are
      // joined with ", #" to render as "#1043, #1044".
      mergedTicketNumber: props.mergedTickets
        .map((t) => t.ticketNumber)
        .join(", #"),
      mergedTicketSubject: props.mergedTickets.map((t) => t.subject).join("; "),
      ticketNumber: String(props.ticketNumber),
      ticketSubject: props.ticketSubject,
      ticketUrl: props.ticketUrl,
    },
  });
  const single =
    props.mergedTickets.length === 1 ? props.mergedTickets[0] : null;
  const numbers = listNumbers(props.mergedTickets);
  const defaultSubject = single
    ? `[#${single.ticketNumber}] Your ticket has been merged into #${props.ticketNumber} — ${props.ticketSubject}`
    : `[#${props.ticketNumber}] Your tickets ${numbers} have been merged into #${props.ticketNumber} — ${props.ticketSubject}`;
  if (custom) {
    return { subject: custom.subject, html: custom.html, text: custom.text };
  }

  const html = await renderEmailTemplate(
    createElement(TicketMergedEmail, {
      ...props,
      productName,
      logoUrl,
      accentColor,
    })
  );

  const text = `Hi ${props.customerName},

${
  single
    ? `Your support ticket #${single.ticketNumber} (${single.subject}) was about the same request as ticket #${props.ticketNumber}, so we merged them into one. `
    : `These support tickets were about the same request as ticket #${props.ticketNumber}, so we merged them into it:\n${props.mergedTickets.map((t) => `- #${t.ticketNumber} (${t.subject})`).join("\n")}\n\n`
}All your messages and attachments are now in #${props.ticketNumber}, and our team will continue there.

Subject: ${props.ticketSubject}

View ticket #${props.ticketNumber}: ${props.ticketUrl}

— ${productName}`;

  return { subject: defaultSubject, html, text };
}
