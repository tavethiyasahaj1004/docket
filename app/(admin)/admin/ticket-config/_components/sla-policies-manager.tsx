"use client";

import {
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react/dist/ssr";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDuration } from "@/lib/sla";
import type { SlaPolicy } from "@/lib/sla-policies";
import type { TicketCategory, TicketPriority } from "@/lib/ticket-config";

const ANY = "any";

interface Props {
  categories: TicketCategory[];
  initialPolicies: SlaPolicy[];
  priorities: TicketPriority[];
}

type FormState = {
  name: string;
  priority: string; // ANY sentinel or a priority slug
  category: string; // ANY sentinel or a category slug
  firstResponseMinutes: string;
  nextResponseMinutes: string;
  resolutionMinutes: string;
  isDefault: boolean;
};

const EMPTY_FORM: FormState = {
  name: "",
  priority: ANY,
  category: ANY,
  firstResponseMinutes: "60",
  nextResponseMinutes: "240",
  resolutionMinutes: "1440",
  isDefault: false,
};

function scopeLabel(
  policy: SlaPolicy,
  priorityMap: Record<string, string>,
  categoryMap: Record<string, string>
): string {
  const p = policy.priority
    ? (priorityMap[policy.priority] ?? policy.priority)
    : "Any priority";
  const c = policy.category
    ? (categoryMap[policy.category] ?? policy.category)
    : "Any category";
  return `${p} · ${c}`;
}

export function SlaPoliciesManager({
  initialPolicies,
  priorities,
  categories,
}: Props) {
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SlaPolicy | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SlaPolicy | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priorityMap = Object.fromEntries(
    priorities.map((p) => [p.slug, p.label])
  );
  const categoryMap = Object.fromEntries(
    categories.map((c) => [c.slug, c.label])
  );

  function openAdd() {
    setForm(EMPTY_FORM);
    setError(null);
    setAddOpen(true);
  }

  function openEdit(policy: SlaPolicy) {
    setForm({
      name: policy.name,
      priority: policy.priority ?? ANY,
      category: policy.category ?? ANY,
      firstResponseMinutes: String(policy.firstResponseMinutes),
      nextResponseMinutes: String(policy.nextResponseMinutes),
      resolutionMinutes: String(policy.resolutionMinutes),
      isDefault: policy.isDefault,
    });
    setError(null);
    setEditTarget(policy);
  }

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const isEdit = editTarget !== null;
      const url = isEdit
        ? `/api/admin/sla-policies/${editTarget.id}`
        : "/api/admin/sla-policies";
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          priority: form.priority === ANY ? null : form.priority,
          category: form.category === ANY ? null : form.category,
          firstResponseMinutes: Number.parseInt(form.firstResponseMinutes, 10),
          nextResponseMinutes: Number.parseInt(form.nextResponseMinutes, 10),
          resolutionMinutes: Number.parseInt(form.resolutionMinutes, 10),
          isDefault: form.isDefault,
        }),
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
      const res = await fetch(`/api/admin/sla-policies/${deleteTarget.id}`, {
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

  const scopeIsAny = form.priority === ANY && form.category === ANY;

  return (
    <section className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-base-content">
            SLA Policies
          </h2>
          <p className="text-xs text-base-content-muted mt-0.5">
            Response and resolution targets, optionally scoped by priority
            and/or category. The most specific match wins.
          </p>
        </div>
        <Button
          className="bg-primary hover:bg-primary/90 text-primary-content rounded-md gap-1.5"
          onClick={openAdd}
          size="sm"
        >
          <PlusIcon className="size-4" />
          Add Policy
        </Button>
      </div>

      <div className="divide-y divide-base-300/60">
        {initialPolicies.length === 0 && (
          <p className="py-4 text-sm text-base-content-muted">
            No SLA policies configured yet.
          </p>
        )}
        {initialPolicies.map((p) => (
          <div className="flex items-center gap-3 py-3" key={p.id}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-base-content">
                  {p.name}
                </span>
                {p.isDefault && (
                  <span className="text-xs bg-primary/10 text-base-content border border-primary/20 rounded px-1.5 py-0.5 font-medium">
                    Default
                  </span>
                )}
              </div>
              <p className="text-xs text-base-content-muted mt-0.5">
                {scopeLabel(p, priorityMap, categoryMap)}
              </p>
            </div>
            <div className="flex flex-col items-end gap-0.5 text-xs text-base-content-muted shrink-0">
              <span>
                First response: {formatDuration(p.firstResponseMinutes * 60)}
              </span>
              <span>
                Next response: {formatDuration(p.nextResponseMinutes * 60)}
              </span>
              <span>
                Resolution: {formatDuration(p.resolutionMinutes * 60)}
              </span>
            </div>
            <div className="flex gap-2 ml-2 shrink-0">
              <Button
                className="h-8 border-base-300 text-base-content hover:bg-base-300 rounded-md"
                onClick={() => openEdit(p)}
                size="sm"
                variant="outline"
              >
                <PencilSimpleIcon className="size-3.5" />
              </Button>
              <Button
                className="h-8 border-red-200 text-red-600 hover:bg-red-50 rounded-md"
                onClick={() => {
                  setError(null);
                  setDeleteTarget(p);
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
        <DialogContent className="rounded-xl max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base-content">
              {editTarget ? "Edit SLA Policy" : "Add SLA Policy"}
            </DialogTitle>
            <DialogDescription className="text-base-content-muted">
              {editTarget
                ? "Update this policy's scope or targets."
                : 'Create a new SLA policy. Leave priority/category as "Any" for a broader match.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-base-content-muted">
                Name
              </Label>
              <Input
                className="rounded-md"
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="e.g. Urgent Billing SLA"
                value={form.name}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-base-content-muted">
                  Priority
                </Label>
                <Select
                  onValueChange={(v) =>
                    setForm((f) => ({
                      ...f,
                      priority: v,
                      isDefault:
                        v === ANY && f.category === ANY ? f.isDefault : false,
                    }))
                  }
                  value={form.priority}
                >
                  <SelectTrigger className="w-full text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>Any priority</SelectItem>
                    {priorities.map((p) => (
                      <SelectItem key={p.slug} value={p.slug}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-base-content-muted">
                  Category
                </Label>
                <Select
                  onValueChange={(v) =>
                    setForm((f) => ({
                      ...f,
                      category: v,
                      isDefault:
                        v === ANY && f.priority === ANY ? f.isDefault : false,
                    }))
                  }
                  value={form.category}
                >
                  <SelectTrigger className="w-full text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>Any category</SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c.slug} value={c.slug}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-base-content-muted">
                  First response (min)
                </Label>
                <Input
                  className="rounded-md"
                  min={1}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      firstResponseMinutes: e.target.value,
                    }))
                  }
                  type="number"
                  value={form.firstResponseMinutes}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-base-content-muted">
                  Next response (min)
                </Label>
                <Input
                  className="rounded-md"
                  min={1}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      nextResponseMinutes: e.target.value,
                    }))
                  }
                  type="number"
                  value={form.nextResponseMinutes}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-base-content-muted">
                  Resolution (min)
                </Label>
                <Input
                  className="rounded-md"
                  min={1}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      resolutionMinutes: e.target.value,
                    }))
                  }
                  type="number"
                  value={form.resolutionMinutes}
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                checked={form.isDefault}
                disabled={!scopeIsAny}
                id="sla-isDefault"
                onCheckedChange={(v: boolean | "indeterminate") =>
                  setForm((f) => ({ ...f, isDefault: v === true }))
                }
              />
              <Label
                className="text-sm text-base-content cursor-pointer"
                htmlFor="sla-isDefault"
              >
                Set as the global default (only available for Any/Any scope)
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
              disabled={saving || !form.name.trim()}
              onClick={handleSave}
            >
              {saving ? "Saving…" : editTarget ? "Save Changes" : "Add Policy"}
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
              Delete &ldquo;{deleteTarget?.name}&rdquo;?
            </DialogTitle>
            <DialogDescription className="text-base-content-muted text-center">
              This SLA policy will be permanently removed. Tickets matching its
              scope will fall back to a less specific policy, if any.
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
