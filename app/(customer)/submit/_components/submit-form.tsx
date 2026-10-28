"use client";

import {
  ArrowLeftIcon,
  LifebuoyIcon,
  LockSimpleIcon,
  PaperclipIcon,
  TicketIcon,
  UploadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { BrandMark } from "@/components/common/brand-mark";
import { RichTextEditor } from "@/components/common/rich-text-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fileKey } from "@/lib/file-keys";
import { richTextToPlainText } from "@/lib/rich-text";
import {
  type AttachmentLimits,
  checkTicketStorage,
  ticketStorageError,
} from "@/lib/tickets/attachment-limits";
import { cn } from "@/lib/utils";

const CATEGORIES = [
  { value: "bug", label: "Bug" },
  { value: "issue", label: "Issue" },
  { value: "feature_request", label: "Feature Request" },
  { value: "billing", label: "Billing" },
  { value: "general_query", label: "General Query" },
] as const;

const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "application/pdf",
  "application/zip",
  "text/plain",
];

interface FormErrors {
  attachments?: string;
  category?: string;
  description?: string;
  email?: string;
  general?: string;
  name?: string;
  subject?: string;
}

// Top-to-bottom field order, used to find + scroll to the first invalid field.
const FIELD_ORDER: (keyof FormErrors)[] = [
  "name",
  "email",
  "subject",
  "category",
  "description",
];

interface Props {
  // Admin-configured attachment caps (Admin → Ticket Config).
  attachmentLimits: Pick<
    AttachmentLimits,
    | "maxFileSizeBytes"
    | "maxFileSizeMb"
    | "maxPerMessage"
    | "maxPerTicketSizeBytes"
  >;
  brandName: string;
  logoUrl: string | null;
}

