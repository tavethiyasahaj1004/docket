import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { emailTemplates } from "@/db/schema";
import { db } from "@/lib/db";
import {
  DEFAULT_EMAIL_ACCENT,
  emailBrand,
  emailStyles,
} from "@/lib/email/components/layout";
import { richTextToHtml, richTextToPlainText } from "@/lib/rich-text";

export type EmailTemplateType =
  | "ticket_created"
  | "ticket_replied"
  | "ticket_closed"
  | "ticket_merged"
  | "my_tickets_list";

interface MergeTag {
  description: string;
  tag: string;
}

interface EmailTemplateMeta {
  /** Tiptap JSON prefilled into the admin editor when a type has no override
   * yet. Mirrors the built-in JSX design's heading/blockquote/bold structure,
   * which `styleCustomEmailBody()` below restyles at send time. */
  defaultBody: string;
  defaultSubject: string;
  description: string;
  /** True for emails enqueued with `category: "ticket"` in lib/email — these stop sending, and the admin UI locks their editor, when `ticket_email_notifications_enabled` is off. */
  gatedByTicketToggle: boolean;
  label: string;
  mergeTags: MergeTag[];
  type: EmailTemplateType;
}

interface DocTextRun {
  marks?: { type: string }[];
  text: string;
  type: "text";
}

/** Tiny Tiptap-JSON builders — just enough structure to keep `defaultBody` below readable. */
const run = (text: string, mark?: string): DocTextRun =>
  mark
    ? { marks: [{ type: mark }], text, type: "text" }
    : { text, type: "text" };
const bold = (text: string) => run(text, "bold");
const paragraph = (...content: DocTextRun[]) => ({
  type: "paragraph",
  content,
});
const heading = (text: string) => ({
  type: "heading",
  attrs: { level: 2 },
  content: [run(text)],
});
const blockquote = (text: string) => ({
  type: "blockquote",
  content: [paragraph(run(text))],
});
const doc = (...content: object[]) => JSON.stringify({ type: "doc", content });

