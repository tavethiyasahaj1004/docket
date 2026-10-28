// Attachment caps. Pure and client-safe (no server imports) so forms, routes
// and the admin form share one definition. Effective values come from the
// platform_settings row via getAttachmentLimits() in lib/settings.ts; the
// defaults below are only the fallback for missing/invalid values.
//
// Docket limits files per message, size per file, and the COMBINED size of all
// attachments on a ticket. There is deliberately NO cap on attachment COUNT per
// ticket: long-running conversations legitimately collect many files.
// (platform_settings.attachment_max_per_ticket is a leftover, unused column
// kept so no destructive migration is needed.)

export interface AttachmentLimits {
  maxFileSizeBytes: number;
  maxFileSizeMb: number;
  /** Max files in one submission or reply. */
  maxPerMessage: number;
  /** Max combined size of every attachment on one ticket. */
  maxPerTicketSizeBytes: number;
  maxPerTicketSizeMb: number;
}

export const DEFAULT_ATTACHMENT_LIMITS = {
  maxPerMessage: 5,
  maxFileSizeMb: 10,
  maxPerTicketSizeMb: 250,
} as const;

/** Inclusive bounds the admin form/API accept. */
export const ATTACHMENT_LIMIT_BOUNDS = {
  maxPerMessage: { min: 1, max: 20 },
  maxFileSizeMb: { min: 1, max: 100 },
  maxPerTicketSizeMb: { min: 1, max: 10_000 },
} as const;

export type AttachmentLimitField = keyof typeof ATTACHMENT_LIMIT_BOUNDS;

export const ATTACHMENT_LIMIT_LABELS: Record<AttachmentLimitField, string> = {
  maxPerMessage: "Maximum attachments per message",
  maxFileSizeMb: "Maximum file size per attachment",
  maxPerTicketSizeMb: "Maximum attachment storage per ticket (MB)",
};

export function mbToBytes(mb: number): number {
  return mb * 1024 * 1024;
}

function isValidField(field: AttachmentLimitField, value: unknown): boolean {
  const { min, max } = ATTACHMENT_LIMIT_BOUNDS[field];
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** Validates persisted values, falling back to the default per field when one
 * is missing, non-integer or out of bounds. */
export function resolveAttachmentLimits(
  raw:
    | {
        attachmentMaxPerMessage?: unknown;
        attachmentMaxFileSizeMb?: unknown;
        attachmentMaxPerTicketSizeMb?: unknown;
      }
    | null
    | undefined
): AttachmentLimits {
  const maxPerMessage = isValidField(
    "maxPerMessage",
    raw?.attachmentMaxPerMessage
  )
    ? (raw?.attachmentMaxPerMessage as number)
    : DEFAULT_ATTACHMENT_LIMITS.maxPerMessage;
  const maxFileSizeMb = isValidField(
    "maxFileSizeMb",
    raw?.attachmentMaxFileSizeMb
  )
    ? (raw?.attachmentMaxFileSizeMb as number)
    : DEFAULT_ATTACHMENT_LIMITS.maxFileSizeMb;
  const maxPerTicketSizeMb = isValidField(
    "maxPerTicketSizeMb",
    raw?.attachmentMaxPerTicketSizeMb
  )
    ? (raw?.attachmentMaxPerTicketSizeMb as number)
    : DEFAULT_ATTACHMENT_LIMITS.maxPerTicketSizeMb;
  return {
    maxPerMessage,
    maxFileSizeMb,
    maxFileSizeBytes: mbToBytes(maxFileSizeMb),
    maxPerTicketSizeMb,
    maxPerTicketSizeBytes: mbToBytes(maxPerTicketSizeMb),
  };
}

export type AttachmentLimitInput = Record<AttachmentLimitField, unknown>;

/** Per-field validation for the admin form/API. Returns an error per invalid
 * field (empty object = valid). Strict: integers only, within bounds. */
export function validateAttachmentLimitInput(
  input: Partial<AttachmentLimitInput>
): Partial<Record<AttachmentLimitField, string>> {
  const errors: Partial<Record<AttachmentLimitField, string>> = {};
  for (const field of Object.keys(
    ATTACHMENT_LIMIT_BOUNDS
  ) as AttachmentLimitField[]) {
    const value = input[field];
    const { min, max } = ATTACHMENT_LIMIT_BOUNDS[field];
    if (typeof value !== "number" || Number.isNaN(value)) {
      errors[field] = "Enter a whole number.";
    } else if (!Number.isInteger(value)) {
      errors[field] = "Must be a whole number.";
    } else if (value < min || value > max) {
      errors[field] = `Must be between ${min} and ${max}.`;
    }
  }
  // A ticket must be able to hold at least one maximum-size file.
  if (
    !(errors.maxFileSizeMb || errors.maxPerTicketSizeMb) &&
    (input.maxPerTicketSizeMb as number) < (input.maxFileSizeMb as number)
  ) {
    errors.maxPerTicketSizeMb =
      "Cannot be smaller than the maximum file size per attachment.";
  }
  return errors;
}

export type TicketStorageCheck =
  | { ok: true }
  | {
      ok: false;
      /** "full": ticket is already at/over its limit. "exceeds": this message doesn't fit. */
      reason: "exceeds" | "full";
      remainingBytes: number;
    };

/** Combined-size check: `used + incoming <= limit`. Exactly reaching the limit
 * is allowed; one byte over is not. A ticket already at or over the limit
 * (e.g. after a merge) is "full" and takes no new attachments, but nothing
 * existing is touched. Pure — callers supply usage from the DB. */
export function checkTicketStorage(input: {
  incomingBytes: number;
  limitBytes: number;
  usedBytes: number;
}): TicketStorageCheck {
  const remainingBytes = Math.max(0, input.limitBytes - input.usedBytes);
  if (input.incomingBytes <= 0) {
    return { ok: true };
  }
  if (remainingBytes === 0) {
    return { ok: false, reason: "full", remainingBytes };
  }
  if (input.incomingBytes > remainingBytes) {
    return { ok: false, reason: "exceeds", remainingBytes };
  }
  return { ok: true };
}

const formatMb = (bytes: number) =>
  `${(Math.round((bytes / (1024 * 1024)) * 100) / 100).toString()} MB`;

/** User-facing message for a failed storage check. */
export function ticketStorageError(
  check: Extract<TicketStorageCheck, { ok: false }>,
  incomingBytes: number,
  limitBytes: number
): string {
  if (check.reason === "full") {
    return "This ticket has reached its attachment storage limit. Remove existing attachments if permitted, or contact an administrator.";
  }
  return `The combined size of these attachments (${formatMb(incomingBytes)}) exceeds this ticket's remaining attachment storage (${formatMb(check.remainingBytes)} of ${formatMb(limitBytes)}).`;
}