export function SubmitForm({ attachmentLimits, brandName, logoUrl }: Props) {
  const MAX_FILES = attachmentLimits.maxPerMessage;
  const MAX_FILE_SIZE = attachmentLimits.maxFileSizeBytes;
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const nameFieldRef = useRef<HTMLDivElement>(null);
  const emailFieldRef = useRef<HTMLDivElement>(null);
  const subjectFieldRef = useRef<HTMLDivElement>(null);
  const categoryFieldRef = useRef<HTMLDivElement>(null);
  const descriptionFieldRef = useRef<HTMLDivElement>(null);

  const fieldRefs: Partial<
    Record<keyof FormErrors, React.RefObject<HTMLDivElement | null>>
  > = {
    name: nameFieldRef,
    email: emailFieldRef,
    subject: subjectFieldRef,
    category: categoryFieldRef,
    description: descriptionFieldRef,
  };

  function validate(): FormErrors {
    const e: FormErrors = {};
    if (!name.trim() || name.trim().length < 2 || name.trim().length > 100) {
      e.name = "Name must be 2–100 characters.";
    }
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      e.email = "Please enter a valid email address.";
    }
    if (
      !subject.trim() ||
      subject.trim().length < 5 ||
      subject.trim().length > 200
    ) {
      e.subject = "Subject must be 5–200 characters.";
    }
    const descriptionText = richTextToPlainText(description).trim();
    if (
      !descriptionText ||
      descriptionText.length < 10 ||
      descriptionText.length > 5000
    ) {
      e.description = "Description must be 10–5000 characters.";
    }
    if (!category) {
      e.category = "Please select a category.";
    }
    return e;
  }

  function clearError(field: keyof FormErrors) {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  }

  function addFiles(newFiles: File[]) {
    const combined = [...files, ...newFiles];

    if (combined.length > MAX_FILES) {
      setErrors((prev) => ({
        ...prev,
        attachments: `Maximum ${MAX_FILES} files allowed.`,
      }));
      return;
    }
    const oversized = combined.find((f) => f.size > MAX_FILE_SIZE);
    if (oversized) {
      setErrors((prev) => ({
        ...prev,
        attachments: `${oversized.name} exceeds ${attachmentLimits.maxFileSizeMb} MB.`,
      }));
      return;
    }
    const badType = combined.find((f) => !ALLOWED_TYPES.includes(f.type));
    if (badType) {
      setErrors((prev) => ({
        ...prev,
        attachments: `${badType.name} is not an allowed file type.`,
      }));
      return;
    }
    // A new ticket has no existing attachments: just this submission's total.
    const incomingBytes = combined.reduce((n, f) => n + f.size, 0);
    const storage = checkTicketStorage({
      usedBytes: 0,
      incomingBytes,
      limitBytes: attachmentLimits.maxPerTicketSizeBytes,
    });
    if (!storage.ok) {
      setErrors((prev) => ({
        ...prev,
        attachments: ticketStorageError(
          storage,
          incomingBytes,
          attachmentLimits.maxPerTicketSizeBytes
        ),
      }));
      return;
    }
    setFiles(combined);
    setErrors((prev) => ({ ...prev, attachments: undefined }));
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? []);
    e.target.value = "";
    addFiles(selected);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setErrors((prev) => ({ ...prev, attachments: undefined }));
  }

  function handleDrop(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setIsDragOver(false);
    addFiles(Array.from(e.dataTransfer.files));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      const firstInvalidField = FIELD_ORDER.find((f) => validationErrors[f]);
      const fieldRef = firstInvalidField
        ? fieldRefs[firstInvalidField]
        : undefined;
      // Defer to the next paint so the just-set error text has already
      // shifted layout — scrolling now would center against stale layout.
      requestAnimationFrame(() => {
        const container = fieldRef?.current;
        container?.scrollIntoView({ behavior: "smooth", block: "center" });
        // preventScroll: the browser's native focus-scroll is instant and
        // would otherwise fight/override the smooth scroll above.
        container
          ?.querySelector<HTMLElement>(
            'input, textarea, [contenteditable="true"], button'
          )
          ?.focus({ preventScroll: true });
      });
      return;
    }
    setErrors({});
    setSubmitting(true);

    try {
      const body = new FormData();
      body.append("name", name.trim());
      body.append("email", email.trim());
      body.append("subject", subject.trim());
      body.append("description", description);
      body.append("category", category);
      for (const f of files) {
        body.append("attachments", f);
      }

      const res = await fetch("/api/tickets", { method: "POST", body });
      const data = (await res.json()) as {
        ticketNumber?: number;
        error?: string;
      };

      if (!res.ok) {
        setErrors({
          general: data.error ?? "Something went wrong. Please try again.",
        });
        return;
      }

      router.push(
        `/submit/success?ticket=${data.ticketNumber}&email=${encodeURIComponent(email.trim())}`
      );
    } catch {
      setErrors({ general: "Network error. Please try again." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-public flex flex-col">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b border-sand sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <Link className="flex items-center gap-2 sm:gap-2.5 min-w-0" href="/">
            <BrandMark
              fallbackIcon={
                <div className="size-7 rounded-md bg-bark flex items-center justify-center shrink-0">
                  <TicketIcon className="size-4 text-cream" weight="fill" />
                </div>
              }
              imgClassName="h-7 w-auto max-w-40 object-contain"
              logoUrl={logoUrl}
              name={brandName}
              textClassName="font-semibold text-bark text-sm truncate"
            />
          </Link>
          <Link
            className="text-sm text-stone hover:text-bark transition-colors shrink-0"
            href="/my-tickets"
          >
            My Tickets
          </Link>
        </div>
      </header>

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        {/* Back link */}
        <Link
          className="inline-flex items-center gap-1.5 text-sm text-stone hover:text-bark transition-colors mb-6"
          href="/"
        >
          <ArrowLeftIcon className="size-3.5" />
          Back to home
        </Link>

        {/* Intro */}
        <div className="flex items-start gap-3.5 mb-8">
          <div className="size-11 rounded-xl bg-cream flex items-center justify-center shrink-0">
            <LifebuoyIcon className="size-5 text-bark" weight="duotone" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-bark leading-tight">
              Submit a support ticket
            </h1>
            <p className="text-sm text-stone mt-1">
              Describe your issue and we&apos;ll get back to you as soon as
              possible.
            </p>
          </div>
        </div>

        <form noValidate onSubmit={handleSubmit}>
          <div className="bg-white rounded-xl border border-sand shadow-soft shadow-sm p-6 sm:p-8 space-y-5">
            {/* Name + Email */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5" ref={nameFieldRef}>
                <Label className="text-bark text-sm font-medium" htmlFor="name">
                  Full Name <span className="text-red-600">*</span>
                </Label>
                <Input
                  className=""
                  disabled={submitting}
                  id="name"
                  onChange={(e) => {
                    setName(e.target.value);
                    clearError("name");
                  }}
                  placeholder="Jane Smith"
                  value={name}
                />
                {errors.name && (
                  <p className="text-xs text-red-600">{errors.name}</p>
                )}
              </div>

              <div className="space-y-1.5" ref={emailFieldRef}>
                <Label
                  className="text-bark text-sm font-medium"
                  htmlFor="email"
                >
                  Email Address <span className="text-red-600">*</span>
                </Label>
                <Input
                  className=""
                  disabled={submitting}
                  id="email"
                  onChange={(e) => {
                    setEmail(e.target.value);
                    clearError("email");
                  }}
                  placeholder="jane@example.com"
                  type="email"
                  value={email}
                />
                {errors.email && (
                  <p className="text-xs text-red-600">{errors.email}</p>
                )}
              </div>
            </div>

            {/* Subject */}
            <div className="space-y-1.5" ref={subjectFieldRef}>
              <Label
                className="text-bark text-sm font-medium"
                htmlFor="subject"
              >
                Subject <span className="text-red-600">*</span>
              </Label>
              <Input
                className=""
                disabled={submitting}
                id="subject"
                maxLength={200}
                onChange={(e) => {
                  setSubject(e.target.value);
                  clearError("subject");
                }}
                placeholder="Brief summary of your issue"
                value={subject}
              />
              <div className="flex justify-between">
                {errors.subject ? (
                  <p className="text-xs text-red-600">{errors.subject}</p>
                ) : (
                  <span />
                )}
                <span className="text-xs text-stone">{subject.length}/200</span>
              </div>
            </div>

            {/* Category */}
            <div className="space-y-1.5" ref={categoryFieldRef}>
              <Label className="text-bark text-sm font-medium">
                Category <span className="text-red-600">*</span>
              </Label>
              <Select
                disabled={submitting}
                onValueChange={(v) => {
                  setCategory(v);
                  clearError("category");
                }}
                value={category}
              >
                <SelectTrigger className="h-11 w-full">
                  <SelectValue placeholder="Select a category" />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.category && (
                <p className="text-xs text-red-600">{errors.category}</p>
              )}
            </div>

            {/* Description */}
            <div className="space-y-1.5" ref={descriptionFieldRef}>
              <Label className="text-bark text-sm font-medium">
                Description <span className="text-red-600">*</span>
              </Label>
              <RichTextEditor
                disabled={submitting}
                onChange={(json) => {
                  setDescription(json);
                  clearError("description");
                }}
                placeholder="Please describe your issue in detail…"
                value={description}
              />
              <div className="flex justify-between">
                {errors.description ? (
                  <p className="text-xs text-red-600">{errors.description}</p>
                ) : (
                  <span />
                )}
                <span className="text-xs text-stone">
                  {richTextToPlainText(description).length}/5000
                </span>
              </div>
            </div>

            {/* Attachments */}
            <div className="space-y-2">
              <Label className="text-bark text-sm font-medium">
                Attachments{" "}
                <span className="text-stone font-normal">(optional)</span>
              </Label>

              {files.length > 0 && (
                <ul className="space-y-1">
                  {files.map((f, i) => (
                    <li
                      className="flex items-center gap-2 rounded-md bg-cream border border-sand px-3 py-2 text-sm"
                      key={fileKey(f)}
                    >
                      <PaperclipIcon className="size-3.5 text-stone shrink-0" />
                      <span className="text-bark truncate flex-1">
                        {f.name}
                      </span>
                      <span className="text-stone shrink-0">
                        {(f.size / 1024).toFixed(0)} KB
                      </span>
                      <button
                        className="text-stone hover:text-bark ml-1"
                        onClick={() => removeFile(i)}
                        type="button"
                      >
                        <XIcon className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {files.length < MAX_FILES ? (
                // biome-ignore lint/a11y/noNoninteractiveElementInteractions: label is a native file-picker trigger (wraps the hidden input) with added drag-and-drop
                <label
                  className={cn(
                    "flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors",
                    submitting
                      ? "cursor-not-allowed opacity-60"
                      : "cursor-pointer",
                    isDragOver
                      ? "border-bark bg-cream/60"
                      : "border-sand hover:border-stone hover:bg-cream/30"
                  )}
                  onDragLeave={() => setIsDragOver(false)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (!submitting) {
                      setIsDragOver(true);
                    }
                  }}
                  onDrop={handleDrop}
                >
                  <UploadSimpleIcon className="size-5 text-stone" />
                  <p className="text-sm text-bark">
                    <span className="font-medium underline underline-offset-2">
                      Click to upload
                    </span>{" "}
                    or drag and drop
                  </p>
                  <p className="text-xs text-stone">
                    JPG, PNG, PDF, ZIP, TXT — max{" "}
                    {attachmentLimits.maxFileSizeMb} MB each, up to {MAX_FILES}{" "}
                    files
                  </p>
                  <input
                    accept=".jpg,.jpeg,.png,.pdf,.zip,.txt"
                    className="sr-only"
                    disabled={submitting}
                    multiple
                    onChange={handleFileChange}
                    type="file"
                  />
                </label>
              ) : (
                <p className="text-xs text-stone">
                  Attachment limit reached ({MAX_FILES}/{MAX_FILES}).
                </p>
              )}
              {errors.attachments && (
                <p className="text-xs text-red-600">{errors.attachments}</p>
              )}
            </div>
          </div>

          {errors.general && (
            <p className="mt-4 text-sm text-red-600 text-center">
              {errors.general}
            </p>
          )}

          <div className="mt-6 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-4">
            <p className="flex items-center gap-1.5 text-xs text-stone">
              <LockSimpleIcon className="size-3.5 shrink-0" />
              Your details are kept private and only used to respond to your
              ticket.
            </p>
            <Button
              className="bg-bark hover:bg-bark/90 text-white rounded-md w-full sm:w-auto sm:min-w-40"
              disabled={submitting}
              type="submit"
            >
              {submitting ? "Submitting…" : "Submit Ticket"}
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}
