"use client";

import {
  ChatTextIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { RichTextEditor } from "@/components/common/rich-text-editor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CannedResponse } from "@/lib/canned-responses";
import { isRichTextEmpty, richTextToPlainText } from "@/lib/rich-text";

interface Props {
  initialResponses: CannedResponse[];
}

type FormState = {
  title: string;
  content: string;
};

const EMPTY_FORM: FormState = { title: "", content: "" };

export function CannedResponsesManager({ initialResponses }: Props) {
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<CannedResponse | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CannedResponse | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openAdd() {
    setForm(EMPTY_FORM);
    setError(null);
    setAddOpen(true);
  }

  function openEdit(response: CannedResponse) {
    setForm({ title: response.title, content: response.content });
    setError(null);
    setEditTarget(response);
  }

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const isEdit = editTarget !== null;
      const url = isEdit
        ? `/api/canned-responses/${editTarget.id}`
        : "/api/canned-responses";
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Failed to save.");
        return;
      }
      setAddOpen(false);
      setEditTarget(null);
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) {
      return;
    }
    setError(null);
    setDeleting(true);
    try {
      const res = await fetch(`/api/canned-responses/${deleteTarget.id}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Failed to delete.");
        setDeleting(false);
        return;
      }
      setDeleteTarget(null);
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Header — count on the left, add button on the right */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-base-content-muted">
          {initialResponses.length}{" "}
          {initialResponses.length === 1 ? "response" : "responses"}
        </p>
        <Button
          className="bg-primary hover:bg-primary/90 text-primary-content rounded-md gap-1.5"
          onClick={openAdd}
          size="sm"
        >
          <PlusIcon className="size-4" />
          Add Response
        </Button>
      </div>

      {initialResponses.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-base-300 bg-base-100 py-16 text-center">
          <ChatTextIcon className="size-8 text-base-content-muted mb-3" />
          <p className="text-sm font-medium text-base-content">
            No canned responses yet
          </p>
          <p className="text-xs text-base-content-muted mt-1">
            Add one to reuse it from the reply editor's toolbar.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {initialResponses.map((r) => (
            <div
              className="group flex flex-col rounded-xl border border-base-300 bg-base-100 p-4 shadow-soft transition-colors hover:border-stone"
              key={r.id}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-base-300 text-base-content-muted">
                    <ChatTextIcon className="size-3.5" />
                  </div>
                  <h3 className="truncate text-sm font-semibold text-base-content">
                    {r.title}
                  </h3>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    aria-label={`Edit ${r.title}`}
                    className="flex size-7 items-center justify-center rounded-md text-base-content-muted transition-colors hover:bg-base-300 hover:text-base-content"
                    onClick={() => openEdit(r)}
                    type="button"
                  >
                    <PencilSimpleIcon className="size-3.5" />
                  </button>
                  <button
                    aria-label={`Delete ${r.title}`}
                    className="flex size-7 items-center justify-center rounded-md text-red-600 transition-colors hover:bg-red-50"
                    onClick={() => {
                      setError(null);
                      setDeleteTarget(r);
                    }}
                    type="button"
                  >
                    <TrashIcon className="size-3.5" />
                  </button>
                </div>
              </div>
              <p className="mt-2 line-clamp-3 text-xs text-base-content-muted">
                {richTextToPlainText(r.content) || "—"}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Add / Edit Dialog */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setAddOpen(false);
            setEditTarget(null);
          }
        }}
        open={addOpen || editTarget !== null}
      >
        <DialogContent className="rounded-xl max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base-content">
              {editTarget ? "Edit Response" : "Add Response"}
            </DialogTitle>
            <DialogDescription className="text-base-content-muted">
              {editTarget
                ? "Update the title or content."
                : "Create a reusable reply template."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-base-content-muted">
                Title
              </Label>
              <Input
                className="rounded-md"
                onChange={(e) =>
                  setForm((f) => ({ ...f, title: e.target.value }))
                }
                placeholder="e.g. Password reset steps"
                value={form.title}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-base-content-muted">
                Content
              </Label>
              <RichTextEditor
                onChange={(content) => setForm((f) => ({ ...f, content }))}
                placeholder="Write the reply template…"
                value={form.content}
              />
            </div>

            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>

          <DialogFooter className="gap-2">
            <Button
              className="flex-1 border-base-300 text-base-content rounded-md"
              disabled={saving}
              onClick={() => {
                setAddOpen(false);
                setEditTarget(null);
              }}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              className="flex-1 bg-primary hover:bg-primary/90 text-primary-content rounded-md"
              disabled={
                saving || !form.title.trim() || isRichTextEmpty(form.content)
              }
              onClick={handleSave}
            >
              {saving
                ? "Saving…"
                : editTarget
                  ? "Save Changes"
                  : "Add Response"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
        open={deleteTarget !== null}
      >
        <DialogContent className="rounded-xl max-w-sm">
          <DialogHeader>
            <div className="mx-auto mb-2 flex size-10 items-center justify-center rounded-full bg-red-100">
              <TrashIcon className="size-5 text-red-600" />
            </div>
            <DialogTitle className="text-base-content text-center">
              Delete &ldquo;{deleteTarget?.title}&rdquo;?
            </DialogTitle>
            <DialogDescription className="text-base-content-muted text-center">
              This canned response will be permanently removed for the whole
              team.
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-xs text-red-600 text-center">{error}</p>}
          <DialogFooter className="gap-2">
            <Button
              className="flex-1 border-base-300 text-base-content rounded-md"
              disabled={deleting}
              onClick={() => {
                setDeleteTarget(null);
                setError(null);
              }}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              className="flex-1 bg-red-600 hover:bg-red-700 text-white rounded-md"
              disabled={deleting}
              onClick={handleDelete}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
