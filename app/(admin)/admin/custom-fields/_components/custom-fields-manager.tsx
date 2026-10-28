"use client";

import {
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react/dist/ssr";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { SearchableSelect } from "@/components/common/searchable-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import type { CustomFieldType, TicketCustomField } from "@/lib/custom-fields";

interface Props {
  initialFields: TicketCustomField[];
}

type FormState = {
  label: string;
  type: CustomFieldType;
  required: boolean;
  options: string[];
};

const EMPTY_FORM: FormState = {
  label: "",
  type: "text",
  required: false,
  options: [],
};

const TYPE_OPTIONS: Array<{ value: CustomFieldType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "checkbox", label: "Checkbox" },
  { value: "select", label: "Select" },
];
const TYPE_LABEL = Object.fromEntries(
  TYPE_OPTIONS.map((t) => [t.value, t.label])
);

export function CustomFieldsManager({ initialFields }: Props) {
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TicketCustomField | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TicketCustomField | null>(
    null
  );
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [optionInput, setOptionInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openAdd() {
    setForm(EMPTY_FORM);
    setOptionInput("");
    setError(null);
    setAddOpen(true);
  }

  function openEdit(field: TicketCustomField) {
    setForm({
      label: field.label,
      type: field.type as CustomFieldType,
      required: field.required,
      options: field.options ?? [],
    });
    setOptionInput("");
    setError(null);
    setEditTarget(field);
  }

  function addOption() {
    const value = optionInput.trim();
    if (!value || form.options.includes(value)) {
      return;
    }
    setForm((f) => ({ ...f, options: [...f.options, value] }));
    setOptionInput("");
  }

  function removeOption(value: string) {
    setForm((f) => ({ ...f, options: f.options.filter((o) => o !== value) }));
  }

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const isEdit = editTarget !== null;
      const url = isEdit
        ? `/api/admin/custom-fields/${editTarget.id}`
        : "/api/admin/custom-fields";
      const body = isEdit
        ? {
            label: form.label,
            required: form.required,
            ...(form.type === "select" ? { options: form.options } : {}),
          }
        : {
            label: form.label,
            type: form.type,
            required: form.required,
            options: form.options,
          };
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
      const res = await fetch(`/api/admin/custom-fields/${deleteTarget.id}`, {
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

  const canSave =
    form.label.trim().length > 0 &&
    (form.type !== "select" || form.options.length >= 2);

  return (
    <section className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-base-content">
            Custom Fields
          </h2>
          <p className="text-xs text-base-content-muted mt-0.5">
            Extra structured fields agents can fill in on a ticket, or that can
            be set when a ticket is created via the public API.
          </p>
        </div>
        <Button
          className="bg-primary hover:bg-primary/90 text-primary-content rounded-md gap-1.5"
          onClick={openAdd}
          size="sm"
        >
          <PlusIcon className="size-4" />
          Add Field
        </Button>
      </div>

      <div className="divide-y divide-base-300/60">
        {initialFields.length === 0 && (
          <p className="py-6 text-center text-xs text-base-content-muted">
            No custom fields yet.
          </p>
        )}
        {initialFields.map((f) => (
          <div className="flex items-center gap-3 py-3" key={f.id}>
            <span className="text-sm font-medium text-base-content flex-1">
              {f.label}
              {f.required && <span className="text-red-600">*</span>}
            </span>
            <span className="text-xs text-base-content-muted">
              {TYPE_LABEL[f.type] ?? f.type}
            </span>
            <span className="text-xs text-base-content-muted font-mono">
              {f.key}
            </span>
            <div className="flex gap-2 ml-2">
              <Button
                className="h-8 border-base-300 text-base-content hover:bg-base-300 rounded-md"
                onClick={() => openEdit(f)}
                size="sm"
                variant="outline"
              >
                <PencilSimpleIcon className="size-3.5" />
              </Button>
              <Button
                className="h-8 border-red-200 text-red-600 hover:bg-red-50 rounded-md"
                onClick={() => {
                  setError(null);
                  setDeleteTarget(f);
                }}
                size="sm"
                variant="outline"
              >
                <TrashIcon className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>

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
        <DialogContent className="rounded-xl max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base-content">
              {editTarget ? "Edit Custom Field" : "Add Custom Field"}
            </DialogTitle>
            <DialogDescription className="text-base-content-muted">
              {editTarget
                ? "Update the field's label, options, or requirement."
                : "Create a new custom field for tickets."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-base-content-muted">
                Label
              </Label>
              <Input
                className="rounded-md"
                onChange={(e) =>
                  setForm((f) => ({ ...f, label: e.target.value }))
                }
                placeholder="e.g. Order ID"
                value={form.label}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-base-content-muted">
                Type
              </Label>
              <SearchableSelect
                disabled={editTarget !== null}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, type: v as CustomFieldType }))
                }
                options={TYPE_OPTIONS}
                search={false}
                triggerClassName="h-9 w-full rounded-md"
                value={form.type}
              />
              {editTarget && (
                <p className="text-xs text-base-content-muted">
                  Type can't be changed after creation.
                </p>
              )}
            </div>

            {form.type === "select" && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-base-content-muted">
                  Options
                </Label>
                <div className="flex flex-wrap gap-1.5">
                  {form.options.map((o) => (
                    <span
                      className="inline-flex items-center gap-1 rounded border border-base-300 bg-base-300 px-2 py-1 text-xs font-medium text-base-content"
                      key={o}
                    >
                      {o}
                      <button
                        aria-label={`Remove option ${o}`}
                        className="text-base-content-muted hover:text-base-content cursor-pointer"
                        onClick={() => removeOption(o)}
                        type="button"
                      >
                        <XIcon className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input
                    className="rounded-md h-8 text-xs"
                    onChange={(e) => setOptionInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addOption();
                      }
                    }}
                    placeholder="Add an option…"
                    value={optionInput}
                  />
                  <Button
                    className="h-8 rounded-md"
                    onClick={addOption}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Add
                  </Button>
                </div>
                {form.options.length < 2 && (
                  <p className="text-xs text-base-content-muted">
                    Add at least 2 options.
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              <Checkbox
                checked={form.required}
                id="custom-field-required"
                onCheckedChange={(checked) =>
                  setForm((f) => ({ ...f, required: checked === true }))
                }
              />
              <Label
                className="text-xs font-medium text-base-content-muted"
                htmlFor="custom-field-required"
              >
                Required
              </Label>
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
              disabled={saving || !canSave}
              onClick={handleSave}
            >
              {saving ? "Saving…" : editTarget ? "Save Changes" : "Add Field"}
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
              Delete &ldquo;{deleteTarget?.label}&rdquo;?
            </DialogTitle>
            <DialogDescription className="text-base-content-muted text-center">
              This field and any values agents have entered for it on tickets
              will be permanently removed.
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
    </section>
  );
}
