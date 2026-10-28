"use client";

import {
  ArrowCounterClockwiseIcon,
  CaretDownIcon,
  CaretUpIcon,
  SlidersHorizontalIcon,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
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
import {
  type ColumnPref,
  CUSTOMIZABLE_COLUMNS,
  DEFAULT_COLUMN_PREFS,
} from "@/lib/tickets-table-columns";

const LABELS = Object.fromEntries(
  CUSTOMIZABLE_COLUMNS.map((c) => [c.id, c.label])
);

function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function ColumnSettingsDialog({ columns }: { columns: ColumnPref[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ColumnPref[]>(columns);
  const [busy, setBusy] = useState(false);

  function handleOpenChange(next: boolean) {
    if (next) {
      setDraft(columns);
    }
    setOpen(next);
  }

  function toggleVisible(id: ColumnPref["id"]) {
    setDraft((prev) =>
      prev.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c))
    );
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= draft.length) {
      return;
    }
    setDraft((prev) => moveItem(prev, index, target));
  }

  async function handleSave() {
    setBusy(true);
    try {
      const res = await fetch("/api/tickets/table-columns", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ columns: draft }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(data?.error ?? "Failed to save column preferences.");
        return;
      }
      toast.success("Column preferences saved.");
      setOpen(false);
      router.refresh();
    } catch {
      toast.error("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        onClick={() => handleOpenChange(true)}
        size="sm"
        variant="outline"
      >
        <SlidersHorizontalIcon className="size-4" />
        Columns
      </Button>
      <Dialog onOpenChange={handleOpenChange} open={open}>
        <DialogContent className="rounded-xl">
          <DialogHeader>
            <DialogTitle>Customize columns</DialogTitle>
            <DialogDescription>
              Choose which columns to show and use the arrows to reorder them.
              Applies only to your view.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1">
            {draft.map((c, i) => (
              <div
                className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-base-300/50"
                key={c.id}
              >
                <Checkbox
                  checked={c.visible}
                  onCheckedChange={() => toggleVisible(c.id)}
                />
                <span className="flex-1 text-sm text-base-content">
                  {LABELS[c.id]}
                </span>
                <Button
                  className="size-7"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <CaretUpIcon className="size-4" />
                </Button>
                <Button
                  className="size-7"
                  disabled={i === draft.length - 1}
                  onClick={() => move(i, 1)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <CaretDownIcon className="size-4" />
                </Button>
              </div>
            ))}
          </div>

          <DialogFooter className="flex-row items-center gap-2 sm:justify-between">
            <Button
              className="text-base-content-muted"
              disabled={busy}
              onClick={() => setDraft(DEFAULT_COLUMN_PREFS)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <ArrowCounterClockwiseIcon className="size-4" />
              Reset to default
            </Button>
            <div className="flex gap-2">
              <Button
                disabled={busy}
                onClick={() => setOpen(false)}
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={busy} onClick={handleSave}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
