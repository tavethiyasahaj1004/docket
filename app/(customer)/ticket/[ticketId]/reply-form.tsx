"use client";

import { PaperclipIcon, XIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  RichTextEditor,
  type RichTextEditorHandle,
} from "@/components/common/rich-text-editor";
import { Button } from "@/components/ui/button";
import { fileKey } from "@/lib/file-keys";
import { isRichTextEmpty } from "@/lib/rich-text";
import {
  type AttachmentLimits,
  checkTicketStorage,
  ticketStorageError,
} from "@/lib/tickets/attachment-limits";

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "application/pdf",
  "application/zip",
  "text/plain",
]);
interface Props {
  // Admin-configured caps (Admin → Ticket Config).
  attachmentLimits: AttachmentLimits;
  ticketId: string;
  // Combined size of every attachment already on the ticket.
  ticketStorageUsedBytes: number;
  token: string;
}

export function ReplyForm({
  attachmentLimits,
  ticketId,
  token,
  ticketStorageUsedBytes,
}: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const editorRef = useRef<RichTextEditorHandle>(null);

  const [content, setContent] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Per-message cap only — no ticket-wide attachment limit.
  const maxFiles = attachmentLimits.maxPerMessage;
  // Ticket already at/over its combined-size limit: attaching is disabled
  // (the server enforces this regardless).
  const storageFull =
    ticketStorageUsedBytes >= attachmentLimits.maxPerTicketSizeBytes;

  function addFiles(newFiles: File[]) {
    const combined = [...files, ...newFiles];
    if (combined.length > maxFiles) {
      setError(`You can attach up to ${maxFiles} file(s) per reply.`);
      return;
    }
    const oversized = combined.find(
      (f) => f.size > attachmentLimits.maxFileSizeBytes
    );
    if (oversized) {
      setError(
        `"${oversized.name}" exceeds the ${attachmentLimits.maxFileSizeMb} MB limit.`
      );
      return;
    }
    const badType = combined.find((f) => !ALLOWED_TYPES.has(f.type));
    if (badType) {
      setError(`"${badType.name}" is not an allowed file type.`);
      return;
    }
    const incomingBytes = combined.reduce((n, f) => n + f.size, 0);
    const storage = checkTicketStorage({
      usedBytes: ticketStorageUsedBytes,
      incomingBytes,
      limitBytes: attachmentLimits.maxPerTicketSizeBytes,
    });
    if (!storage.ok) {
      setError(
        ticketStorageError(
          storage,
          incomingBytes,
          attachmentLimits.maxPerTicketSizeBytes
        )
      );
      return;
    }
    setFiles(combined);
    setError(null);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? []);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    addFiles(selected);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setError(null);
  }

  function handleEnterSubmit() {
    if (!submitting) {
      formRef.current?.requestSubmit();
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isRichTextEmpty(content)) {
      setError("Please write a reply before sending.");
      return;
    }
    setError(null);
    setSubmitting(true);

    try {
      const body = new FormData();
      body.append("content", content);
      body.append("token", token);
      for (const f of files) {
        body.append("attachments", f);
      }

      const res = await fetch(`/api/tickets/${ticketId}/comments`, {
        method: "POST",
        body,
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        const msg = data.error ?? "Failed to send reply.";
        setError(msg);
        toast.error(msg);
        return;
      }

      setContent("");
      setFiles([]);
      editorRef.current?.focus();
      toast.success("Reply sent.");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
      toast.error("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="bg-white rounded-xl border border-sand shadow-soft p-6 space-y-4"
      onSubmit={handleSubmit}
      ref={formRef}
    >
      <h2 className="text-sm font-medium text-bark">Send a Reply</h2>

      <RichTextEditor
        disabled={submitting}
        onChange={setContent}
        onFilesDropped={storageFull ? undefined : addFiles}
        onSubmit={handleEnterSubmit}
        placeholder="Write your reply…"
        ref={editorRef}
        value={content}
      />

      {/* File attachments */}
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((f, i) => (
            <li
              className="flex items-center gap-2 rounded-md bg-cream border border-sand px-3 py-2 text-xs"
              key={fileKey(f)}
            >
              <PaperclipIcon className="size-3.5 text-stone shrink-0" />
              <span className="text-bark truncate flex-1">{f.name}</span>
              <span className="text-stone shrink-0">
                {(f.size / 1024).toFixed(0)} KB
              </span>
              <button
                className="text-stone hover:text-bark"
                onClick={() => removeFile(i)}
                type="button"
              >
                <XIcon className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex items-center justify-between gap-3">
        {storageFull ? (
          <span className="text-xs text-stone">
            Ticket attachment storage limit reached
          </span>
        ) : (
          <label className="flex items-center gap-1.5 text-xs text-stone hover:text-bark cursor-pointer">
            <PaperclipIcon className="size-3.5" />
            Attach file
            <span className="text-stone/80">
              (up to {maxFiles}, {attachmentLimits.maxFileSizeMb} MB each)
            </span>
            <input
              accept=".jpg,.jpeg,.png,.pdf,.zip,.txt"
              className="hidden"
              disabled={submitting}
              multiple
              onChange={handleFileChange}
              ref={fileInputRef}
              type="file"
            />
          </label>
        )}

        <Button
          className="bg-bark hover:bg-bark/90 text-white"
          disabled={submitting || isRichTextEmpty(content)}
          type="submit"
        >
          {submitting ? "Sending…" : "Send Reply"}
        </Button>
      </div>
    </form>
  );
}