// Single source of truth for what's customizable and what each email's
// merge tags are — drives both the admin UI's reference panel and the
// preview endpoint's sample data.
export const EMAIL_TEMPLATE_TYPES: EmailTemplateMeta[] = [
  {
    type: "ticket_created",
    label: "Ticket Created",
    description: "Sent to the customer right after they submit a ticket.",
    defaultSubject:
      "[#{{ticketNumber}}] Your ticket has been received — {{ticketSubject}}",
    gatedByTicketToggle: true,
    defaultBody: doc(
      heading("We received your ticket"),
      paragraph(run("Hi "), run("{{customerName}}"), run(",")),
      paragraph(
        run("Your support ticket "),
        bold("#{{ticketNumber}}"),
        run(
          " has been received. Our team will review it and get back to you as soon as possible."
        )
      ),
      paragraph(run("Subject: "), run("{{ticketSubject}}")),
      paragraph(run("View your ticket: "), run("{{ticketUrl}}")),
      paragraph(
        run("You can also find all your tickets here: "),
        run("{{myTicketsUrl}}")
      )
    ),
    mergeTags: [
      { tag: "customerName", description: "Customer's name" },
      { tag: "ticketNumber", description: "e.g. 1042" },
      { tag: "ticketSubject", description: "The ticket's subject line" },
      { tag: "ticketUrl", description: "Link to view the ticket" },
      {
        tag: "myTicketsUrl",
        description: "Link to the customer's ticket list",
      },
      { tag: "brandName", description: "Your configured brand name" },
    ],
  },
  {
    type: "ticket_replied",
    label: "Agent Replied",
    description: "Sent to the customer when an agent posts a public reply.",
    defaultSubject:
      "[#{{ticketNumber}}] New reply on your ticket — {{ticketSubject}}",
    gatedByTicketToggle: true,
    defaultBody: doc(
      heading("New reply on your ticket"),
      paragraph(run("Hi "), run("{{customerName}}"), run(",")),
      paragraph(
        bold("{{agentName}}"),
        run(" has replied to your ticket "),
        bold("#{{ticketNumber}}"),
        run(".")
      ),
      blockquote("{{replyPreview}}"),
      paragraph(run("View your ticket and reply: "), run("{{ticketUrl}}"))
    ),
    mergeTags: [
      { tag: "customerName", description: "Customer's name" },
      { tag: "ticketNumber", description: "e.g. 1042" },
      { tag: "ticketSubject", description: "The ticket's subject line" },
      {
        tag: "agentName",
        description: "The replying agent's name — omit this tag to hide it",
      },
      {
        tag: "replyPreview",
        description: "The first ~500 characters of the reply",
      },
      { tag: "ticketUrl", description: "Link to view the ticket" },
      { tag: "brandName", description: "Your configured brand name" },
    ],
  },
  {
    type: "ticket_closed",
    label: "Ticket Closed",
    description: "Sent to the customer when their ticket is closed.",
    defaultSubject:
      "[#{{ticketNumber}}] Your ticket has been closed — {{ticketSubject}}",
    gatedByTicketToggle: true,
    defaultBody: doc(
      heading("Your ticket has been closed"),
      paragraph(run("Hi "), run("{{customerName}}"), run(",")),
      paragraph(
        run("Your support ticket "),
        bold("#{{ticketNumber}}"),
        run(" has been marked as closed.")
      ),
      paragraph(run("Subject: "), run("{{ticketSubject}}")),
      paragraph(
        run("If you still need help, you can reopen the ticket here: "),
        run("{{ticketUrl}}")
      )
    ),
    mergeTags: [
      { tag: "customerName", description: "Customer's name" },
      { tag: "ticketNumber", description: "e.g. 1042" },
      { tag: "ticketSubject", description: "The ticket's subject line" },
      { tag: "ticketUrl", description: "Link to view (and reopen) the ticket" },
      { tag: "brandName", description: "Your configured brand name" },
    ],
  },
  {
    type: "ticket_merged",
    label: "Ticket Merged",
    description:
      "Sent to the customer when an agent merges one or more of their tickets into another — one email per merge, listing every merged ticket.",
    defaultSubject:
      "[#{{mergedTicketNumber}}] Your ticket has been merged into #{{ticketNumber}} — {{ticketSubject}}",
    gatedByTicketToggle: true,
    defaultBody: doc(
      heading("Your tickets have been combined"),
      paragraph(run("Hi "), run("{{customerName}}"), run(",")),
      paragraph(
        run("Your support ticket "),
        bold("#{{mergedTicketNumber}}"),
        run(" ("),
        run("{{mergedTicketSubject}}"),
        run(") was about the same request as ticket "),
        bold("#{{ticketNumber}}"),
        run(
          ", so we merged them into one. All your messages and attachments are now there, and our team will continue on it."
        )
      ),
      paragraph(run("Subject: "), run("{{ticketSubject}}")),
      paragraph(run("View your ticket: "), run("{{ticketUrl}}"))
    ),
    mergeTags: [
      { tag: "customerName", description: "Customer's name" },
      {
        tag: "mergedTicketNumber",
        description:
          "The ticket(s) merged away, e.g. 1043 — or 1043, #1044 when several were merged at once (write it as #{{mergedTicketNumber}})",
      },
      {
        tag: "mergedTicketSubject",
        description:
          'Subject of the ticket merged away — several are joined with "; "',
      },
      {
        tag: "ticketNumber",
        description: "The ticket it was merged into, e.g. 1042",
      },
      {
        tag: "ticketSubject",
        description: "Subject of the ticket it was merged into",
      },
      {
        tag: "ticketUrl",
        description: "Link to the ticket it was merged into",
      },
      { tag: "brandName", description: "Your configured brand name" },
    ],
  },
  {
    type: "my_tickets_list",
    label: "My Tickets List",
    description: "Sent when a customer asks to find their tickets by email.",
    defaultSubject: "Your support tickets",
    gatedByTicketToggle: false,
    defaultBody: doc(
      heading("Your support tickets"),
      paragraph(
        run("Here's a secure link to view all "),
        run("{{ticketCount}}"),
        run(" of your tickets.")
      ),
      paragraph(run("View my tickets: "), run("{{listUrl}}")),
      paragraph(run("This link expires in 7 days."))
    ),
    mergeTags: [
      { tag: "listUrl", description: "Link to the customer's ticket list" },
      { tag: "ticketCount", description: "How many open tickets they have" },
      { tag: "brandName", description: "Your configured brand name" },
    ],
  },
];

export function getEmailTemplateMeta(
  type: EmailTemplateType
): EmailTemplateMeta {
  const meta = EMAIL_TEMPLATE_TYPES.find((t) => t.type === type);
  if (!meta) {
    throw new Error(`Unknown email template type: ${type}`);
  }
  return meta;
}

export type EmailTemplateRow = typeof emailTemplates.$inferSelect;

export async function getEmailTemplate(
  type: EmailTemplateType
): Promise<EmailTemplateRow | undefined> {
  const [row] = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.type, type))
    .limit(1);
  return row;
}

export async function getAllEmailTemplates(): Promise<
  Record<EmailTemplateType, EmailTemplateRow | undefined>
