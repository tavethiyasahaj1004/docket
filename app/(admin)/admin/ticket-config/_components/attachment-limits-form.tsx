"use client";

import { PaperclipIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ATTACHMENT_LIMIT_BOUNDS,
  ATTACHMENT_LIMIT_LABELS,
  type AttachmentLimitField,
  type AttachmentLimits,
  validateAttachmentLimitInput,
} from "@/lib/tickets/attachment-limits";

interface Props {
  initialLimits: AttachmentLimits;
}

const FIELDS: Array<{
  description: string;
  field: AttachmentLimitField;
}> = [
  {
    field: "maxPerMessage",
    description: "Files allowed in one submission or reply.",
  },
  {
    field: "maxFileSizeMb",
    description:
      "Largest single file accepted. Types: JPG, PNG, PDF, ZIP, TXT.",
  },
  {
    field: "maxPerTicketSizeMb",
    description:
      "Combined size of all attachments across the ticket's messages and replies. The number of files is not limited.",
  },
];

type Values = Record<AttachmentLimitField, string>;

const toValues = (limits: AttachmentLimits): Values => ({
  maxPerMessage: String(limits.maxPerMessage),
  maxFileSizeMb: String(limits.maxFileSizeMb),
  maxPerTicketSizeMb: String(limits.maxPerTicketSizeMb),
});

// Empty string -> NaN so the shared validator reports "Enter a whole number".
const parse = (value: string) =>
  value.trim() === "" ? Number.NaN : Number(value);

export function AttachmentLimitsForm({ initialLimits }: Props) {
  const router = useRouter();
  const idPrefix = useId();
  const [saved, setSaved] = useState<Values>(() => toValues(initialLimits));
  const [values, setValues] = useState<Values>(() => toValues(initialLimits));
  const [saving, setSaving] = useState(false);

  const errors = validateAttachmentLimitInput({
    maxPerMessage: parse(values.maxPerMessage),
    maxFileSizeMb: parse(values.maxFileSizeMb),
    maxPerTicketSizeMb: parse(values.maxPerTicketSizeMb),
  });
  const hasErrors = Object.keys(errors).length > 0;
  const dirty = FIELDS.some(({ field }) => values[field] !== saved[field]);

  async function save() {
    if (hasErrors || !dirty) {
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attachmentMaxPerMessage: parse(values.maxPerMessage),
          attachmentMaxFileSizeMb: parse(values.maxFileSizeMb),
          attachmentMaxPerTicketSizeMb: parse(values.maxPerTicketSizeMb),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Failed to save.");
        return;
      }
      const next: Values = {
        maxPerMessage: String(data.attachmentMaxPerMessage),
        maxFileSizeMb: String(data.attachmentMaxFileSizeMb),
        maxPerTicketSizeMb: String(data.attachmentMaxPerTicketSizeMb),
      };
      setSaved(next);
      setValues(next);
      toast.success("Attachment limits saved.");
      router.refresh();
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setValues(saved);
  }

  return (
    <section className="bg-base-100 rounded-xl border border-base-300 shadow-soft">
      <header className="flex items-start gap-3 p-6 pb-0">
        <span className="mt-0.5 text-base-content-muted">
          <PaperclipIcon className="size-4" />
        </span>
        <div>
          <h2 className="text-base font-semibold text-base-content">
            Attachment Limits
          </h2>
          <p className="text-xs text-base-content-muted mt-0.5">
            Applies to the customer portal, agent replies and the public API.
            Changes take effect immediately. The number of attachments a ticket
            can hold is not limited, only their combined size.
          </p>
        </div>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="grid gap-x-6 gap-y-5 p-6 sm:grid-cols-2 lg:grid-cols-3">
          {FIELDS.map(({ field, description }) => {
            const id = `${idPrefix}-${field}`;
            const { min, max } = ATTACHMENT_LIMIT_BOUNDS[field];
            const error = errors[field];
            return (
              <div className="min-w-0 space-y-1.5" key={field}>
                {/* Label overrides: the shared Label is uppercase by default. */}
                <div className="flex items-baseline justify-between gap-2">
                  <Label
                    className="text-sm font-medium tracking-normal normal-case"
                    htmlFor={id}
                  >
                    {ATTACHMENT_LIMIT_LABELS[field]}
                  </Label>
                  <span className="shrink-0 text-xs text-base-content-muted">
                    Saved: {saved[field]}
                    {field === "maxPerMessage" ? "" : " MB"}
                  </span>
                </div>
                <div className="relative">
                  <Input
                    aria-describedby={`${id}-help`}
                    aria-invalid={error ? true : undefined}
                    className={field === "maxPerMessage" ? undefined : "pr-12"}
                    disabled={saving}
                    id={id}
                    inputMode="numeric"
                    max={max}
                    min={min}
                    onChange={(e) =>
                      setValues((prev) => ({
                        ...prev,
                        [field]: e.target.value,
                      }))
                    }
                    step={1}
                    type="number"
                    value={values[field]}
                  />
                  {field !== "maxPerMessage" && (
                    <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-base-content-muted">
                      MB
                    </span>
                  )}
                </div>
                <p
                  className="text-xs text-base-content-muted"
                  id={`${id}-help`}
                >
                  {description}
                </p>
                {error && (
                  <p className="text-xs text-error" role="alert">
                    {error}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-base-300 px-6 py-4">
          <span className="mr-auto text-xs text-base-content-muted">
            {dirty ? "You have unsaved changes" : "All changes saved"}
          </span>
          <Button
            className="border-base-300 text-base-content hover:bg-base-300 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!dirty || saving}
            onClick={reset}
            size="sm"
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            className="bg-primary text-primary-content hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-base-300 disabled:text-base-content-muted disabled:opacity-60 disabled:hover:bg-base-300"
            disabled={saving || hasErrors || !dirty}
            size="sm"
            type="submit"
          >
            {saving ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      </form>
    </section>
  );
}
