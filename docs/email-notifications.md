# Email Notifications

## Overview

Docket sends email notifications at key ticket lifecycle events. All emails are sent via SMTP (Nodemailer), queued through pg-boss, and built with react-email templates.

Customers are notified by **email**. Agents are notified **in-app** (notification bell)
when a customer replies — agents do not receive email. See [in-app-notifications.md](./in-app-notifications.md).

---

## Notification Events (email → customer)

| Event | Recipient | Trigger |
|-------|-----------|---------|
| Ticket created | Customer | Ticket is submitted |
| Agent replied | Customer | Agent posts a public reply |
| Ticket closed | Customer | Ticket status changes to a closed state |
| Ticket merged | Customer | An agent merges one of their tickets into another (admin can turn off) |
| Ticket created (split) | Customer | An agent splits one of their replies into a new ticket |

> Customer replies notify agents **in-app only** (not by email). See the dedicated doc.

---

## 1. Ticket Created

**To:** Customer email (from ticket form)
**Subject:** `[#1042] Your ticket has been received — {subject}`

**Content:**
- Confirmation that the ticket was received.
- Ticket number and subject.
- A direct link to the ticket: `/ticket/{ticketId}?token={customerToken}` — or the integrator's own support page if the ticket was created through an API key with a custom portal URL (see [Per-API-key portal links](#per-api-key-portal-links) below).
- Expected response time note (configurable platform setting — or generic "We'll get back to you as soon as possible.").
- Link to find all their tickets: `/my-tickets` (always Docket's own link — see the note below).

---

## 2. Agent Replied

**To:** Customer email (from ticket)
**Subject:** `[#1042] New reply on your ticket — {subject}`

**Content:**
- Notification that a support agent has replied.
- The reply text (first 500 characters, with a "Read full reply" link if truncated).
- A direct link to the ticket: `/ticket/{ticketId}?token={customerToken}`.
- Link to reply: same ticket link — customer replies inline.

**Trigger condition:** Only sent for public replies (`is_internal = false`). Internal notes never trigger a customer notification.

---

## 3. Ticket Closed

**To:** Customer email (from ticket)
**Subject:** `[#1042] Your ticket has been closed — {subject}`

**Content:**
- Notification that the ticket has been closed.
- Option to reopen: link to the ticket with a note that they can reply or click "Reopen" if they need further help.

---

## 4. Ticket Merged

**To:** Customer email (same customer on both tickets — merges are same-customer only)
**Subject:** `[#1043] Your ticket has been merged into #1042 — {target subject}`
(several at once: `[#1042] Your tickets #1043, #1044 and #1045 have been merged into #1042 — …`)

One email per merge, however many tickets it folds in — the body lists each merged ticket.
In a custom template, `{{mergedTicketNumber}}` then renders as `1043, #1044` (so
`#{{mergedTicketNumber}}` reads `#1043, #1044`) and `{{mergedTicketSubject}}` joins the
subjects with `; `.

**Content:**
- Ticket #1043 (and its subject) was about the same request as #1042, so they were combined.
- All their messages and attachments are now in #1042; they should reply there.
- A button linking to the ticket it was merged into (`resolveTicketPortalUrl()`, so per-API-key
  portal URLs apply). Their old #1043 link also forwards there.

Template: `lib/email/templates/ticket-merged.tsx`, editable as **Ticket Merged** under
`/admin/email-templates` (merge tags: `mergedTicketNumber`, `mergedTicketSubject`,
`ticketNumber`, `ticketSubject`, `ticketUrl`, `customerName`). Sent from `mergeTicketsInto()`
(`lib/tickets/merge.ts`) only when **Admin → Ticket Config → Ticket Actions → Merge → Email the
customer** is on (default on), and — like every ticket email — only while "Docket sends email"
is on.

A **split** reuses the Ticket Created email for the new ticket (see
[tickets.md § Split](./tickets.md#split)).
- Satisfaction feedback (optional — out of scope for MVP).

---

## Customer Replied → agents (in-app, not email)

When a customer replies, agents are notified **in the app** via the notification bell —
no email is sent. Full details in [in-app-notifications.md](./in-app-notifications.md).

---

## Email Queue

All emails are sent via pg-boss queue — never synchronously in the API request.

### Flow

1. API route or server action triggers an email event.
2. `enqueueEmail()` from `lib/email/index.ts` is called with `{ to, subject, html, text }`.
3. This stores the email in the `email_outbox` table and enqueues a pg-boss job.
4. The worker processes the job and sends via Nodemailer.
5. On success: `email_events` record updated with `sent_at`.
6. On failure: pg-boss retries up to 3 times with exponential backoff.

### Enqueue Helper

```typescript
// lib/email/index.ts — already in scaffold

await enqueueEmail({
  to: ticket.customerEmail,
  subject: `[#${ticket.ticketNumber}] Your ticket has been received — ${ticket.subject}`,
  html,
  text,
})
```

---

## Email Templates

Built with react-email. Templates live in `lib/email/templates/`.

| Template | File |
|----------|------|
| Ticket created | `lib/email/templates/ticket-created.tsx` |
| Agent replied | `lib/email/templates/ticket-replied.tsx` |
| Ticket closed | `lib/email/templates/ticket-closed.tsx` |
| My tickets list | `lib/email/templates/my-tickets-list.tsx` |

Each template exports an async function that accepts typed props and returns `{ html, text }`. Before building its hardcoded output, every one of these 4 functions first checks for an admin-saved custom template (see [Customizing Email Templates](#customizing-email-templates) below) and returns that instead if one exists.

### Template Props

```typescript
// ticket-created.tsx
type TicketCreatedProps = {
  customerName: string
  ticketNumber: number
  ticketSubject: string
  ticketUrl: string           // /ticket/{id}?token={token}
  myTicketsUrl: string        // /my-tickets
  productName: string
}

// ticket-replied.tsx
type TicketRepliedProps = {
  customerName: string
  ticketNumber: number
  ticketSubject: string
  replyPreview: string        // first 500 chars of the reply
  ticketUrl: string
  agentName: string
  productName: string
}

// ticket-closed.tsx
type TicketClosedProps = {
  customerName: string
  ticketNumber: number
  ticketSubject: string
  ticketUrl: string
  productName: string
}
```

---

## Customizing Email Templates

Admins can override the subject + body of the 4 customer-facing emails (ticket created/replied/closed, my-tickets-list) from `/admin/email-templates` — a text subject field and a rich-text body editor (the same editor used for ticket replies) per type, plus a live Preview and a Reset to Default. Stored in the `email_templates` table (one row per type, created on first save); an absent row means "use the built-in design."

Bodies use `{{mergeTag}}` placeholders, substituted at send time — e.g. `{{customerName}}`, `{{ticketNumber}}`, `{{ticketUrl}}`. The full list per type is shown in the admin UI's reference panel and defined in `lib/email-templates.ts`'s `EMAIL_TEMPLATE_TYPES`. Unrecognized tags are left as literal text rather than erroring.

**Hiding the replying agent's name** isn't a separate toggle — the "Agent Replied" template's default body includes `{{agentName}}`; an admin who doesn't want it shown just edits the template body and removes that tag (e.g. "Our support team has replied…" instead of "{{agentName}} has replied…").

Customized bodies render as clean rich text (paragraphs, headings, blockquotes, bold, lists, links) through the same Tiptap-based renderer that renders reply content in the public API — safe by construction, since it only ever emits the schema's own whitelisted tags. They do **not** get the default template's muted "if the button doesn't work" fallback line — that's a presentation detail of the built-in design, not something a rich-text body can reproduce. Everything else about the built-in look *is* reproduced automatically by `renderCustomEmail()`'s post-processing step (`styleCustomEmailBody()` in `lib/email-templates.ts`), driven off the same element types the pre-filled `defaultBody` (`EMAIL_TEMPLATE_TYPES`) already uses:

- A link whose visible text is the URL itself — a `{{ticketUrl}}`-style tag typed as plain text, or a pasted bare URL — becomes a CTA button; a link with a custom label (from the editor's own link tool) instead gets styled as a plain accent-colored link.
- `<h1>`/`<h2>`/`<h3>` get the built-in design's heading treatment, `<blockquote>` gets its bordered/tinted callout box (used by the "Agent Replied" default body for `{{replyPreview}}`), and `<strong>` gets the accent color — same as the JSX default's highlighted ticket numbers/agent names.

Because the editor is pre-filled with this same structure (not flat plain text), tweaking one word — e.g. dropping `{{agentName}}` — doesn't flatten the rest of the email's look the way a from-scratch plain-text body would.

### Email Accent Color

Admins can set a hex accent color (`platform_settings.email_accent_color`, default `#384959`) from the "Email accent color" panel at the top of `/admin/email-templates`, e.g. to match their brand website. It colors buttons, links, and highlighted values (ticket numbers, agent names) in **every** outgoing email — both the built-in designs and customized bodies — via `createEmailStyles()` in `lib/email/components/layout.tsx`. Body text and headings stay a fixed dark neutral regardless of the chosen accent, so contrast/readability is guaranteed no matter what color is picked. `null` means "use the default." Resolved per-send by `getEmailBranding()` in `lib/settings.ts`, same pattern as brand name/logo.

## Per-API-key portal links

Each API key (`/admin/api-keys`) can optionally set a **customer portal URL template**, e.g. `https://myapp.com/support/{{ticketId}}?token={{token}}`. Tickets created through that key — and every later email about them (agent replied, ticket closed) — link to that URL instead of Docket's own `/ticket/:id` portal, since `tickets.api_key_id` is stored on the ticket and resolved the same way at every send. `POST /api/v1/tickets`'s `portalUrl` response field reflects the same override. Tickets created through the customer portal itself (no API key) are unaffected. The my-tickets-list email's link always stays Docket's own `/my-tickets` — a customer's tickets can span multiple origins, so there's no single correct integrator link to use there. See `resolveTicketPortalUrl()` in `lib/tickets.ts`.

---

## SMTP Configuration

All SMTP settings are environment variables:

| Variable | Description |
|----------|-------------|
| `SMTP_HOST` | SMTP server hostname |
| `SMTP_PORT` | Port (default: 587) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `EMAIL_FROM` | From address, e.g. `Support <support@yourco.com>` |

If `SMTP_HOST` is not set, the worker logs emails to console instead of sending them (dev-friendly behavior inherited from scaffold). In all cases, links inside outgoing emails are also printed to the server console in non-production for quick access.

---

## Disabling Docket's Ticket Emails

`/admin/email-templates` has a **"Docket sends email"** toggle (`platform_settings.ticket_email_notifications_enabled`, default on). It gates only the customer-facing ticket lifecycle emails — ticket created (including split), agent replied, ticket closed, status changed, ticket merged (`enqueueEmail({ ..., category: "ticket" })` in the routes/lib listed above) — checked once, up front, in `enqueueEmail()` (`lib/email/index.ts`) so a disabled email never reaches the outbox/queue.

This exists for teams that consume the same events via [outbound webhooks](webhooks.md) and send the equivalent email themselves from their own backend — turning this off avoids the customer getting duplicate notifications. It does **not** affect agent/admin auth emails (magic link, password reset) or user invites — those always send regardless of this flag, since they aren't mirrored by a webhook event and have no external replacement. The my-tickets-list "send me my tickets" email is also unaffected — it's a customer-initiated self-service request, not an event notification.

---

## Business Rules

1. Only public replies trigger a customer notification — internal notes do not.
2. Notifications are sent asynchronously — API responses do not wait for email delivery.
3. If email delivery fails after 3 retries, the job is moved to the pg-boss dead-letter queue. The ticket operation (create, reply, close) is not rolled back.
4. The `customerToken` embedded in email links is the same token stored in the ticket record — it never expires and does not need to be refreshed.
5. The brand name/logo/accent color shown in every email come from the admin-configurable settings in `/admin/appearance` (name/logo) and `/admin/email-templates` (accent color) — all resolved through `lib/settings.ts`'s `getEmailBranding()`, falling back to `PRODUCT_NAME` (`config/platform.ts`) and `#384959` respectively when unset — not hardcoded values.
6. Admin-customized template subjects/bodies (see above) take priority over the hardcoded design; a template with no saved row/body uses the hardcoded design unchanged.
7. A ticket's customer-facing link uses its originating API key's custom portal URL when one is configured, otherwise Docket's own `/ticket/:id` portal (see [Per-API-key portal links](#per-api-key-portal-links)).
8. Ticket lifecycle emails can be turned off entirely in favor of webhook-driven emails from the integrator's own backend (see [Disabling Docket's Ticket Emails](#disabling-dockets-ticket-emails)); auth emails always send.

---

## Out of Scope (MVP)

- Agent email notifications for events other than customer replies (e.g. new ticket assigned)
- Per-agent notification preferences / digest batching
- Customer email notifications for status changes other than "closed"
- Email unsubscribe / preference management
- HTML email tracking (open/click tracking)
- CC / BCC on tickets