> {
  const rows = await db.select().from(emailTemplates);
  const byType = new Map(rows.map((r) => [r.type, r]));
  return Object.fromEntries(
    EMAIL_TEMPLATE_TYPES.map((t) => [t.type, byType.get(t.type)])
  ) as Record<EmailTemplateType, EmailTemplateRow | undefined>;
}

/** Upsert a type's subject/body. Passing `null` for a field resets it to the built-in default. */
export async function setEmailTemplate(
  type: EmailTemplateType,
  fields: { subject?: string | null; body?: string | null }
): Promise<EmailTemplateRow> {
  const now = new Date();
  const [existing] = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.type, type))
    .limit(1);

  const subject =
    fields.subject === undefined ? (existing?.subject ?? null) : fields.subject;
  const body =
    fields.body === undefined ? (existing?.body ?? null) : fields.body;

  const [row] = await db
    .insert(emailTemplates)
    .values({
      id: createId(),
      type,
      subject,
      body,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: emailTemplates.type,
      set: { subject, body, updatedAt: now },
    })
    .returning();
  return row;
}

/** Replace every `{{tag}}` occurrence found in `vars`; unrecognized tags are left as-is. */
export function substituteTags(
  input: string,
  vars: Record<string, string>
): string {
  return input.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
    Object.hasOwn(vars, key) ? vars[key] : match
  );
}

function renderShell({
  brandName,
  logoUrl,
  bodyHtml,
}: {
  brandName: string;
  logoUrl: string | null;
  bodyHtml: string;
}): string {
  const header = logoUrl
    ? `<img src="${logoUrl}" alt="${brandName}" height="32" style="display:block;margin-bottom:24px;border:none;" />`
    : `<p style="font-weight:900;letter-spacing:0;margin:0 0 24px;color:${emailBrand.bark};font-size:16px;">${brandName}</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:${emailBrand.surface};font-family:${emailStyles.body.fontFamily};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${emailBrand.surface};padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:${emailBrand.white};border:1px solid ${emailBrand.cream};border-radius:10px;">
          <tr>
            <td style="padding:32px;">
              ${header}
              <div style="color:${emailBrand.bark};font-size:15px;line-height:24px;">${bodyHtml}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export interface RenderCustomEmailResult {
  html: string;
  subject: string;
  text: string;
}

const ANCHOR_TAG_RE = /<a\s+([^>]*?)href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g;
const BARE_URL_RE = /(https?:\/\/[^\s<]+)/g;
const CTA_CLASS_RE = /\sclass="[^"]*\bcta-button\b[^"]*"/;
const HEADING_TAG_RE = /<h([1-3])>/g;
const HEADING_SIZES: Record<string, { line: string; size: string }> = {
  "1": { line: "32px", size: "24px" },
  "2": { line: "28px", size: "20px" },
  "3": { line: "24px", size: "17px" },
};

/** Reapplies the built-in design to a custom body, which as free-form rich text
 * carries none of it. A link becomes the pill CTA when its visible text is the
 * URL itself or the admin tagged it `class="cta-button"`; other links, headings,
 * blockquotes and `<strong>` get their accent/callout treatment. */
function styleCustomEmailBody(html: string, accentColor: string): string {
  const buttonStyle =
    "display:inline-block;margin:6px 0;padding:12px 18px;" +
    `background-color:${accentColor};color:#ffffff;font-weight:700;` +
    "font-size:14px;line-height:1;border-radius:6px;text-decoration:none;" +
    // A raw URL used as its own label (the common case) is one long
    // unbreakable string — without this, it forces the whole email wider
    // than its fixed layout instead of wrapping inside the button.
    "max-width:100%;overflow-wrap:anywhere;";
  const linkStyle = `color:${accentColor};text-decoration:underline;overflow-wrap:anywhere;`;

  const withStyledAnchors = html.replace(
    ANCHOR_TAG_RE,
    (_match, pre: string, href: string, post: string, text: string) => {
      const isCta =
        text.trim() === href ||
        CTA_CLASS_RE.test(pre) ||
        CTA_CLASS_RE.test(post);
      const cleanPre = pre.replace(CTA_CLASS_RE, "");
      const cleanPost = post.replace(CTA_CLASS_RE, "");
      const style = isCta ? buttonStyle : linkStyle;
      return `<a ${cleanPre}href="${href}"${cleanPost} style="${style}">${text}</a>`;
    }
  );

  // Anything outside an <a>...</a> segment may still contain a bare URL —
  // e.g. a {{ticketUrl}} tag substituted into plain text — so linkify those
  // as CTA buttons too.
  const withStyledLinks = withStyledAnchors
    .split(/(<a[\s\S]*?<\/a>)/g)
    .map((segment) =>
      segment.startsWith("<a")
        ? segment
        : segment.replace(
            BARE_URL_RE,
            (url) => `<a href="${url}" style="${buttonStyle}">${url}</a>`
          )
    )
    .join("");

  return withStyledLinks
    .replace(HEADING_TAG_RE, (_match, level: string) => {
      const { size, line } = HEADING_SIZES[level];
      return `<h${level} style="color:#384959;font-size:${size};font-weight:800;line-height:${line};margin:0 0 16px;">`;
    })
    .replace(
      /<blockquote>/g,
      `<blockquote style="background-color:#F7F9FB;border-left:3px solid ${accentColor};border-radius:4px;margin:16px 0;padding:4px 16px;">`
    )
    .replace(/<strong>/g, `<strong style="color:${accentColor};">`);
}

