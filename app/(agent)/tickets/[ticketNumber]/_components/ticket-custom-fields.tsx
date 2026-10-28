"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { SearchableSelect } from "@/components/common/searchable-select";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CustomFieldWithValue } from "@/lib/custom-fields";

interface Props {
  initialFields: CustomFieldWithValue[];
  ticketId: string;
}

export function TicketCustomFields({ ticketId, initialFields }: Props) {
  const router = useRouter();
  const [fields, setFields] = useState(initialFields);
  const [savingFieldId, setSavingFieldId] = useState<string | null>(null);

  async function save(field: CustomFieldWithValue, rawValue: string | boolean) {
    setSavingFieldId(field.fieldId);
    try {
      const res = await fetch(`/api/tickets/${ticketId}/custom-fields`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field.key]: rawValue }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(data?.error ?? "Failed to save.");
        return;
      }
      setFields((prev) =>
        prev.map((f) =>
          f.fieldId === field.fieldId
            ? {
                ...f,
                value:
                  typeof rawValue === "boolean"
                    ? rawValue
                      ? "true"
                      : "false"
                    : rawValue,
              }
            : f
        )
      );
      router.refresh();
    } catch {
      toast.error("Network error.");
    } finally {
      setSavingFieldId(null);
    }
  }

  return (
    <div className="space-y-3">
      {fields.map((field) => (
        <div className="space-y-1" key={field.fieldId}>
          <Label className="text-xs text-base-content-muted">
            {field.label}
            {field.required && <span className="text-red-600">*</span>}
          </Label>

          {field.type === "checkbox" ? (
            <Checkbox
              checked={field.value === "true"}
              disabled={savingFieldId === field.fieldId}
              onCheckedChange={(checked) => save(field, checked === true)}
            />
          ) : field.type === "select" ? (
            <SearchableSelect
              disabled={savingFieldId === field.fieldId}
              onValueChange={(v) => save(field, v)}
              options={(field.options ?? []).map((o) => ({
                value: o,
                label: o,
              }))}
              placeholder="Select…"
              search={false}
              triggerClassName="h-8 w-full text-xs"
              value={field.value ?? ""}
            />
          ) : (
            <Input
              className="h-8 text-xs rounded-md"
              defaultValue={field.value ?? ""}
              disabled={savingFieldId === field.fieldId}
              key={field.value ?? ""}
              onBlur={(e) => {
                if (e.target.value !== (field.value ?? "")) {
                  save(field, e.target.value);
                }
              }}
              type={
                field.type === "number"
                  ? "number"
                  : field.type === "date"
                    ? "date"
                    : "text"
              }
            />
          )}
        </div>
      ))}
    </div>
  );
}
