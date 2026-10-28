import { createId } from "@paralleldrive/cuid2";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { getAttachmentLimits } from "@/lib/settings";
import { storage } from "@/lib/storage";
import {
  checkTicketStorage,
  ticketStorageError,
} from "@/lib/tickets/attachment-limits";
import {
  createTicketFromSubmission,
  validateTicketSubmission,
} from "@/lib/tickets/create-ticket";

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "application/pdf",
  "application/zip",
  "text/plain",
]);

// POST /api/tickets — public (customer ticket submission)
export async function POST(request: NextRequest) {
  const { allowed } = await checkRateLimit({
    action: "ticket_submit",
    key: getClientIp(request),
    limit: 5,
    windowMinutes: 10,
  });
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const subject = String(formData.get("subject") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();
  const attachmentFiles = formData
    .getAll("attachments")
    .filter((v): v is File => v instanceof File && v.size > 0);

  // Validate ticket fields *before* touching storage — files should never
  // be uploaded for a submission that's going to be rejected anyway.
  const validated = await validateTicketSubmission({
    name,
    email,
    subject,
    description,
    category,
  });
  if (!validated.ok) {
    return NextResponse.json(
      { error: validated.error },
      { status: validated.httpStatus }
    );
  }

  // Per-message count + per-file size + the ticket's combined size (a new
  // ticket has no existing attachments, so just this submission's total).
  const limits = await getAttachmentLimits();
  if (attachmentFiles.length > limits.maxPerMessage) {
    return NextResponse.json(
      { error: `Maximum ${limits.maxPerMessage} files allowed.` },
      { status: 400 }
    );
  }
  for (const file of attachmentFiles) {
    if (file.size > limits.maxFileSizeBytes) {
      return NextResponse.json(
        {
          error: `File "${file.name}" exceeds the ${limits.maxFileSizeMb} MB limit.`,
        },
        { status: 400 }
      );
    }
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: `File type "${file.type}" is not allowed.` },
        { status: 400 }
      );
    }
  }
  const incomingBytes = attachmentFiles.reduce((n, f) => n + f.size, 0);
  const storageCheck = checkTicketStorage({
    usedBytes: 0,
    incomingBytes,
    limitBytes: limits.maxPerTicketSizeBytes,
  });
  if (!storageCheck.ok) {
    return NextResponse.json(
      {
        error: ticketStorageError(
          storageCheck,
          incomingBytes,
          limits.maxPerTicketSizeBytes
        ),
      },
      { status: 400 }
    );
  }

  const ticketId = createId();

  // Upload attachments first (createTicketFromSubmission rolls these back
  // if the DB insert that follows fails).
  const uploadedAttachments: Array<{
    id: string;
    filename: string;
    storageKey: string;
    fileSize: number;
    mimeType: string;
  }> = [];

  // Only keys pushed to `uploadedAttachments` by THIS request are ever deleted
  // on failure — never anything already stored for other tickets.
  const removeUploaded = async () => {
    for (const a of uploadedAttachments) {
      await storage.delete(a.storageKey).catch(() => undefined);
    }
  };

  try {
    for (const file of attachmentFiles) {
      const ext = file.name.split(".").pop() ?? "bin";
      const storageKey = `tickets/${ticketId}/${createId()}.${ext}`;
      const buffer = Buffer.from(await file.arrayBuffer());
      await storage.upload(storageKey, buffer, file.type);
      uploadedAttachments.push({
        id: createId(),
        filename: file.name,
        storageKey,
        fileSize: file.size,
        mimeType: file.type,
      });
    }
  } catch (err) {
    console.error("[POST /api/tickets] attachment upload", err);
    await removeUploaded();
    return NextResponse.json(
      { error: "Failed to store attachments." },
      { status: 500 }
    );
  }

  const result = await createTicketFromSubmission({
    id: ticketId,
    name,
    email,
    subject,
    description,
    category,
    source: "portal",
    attachments: uploadedAttachments,
  });

  if (!result.ok) {
    await removeUploaded();
    return NextResponse.json(
      { error: result.error },
      { status: result.httpStatus }
    );
  }

  return NextResponse.json(
    { ticketNumber: result.ticketNumber },
    { status: 201 }
  );
}
