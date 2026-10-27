import { richTextToPlainText } from "@/lib/rich-text";

// Allowlist DTOs for the read tools. Every field is copied by name from a
// narrow input type; a database row is never spread into tool output.

export const MCP_BODY_CHARS = { min: 200, max: 10_000, default: 2000 } as const;

/** Longest attachment list kept when a result has to shrink. */
const SHRUNK_ATTACHMENTS = 20;

export type BodyDto = {
  body: string;
  truncated: boolean;
  /** Length of the full plain-text body, in characters. */
  fullLength: number;
};

/** Flattens stored rich text (Tiptap JSON or legacy plain text) to plain text
 * and cuts it to `maxChars`. Raw Tiptap JSON is never returned. */
export function toBodyDto(stored: string, maxChars: number): BodyDto {
  const text = richTextToPlainText(stored);
  if (text.length <= maxChars) {
    return { body: text, truncated: false, fullLength: text.length };
  }
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  // Never cut between the halves of a surrogate pair.
  if (last >= 0xd8_00 && last <= 0xdb_ff) {
    end -= 1;
  }
  return {
    body: text.slice(0, end),
    truncated: true,
    fullLength: text.length,
  };
}

export type ConfigLabels = {
  statuses: Map<string, { label: string; isClosed: boolean }>;
  priorities: Map<string, string>;
  categories: Map<string, string>;
};

export function buildConfigLabels(config: {
  statuses: { slug: string; label: string; isClosedState: boolean }[];
  priorities: { slug: string; label: string }[];
  categories: { slug: string; label: string }[];
}): ConfigLabels {
  return {
    statuses: new Map(
      config.statuses.map((s) => [
        s.slug,
        { label: s.label, isClosed: s.isClosedState },
      ])
    ),
    priorities: new Map(config.priorities.map((p) => [p.slug, p.label])),
    categories: new Map(config.categories.map((c) => [c.slug, c.label])),
  };
}

export const toStatusDto = (labels: ConfigLabels, slug: string) => ({
  slug,
  label: labels.statuses.get(slug)?.label ?? slug,
  isClosed: labels.statuses.get(slug)?.isClosed ?? false,
});
export type StatusDto = ReturnType<typeof toStatusDto>;

export const toPriorityDto = (labels: ConfigLabels, slug: string) => ({
  slug,
  label: labels.priorities.get(slug) ?? slug,
});

export const toCategoryDto = (labels: ConfigLabels, slug: string) => ({
  slug,
  label: labels.categories.get(slug) ?? slug,
});

/** Where an agent opens a ticket. It needs an agent login, so it is safe to
 * hand out. */
export function agentTicketUrl(appUrl: string, ticketNumber: number): string {
  return `${appUrl.replace(/\/+$/, "")}/tickets/${ticketNumber}`;
}

export type TicketSummarySource = {
  assignedAgentId: string | null;
  assigneeName: string | null;
  awaitingReply: boolean;
  category: string;
  closedAt: Date | null;
  createdAt: Date;
  customerId: string;
  customerName: string;
  id: string;
  pendingReplies: number;
  priority: string;
  status: string;
  subject: string;
  tags: string[];
  ticketNumber: number;
  updatedAt: Date;
};

/** A ticket as list results show it: no body and no customer email (R5). */
export function toTicketSummaryDto(
  src: TicketSummarySource,
  labels: ConfigLabels,
  appUrl: string
) {
  return {
    id: src.id,
    number: src.ticketNumber,
    subject: src.subject,
    status: toStatusDto(labels, src.status),
    priority: toPriorityDto(labels, src.priority),
    category: toCategoryDto(labels, src.category),
    customer: { id: src.customerId, name: src.customerName },
    assignee:
      src.assignedAgentId && src.assigneeName !== null
        ? { id: src.assignedAgentId, name: src.assigneeName }
        : null,
    awaitingReply: src.awaitingReply,
    pendingReplies: src.pendingReplies,
    tags: [...src.tags],
    createdAt: src.createdAt.toISOString(),
    updatedAt: src.updatedAt.toISOString(),
    closedAt: src.closedAt ? src.closedAt.toISOString() : null,
    agentUrl: agentTicketUrl(appUrl, src.ticketNumber),
  };
}
export type TicketSummaryDto = ReturnType<typeof toTicketSummaryDto>;

