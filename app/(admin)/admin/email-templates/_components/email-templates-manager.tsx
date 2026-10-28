"use client";

import {
  ArrowCounterClockwiseIcon,
  CaretDownIcon,
  EyeIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { RichTextEditor } from "@/components/common/rich-text-editor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { EmailTemplateType } from "@/lib/email-templates";
import { cn } from "@/lib/utils";

interface MergeTag {
  description: string;
  tag: string;
}

export interface TemplateItem {
  body: string | null;
  /** Tiptap JSON for the built-in body design, pre-filled when there's no saved override. */
  defaultBody: string;
  defaultSubject: string;
  description: string;
  /** True for emails Docket stops sending when the sending toggle is off — their editor locks too, since editing them would have no effect. */
  gatedByTicketToggle: boolean;
  label: string;
  mergeTags: MergeTag[];
  subject: string | null;
  type: EmailTemplateType;
}

interface Props {
  initialTemplates: TemplateItem[];
  ticketEmailNotificationsEnabled: boolean;
}

export function EmailTemplatesManager({
  initialTemplates,
  ticketEmailNotificationsEnabled,
}: Props) {
  const [templates, setTemplates] = useState(initialTemplates);
  const [openType, setOpenType] = useState<EmailTemplateType | null>(null);

  return (
    <div className="space-y-3">
      {templates.map((item) => (
        <TemplateCard
          isOpen={openType === item.type}
          item={item}
          key={item.type}
          locked={item.gatedByTicketToggle && !ticketEmailNotificationsEnabled}
          onToggle={() =>
            setOpenType((cur) => (cur === item.type ? null : item.type))
          }
          onUpdated={(updated) =>
            setTemplates((prev) =>
              prev.map((t) => (t.type === updated.type ? updated : t))
            )
          }
        />
      ))}
    </div>
  );
}

function TemplateCard({
  item,
  isOpen,
  locked,
  onToggle,
  onUpdated,
}: {
  item: TemplateItem;
  isOpen: boolean;
  locked: boolean;
  onToggle: () => void;
  onUpdated: (item: TemplateItem) => void;
}) {
  const isCustomized = item.body !== null;
  const initialSubject = item.subject ?? item.defaultSubject;
  const initialBody = item.body ?? item.defaultBody;
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const isDirty = subject !== initialSubject || body !== initialBody;
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/email-templates/${item.type}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body }),
      });
      const data = (await res.json()) as {
        error?: string;
        subject?: string | null;
        body?: string | null;
      };
      if (!res.ok) {
        toast.error(data.error ?? "Failed to save.");
        return;
      }
      onUpdated({
        ...item,
        subject: data.subject ?? null,
        body: data.body ?? null,
      });
      toast.success(`"${item.label}" template saved.`);
    } catch {
      toast.error("Network error.");
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setResetting(true);
    try {
      const res = await fetch(`/api/admin/email-templates/${item.type}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: null, body: null }),
      });
      if (!res.ok) {
        toast.error("Failed to reset.");
        return;
      }
      setSubject(item.defaultSubject);
      setBody(item.defaultBody);
      onUpdated({ ...item, subject: null, body: null });
      toast.success(`"${item.label}" reset to default.`);
    } catch {
      toast.error("Network error.");
    } finally {
      setResetting(false);
    }
  }

  async function handlePreview() {
    if (!body || body.trim().length === 0) {
      toast.error("Write a body first to preview it.");
      return;
    }
    setPreviewOpen(true);
    setPreviewLoading(true);
    try {
      const res = await fetch(
        `/api/admin/email-templates/${item.type}/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject, body }),
        }
      );
      const data = (await res.json()) as { error?: string; html?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Failed to render preview.");
        setPreviewOpen(false);
        return;
      }
      setPreviewHtml(data.html ?? null);
    } catch {
      toast.error("Network error.");
      setPreviewOpen(false);
    } finally {
      setPreviewLoading(false);
    }
  }

  return (
    <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft overflow-hidden">
      <button
        className="flex w-full items-center justify-between gap-3 p-5 text-left"
        onClick={onToggle}
        type="button"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-base-content">
              {item.label}
            </h3>
            {isCustomized && (
              <span className="inline-flex items-center rounded border border-base-300 bg-base-300 px-1.5 py-0.5 text-2xs font-medium text-base-content">
                Customized
              </span>
            )}
            {locked && (
              <span className="inline-flex items-center rounded border border-base-300 bg-base-300 px-1.5 py-0.5 text-2xs font-medium text-base-content-muted">
                Sending off
              </span>
            )}
          </div>
          <p className="text-xs text-base-content-muted mt-0.5">
            {locked
              ? "Docket sends email is off — this template can't be edited until it's turned back on."
              : item.description}
          </p>
        </div>
        <CaretDownIcon
          className={cn(
            "size-4 shrink-0 text-base-content-muted transition-transform",
            isOpen && "rotate-180"
          )}
        />
      </button>

      {isOpen && (
        <div className="border-t border-base-300 p-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div className="md:col-span-2 space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-base-content-muted">
                  Subject
                </Label>
                <Input
                  className="rounded-md font-mono text-xs"
                  disabled={locked}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={item.defaultSubject}
                  value={subject}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-base-content-muted">
                  Body
                </Label>
                <RichTextEditor
                  disabled={locked}
                  onChange={setBody}
                  placeholder="Write this email's body… use merge tags like {{customerName}}."
                  showButtonStyleOption
                  value={body}
                />
              </div>

              <div className="flex items-center gap-2">
                <Button
                  className="bg-primary hover:bg-primary/90 text-primary-content rounded-md"
                  disabled={locked || saving || !body.trim() || !isDirty}
                  onClick={handleSave}
                  size="sm"
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button
                  className="border-base-300 text-base-content hover:bg-base-300 rounded-md gap-1.5"
                  disabled={locked}
                  onClick={handlePreview}
                  size="sm"
                  variant="outline"
                >
                  <EyeIcon className="size-3.5" />
                  Preview
                </Button>
                {isCustomized && (
                  <Button
                    className="border-base-300 text-base-content hover:bg-base-300 rounded-md gap-1.5 ml-auto"
                    disabled={locked || resetting}
                    onClick={handleReset}
                    size="sm"
                    variant="outline"
                  >
                    <ArrowCounterClockwiseIcon className="size-3.5" />
                    {resetting ? "Resetting…" : "Reset to Default"}
                  </Button>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-base-content-muted">
                Merge tags
              </Label>
              <div className="rounded-md border border-base-300 divide-y divide-base-300/60">
                {item.mergeTags.map((tag) => (
                  <div className="p-2.5" key={tag.tag}>
                    <code className="text-xs font-mono text-base-content">
                      {`{{${tag.tag}}}`}
                    </code>
                    <p className="text-2xs text-base-content-muted mt-0.5">
                      {tag.description}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <Dialog onOpenChange={setPreviewOpen} open={previewOpen}>
        <DialogContent className="rounded-xl max-w-5xl">
          <DialogHeader>
            <DialogTitle className="text-base-content">
              Preview — {item.label}
            </DialogTitle>
          </DialogHeader>
          <div className="rounded-md border border-base-300 overflow-hidden bg-white">
            {previewLoading ? (
              <div className="p-10 text-center text-sm text-base-content-muted">
                Rendering…
              </div>
            ) : (
              <iframe
                className="w-full"
                height={500}
                srcDoc={previewHtml ?? ""}
                title="Email preview"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
