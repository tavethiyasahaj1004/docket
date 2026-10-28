"use client";

import {
  ArrowsOutSimpleIcon,
  CaretLeftIcon,
  CaretRightIcon,
  DownloadSimpleIcon,
  FileIcon,
  FilePdfIcon,
  FileTextIcon,
  FileZipIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface AttachmentItem {
  /** false hides the delete affordance for this item even when onDelete is
   * passed (e.g. a customer's own attachment — immutable to agents/admins).
   * Defaults to true. */
  canDelete?: boolean;
  filename: string;
  fileSize: number;
  id: string;
  mimeType: string;
  url: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileTypeIcon({ mimeType }: { mimeType: string }) {
  const cls = "size-5 shrink-0 text-base-content-muted";
  if (mimeType === "application/pdf") {
    return <FilePdfIcon className={cls} />;
  }
  if (mimeType === "application/zip") {
    return <FileZipIcon className={cls} />;
  }
  if (mimeType.startsWith("text/")) {
    return <FileTextIcon className={cls} />;
  }
  return <FileIcon className={cls} />;
}

/** Full-screen image viewer. Minimal on purpose — just view, navigate, close. */
function Lightbox({
  images,
  index,
  onClose,
  onIndexChange,
}: {
  images: AttachmentItem[];
  index: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
}) {
  const count = images.length;
  const current = images[index];

  const prev = useCallback(
    () => onIndexChange((index - 1 + count) % count),
    [index, count, onIndexChange]
  );
  const next = useCallback(
    () => onIndexChange((index + 1) % count),
    [index, count, onIndexChange]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowLeft" && count > 1) {
        prev();
      } else if (e.key === "ArrowRight" && count > 1) {
        next();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, prev, next, count]);

  if (!current) {
    return null;
  }

  return createPortal(
    <div
      aria-label={current.filename}
      aria-modal="true"
      className="fixed inset-0 z-100 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      role="dialog"
    >
      {/* Backdrop — clicking anywhere empty closes */}
      <button
        aria-label="Close image viewer"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        type="button"
      />

      {/* Close */}
      <button
        aria-label="Close"
        className="absolute right-4 top-4 z-10 flex size-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        onClick={onClose}
        type="button"
      >
        <XIcon className="size-5" />
      </button>

      {count > 1 && (
        <>
          <button
            aria-label="Previous image"
            className="absolute left-4 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
            onClick={prev}
            type="button"
          >
            <CaretLeftIcon className="size-5" />
          </button>
          <button
            aria-label="Next image"
            className="absolute right-4 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
            onClick={next}
            type="button"
          >
            <CaretRightIcon className="size-5" />
          </button>
        </>
      )}

      {/* biome-ignore lint/performance/noImgElement: storage URLs aren't configured for next/image (must work across local/S3/R2 drivers) */}
      <img
        alt={current.filename}
        className="relative z-10 max-h-[86vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
        src={current.url}
      />

      {/* Caption */}
      <div className="absolute bottom-5 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs text-white/90">
        {current.filename}
        {count > 1 && (
          <span className="ml-2 text-white/60">
            {index + 1} / {count}
          </span>
        )}
      </div>
    </div>,
    document.body
  );
}

/** Renders attachments inline: images as clickable thumbnails opening an in-page
 * lightbox, everything else as a compact file card with type icon and download. */
export function TicketAttachments({
  items,
  className,
  onDelete,
}: {
  items: AttachmentItem[];
  className?: string;
  /** When provided, renders a delete affordance on each attachment (agent/admin only — never pass this on the customer-facing page). */
  onDelete?: (attachmentId: string) => void;
}) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AttachmentItem | null>(null);

  if (items.length === 0) {
    return null;
  }

  const images = items.filter((a) => a.mimeType.startsWith("image/"));
  const files = items.filter((a) => !a.mimeType.startsWith("image/"));

  function confirmDelete() {
    if (deleteTarget) {
      onDelete?.(deleteTarget.id);
      setDeleteTarget(null);
    }
  }

  return (
    <div className={cn("space-y-2", className)}>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((a, i) => (
            <div
              className="group relative size-24 overflow-hidden rounded-lg border border-base-300 bg-base-300"
              key={a.id}
            >
              <button
                className="block size-full"
                onClick={() => setLightboxIndex(i)}
                title={a.filename}
                type="button"
              >
                {/* biome-ignore lint/performance/noImgElement: storage URLs aren't configured for next/image (must work across local/S3/R2 drivers) */}
                <img
                  alt={a.filename}
                  className="size-full object-cover transition-transform duration-200 group-hover:scale-105"
                  loading="lazy"
                  src={a.url}
                />
                <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-all group-hover:bg-black/40 group-hover:opacity-100">
                  <ArrowsOutSimpleIcon
                    className="size-5 text-white"
                    weight="bold"
                  />
                </span>
              </button>
              {onDelete && a.canDelete !== false && (
                <button
                  aria-label={`Delete ${a.filename}`}
                  className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-black/80 group-hover:opacity-100"
                  onClick={() => setDeleteTarget(a)}
                  type="button"
                >
                  <XIcon className="size-3.5" weight="bold" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {files.map((a) => (
        <div
          className="group flex max-w-sm items-center gap-2.5 rounded-lg border border-base-300 bg-base-100 px-3 py-2 transition-colors hover:bg-base-300"
          key={a.id}
        >
          <a
            className="flex min-w-0 flex-1 items-center gap-2.5"
            href={a.url}
            rel="noopener noreferrer"
            target="_blank"
          >
            <FileTypeIcon mimeType={a.mimeType} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-base-content">
                {a.filename}
              </p>
              <p className="text-2xs text-base-content-muted">
                {formatBytes(a.fileSize)}
              </p>
            </div>
            <DownloadSimpleIcon className="size-4 shrink-0 text-base-content-muted group-hover:text-base-content" />
          </a>
          {onDelete && a.canDelete !== false && (
            <button
              aria-label={`Delete ${a.filename}`}
              className="shrink-0 text-base-content-muted transition-colors hover:text-error"
              onClick={() => setDeleteTarget(a)}
              type="button"
            >
              <TrashIcon className="size-4" />
            </button>
          )}
        </div>
      ))}

      {lightboxIndex !== null && (
        <Lightbox
          images={images}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={setLightboxIndex}
        />
      )}

      <Dialog
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        open={deleteTarget !== null}
      >
        <DialogContent>
          <DialogHeader>
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-error/10">
              <WarningCircleIcon className="size-6 text-error" weight="fill" />
            </div>
            <DialogTitle className="text-center">
              Delete attachment?
            </DialogTitle>
            <DialogDescription className="text-center">
              {deleteTarget?.filename} will be permanently removed from this
              ticket. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-row gap-2">
            <Button
              className="flex-1"
              onClick={() => setDeleteTarget(null)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              className="flex-1"
              onClick={confirmDelete}
              variant="destructive"
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