export type AttachmentSource = {
  createdAt: Date;
  fileSize: number;
  filename: string;
  id: string;
  mimeType: string;
};

/** Attachment metadata only: never bytes, a storage key or any URL. */
export function toAttachmentDto(a: AttachmentSource) {
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    fileSize: a.fileSize,
    createdAt: a.createdAt.toISOString(),
  };
}
export type AttachmentDto = ReturnType<typeof toAttachmentDto>;

export function shrinkAttachments<T>(attachments: T[]): T[] {
  return attachments.slice(0, SHRUNK_ATTACHMENTS);
}

// Which metadata keys each activity action may expose. Everything else (and
// every action not listed) is dropped, so a future writer adding an email, a
// token, a body or a URL to its metadata cannot leak it through this tool.
const FROM_TO = ["from", "to"] as const;
const LINK_KEYS = ["type", "direction", "ticketNumber"] as const;
export const ACTIVITY_METADATA_ALLOWLIST: Readonly<
  Record<string, readonly string[]>
> = {
  status_changed: FROM_TO,
  ticket_closed: FROM_TO,
  ticket_reopened: FROM_TO,
  category_changed: FROM_TO,
  priority_changed: FROM_TO,
  assigned: ["agentId"],
  tag_added: ["tag"],
  tag_removed: ["tag"],
  custom_field_changed: ["field"],
  attachment_deleted: ["filename"],
  merged_into: ["ticketNumber"],
  merged_from: ["ticketNumber"],
  split_to: ["ticketNumber"],
  split_from: ["ticketNumber"],
  ticket_linked: LINK_KEYS,
  ticket_unlinked: LINK_KEYS,
};

const MAX_METADATA_VALUE_CHARS = 200;

export function toActivityMetadata(
  action: string,
  metadata: unknown
): Record<string, string | number | boolean> | null {
  const allowed = Object.hasOwn(ACTIVITY_METADATA_ALLOWLIST, action)
    ? ACTIVITY_METADATA_ALLOWLIST[action]
    : undefined;
  if (!allowed || metadata === null || typeof metadata !== "object") {
    return null;
  }
  const source = metadata as Record<string, unknown>;
  const out: Record<string, string | number | boolean> = {};
  for (const key of allowed) {
    const value = source[key];
    if (typeof value === "string") {
      out[key] = value.slice(0, MAX_METADATA_VALUE_CHARS);
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export type CommentSource = {
  authorName: string;
  authorRole: string;
  content: string;
  createdAt: Date;
  id: string;
  isInternal: boolean;
};

export function toMessageItemDto(
  c: CommentSource,
  attachments: AttachmentSource[],
  maxBodyChars: number
) {
  return {
    kind: "message" as const,
    id: c.id,
    visibility: c.isInternal ? ("internal" as const) : ("public" as const),
    authorRole: c.authorRole,
    authorName: c.authorName,
    ...toBodyDto(c.content, maxBodyChars),
    createdAt: c.createdAt.toISOString(),
    attachments: attachments.map(toAttachmentDto),
  };
}
export type MessageItemDto = ReturnType<typeof toMessageItemDto>;

export type ActivitySource = {
  action: string;
  actorName: string;
  createdAt: Date;
  id: string;
  metadata: unknown;
};

export function toActivityItemDto(a: ActivitySource) {
  return {
    kind: "activity" as const,
    id: a.id,
    action: a.action,
    actorName: a.actorName,
    metadata: toActivityMetadata(a.action, a.metadata),
    createdAt: a.createdAt.toISOString(),
  };
}
export type ActivityItemDto = ReturnType<typeof toActivityItemDto>;
