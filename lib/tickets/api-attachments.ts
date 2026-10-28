import { createId } from "@paralleldrive/cuid2";
import { storage } from "@/lib/storage";

const bytesToMbLabel = (bytes: number) => `${bytes / (1024 * 1024)} MB`;

// Attachment rules for the public API, kept identical to the customer portal's
// own limits so a ticket created or replied to through the API can never hold a
// file the portal would have rejected.
export const API_ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "application/pdf",
  "application/zip",
  "text/plain",
]);

/** Whether the public API may serve an attachment: the ticket's own
 * (description) files and those on public replies, the same set `GET
 * /tickets/:id` and `GET /tickets/:id/comments` list. Keyed on the attachment's
 * comment, so it holds wherever merge or split moves the file. A comment id
 * whose comment wasn't found counts as hidden. */
export function isApiVisibleAttachment(attachment: {
  commentId: string | null;
  commentIsInternal: boolean | null;
}): boolean {
  if (attachment.commentId === null) {
    return true;
  }
  return attachment.commentIsInternal === false;
}

// Attachments arrive over JSON as base64 (the integrator's server already
// holds the bytes and posts JSON, not multipart) — see docs/api.md.
export interface Base64AttachmentInput {
  data?: string;
  filename?: string;
  mimeType?: string;
}

export interface DecodedAttachment {
  buffer: Buffer;
  filename: string;
  fileSize: number;
  mimeType: string;
}

export type DecodeResult =
  | { ok: true; attachments: DecodedAttachment[] }
  | { ok: false; error: string };

/** Validate and decode a base64 attachment array from a JSON body.
 * `remainingSlots` is how many more files this message may add (see
 * remainingAttachmentSlots) and `maxFileBytes` the per-file size cap, both from
 * the admin-configured limits. Pure, so callers can validate before touching
 * storage. */
export function decodeBase64Attachments(
  raw: unknown,
  maxFiles: number,
  maxFileBytes: number
): DecodeResult {
  if (raw === undefined || raw === null) {
    return { ok: true, attachments: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: "attachments must be an array." };
  }
  if (raw.length === 0) {
    return { ok: true, attachments: [] };
  }
  if (raw.length > maxFiles) {
    return {
      ok: false,
      error: `You can attach up to ${maxFiles} file(s) per message.`,
    };
  }

  const attachments: DecodedAttachment[] = [];
  for (const item of raw as Base64AttachmentInput[]) {
    const filename = String(item?.filename ?? "").trim();
    const mimeType = String(item?.mimeType ?? "").trim();
    const data = String(item?.data ?? "");

    if (!filename) {
      return { ok: false, error: "Each attachment needs a filename." };
    }
    if (!API_ALLOWED_MIME_TYPES.has(mimeType)) {
      return {
        ok: false,
        error: `File type "${mimeType || "unknown"}" is not allowed.`,
      };
    }
    if (!data) {
      return { ok: false, error: `"${filename}" has no data.` };
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(data, "base64");
    } catch {
      return { ok: false, error: `"${filename}" is not valid base64.` };
    }
    if (buffer.length === 0) {
      return { ok: false, error: `"${filename}" is empty.` };
    }
    if (buffer.length > maxFileBytes) {
      return {
        ok: false,
        error: `"${filename}" exceeds the ${bytesToMbLabel(maxFileBytes)} limit.`,
      };
    }

    attachments.push({
      filename,
      buffer,
      fileSize: buffer.length,
      mimeType,
    });
  }

  return { ok: true, attachments };
}

export interface UploadedAttachment {
  filename: string;
  fileSize: number;
  id: string;
  mimeType: string;
  storageKey: string;
}

/** Uploads decoded attachments under this ticket's prefix and returns DB-ready
 * rows in the portal's `tickets/{id}/{cuid}.{ext}` layout. Any failure rolls back
 * what was already uploaded and rethrows; callers write to the DB afterwards. */
export async function uploadDecodedAttachments(
  ticketId: string,
  attachments: DecodedAttachment[]
): Promise<UploadedAttachment[]> {
  const uploaded: UploadedAttachment[] = [];
  try {
    for (const a of attachments) {
      const ext = a.filename.split(".").pop() ?? "bin";
      const storageKey = `tickets/${ticketId}/${createId()}.${ext}`;
      await storage.upload(storageKey, a.buffer, a.mimeType);
      uploaded.push({
        id: createId(),
        filename: a.filename,
        storageKey,
        fileSize: a.fileSize,
        mimeType: a.mimeType,
      });
    }
  } catch (err) {
    for (const u of uploaded) {
      await storage.delete(u.storageKey).catch(() => undefined);
    }
    throw err;
  }
  return uploaded;
}