function renderTemplate({
  subject,
  body,
  vars,
  brandName,
  logoUrl,
  accentColor,
}: {
  subject: string;
  body: string;
  vars: Record<string, string>;
  brandName: string;
  logoUrl: string | null;
  accentColor: string;
}): RenderCustomEmailResult {
  const allVars = { ...vars, brandName };
  const bodyHtml = styleCustomEmailBody(
    substituteTags(richTextToHtml(body), allVars),
    accentColor
  );
  return {
    subject: substituteTags(subject, allVars),
    html: renderShell({ brandName, logoUrl, bodyHtml }),
    text: substituteTags(richTextToPlainText(body), allVars),
  };
}

/** Renders the admin's customized email for `type`, or null so the caller falls
 * back to its hardcoded template. `vars` holds every merge-tag value for this
 * send, already stringified (e.g. ticketNumber as "1042"). */
export async function renderCustomEmail({
  type,
  vars,
  brandName,
  logoUrl,
  accentColor = DEFAULT_EMAIL_ACCENT,
}: {
  type: EmailTemplateType;
  vars: Record<string, string>;
  brandName: string;
  logoUrl: string | null;
  accentColor?: string;
}): Promise<RenderCustomEmailResult | null> {
  const row = await getEmailTemplate(type);
  // A custom body is what activates this path: the default body is hardcoded JSX
  // this function can't render, so a subject-only customization isn't enough.
  // Subject still falls back to the default when blank.
  if (!row?.body) {
    return null;
  }

  const meta = getEmailTemplateMeta(type);
  return renderTemplate({
    subject: row.subject ?? meta.defaultSubject,
    body: row.body,
    vars,
    brandName,
    logoUrl,
    accentColor,
  });
}

const SAMPLE_VARS: Record<EmailTemplateType, Record<string, string>> = {
  ticket_created: {
    customerName: "Jane Doe",
    ticketNumber: "1042",
    ticketSubject: "Cannot log in",
    ticketUrl: "https://support.example.com/ticket/cku1a2b3c4d5e6f?token=...",
    myTicketsUrl: "https://support.example.com/my-tickets",
  },
  ticket_replied: {
    customerName: "Jane Doe",
    ticketNumber: "1042",
    ticketSubject: "Cannot log in",
    agentName: "Alex",
    replyPreview: "Thanks for reaching out — looking into this now.",
    ticketUrl: "https://support.example.com/ticket/cku1a2b3c4d5e6f?token=...",
  },
  ticket_closed: {
    customerName: "Jane Doe",
    ticketNumber: "1042",
    ticketSubject: "Cannot log in",
    ticketUrl: "https://support.example.com/ticket/cku1a2b3c4d5e6f?token=...",
  },
  ticket_merged: {
    customerName: "Jane Doe",
    mergedTicketNumber: "1043",
    mergedTicketSubject: "Login still broken",
    ticketNumber: "1042",
    ticketSubject: "Cannot log in",
    ticketUrl: "https://support.example.com/ticket/cku1a2b3c4d5e6f?token=...",
  },
  my_tickets_list: {
    listUrl: "https://support.example.com/my-tickets/abc123",
    ticketCount: "3",
  },
};

/** Renders unsaved editor edits against fixed sample data, for the "Preview"
 * button. `subject`/`body` fall back to the type's default subject and an empty
 * body when not yet filled in. */
export function renderEmailPreview({
  type,
  subject,
  body,
  brandName,
  logoUrl,
  accentColor = DEFAULT_EMAIL_ACCENT,
}: {
  type: EmailTemplateType;
  subject: string | null;
  body: string;
  brandName: string;
  logoUrl: string | null;
  accentColor?: string;
}): RenderCustomEmailResult {
  const meta = getEmailTemplateMeta(type);
  return renderTemplate({
    subject: subject?.trim() ? subject : meta.defaultSubject,
    body,
    vars: SAMPLE_VARS[type],
    brandName,
    logoUrl,
    accentColor,
  });
}
