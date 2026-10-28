"use client";

import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { SearchableSelect } from "@/components/common/searchable-select";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { getAuditActionLabel } from "./audit-log-actions";

interface Props {
  /** Distinct action values actually present in audit_logs (see page.tsx) —
   * not a hand-maintained list, so this never misses an action type. */
  actions: string[];
}

export function AuditLogFilters({ actions }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [q, setQ] = useState(searchParams.get("q") ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const action = searchParams.get("action") ?? "all";

  const updateParams = useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (!v || v === "all") {
          params.delete(k);
        } else {
          params.set(k, v);
        }
      }
      params.delete("page");
      router.push(`/admin/audit-log?${params.toString()}`);
    },
    [router, searchParams]
  );

  useEffect(() => {
    const current = searchParams.get("q") ?? "";
    if (q === current) {
      return;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => updateParams({ q }), 300);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [q, searchParams, updateParams]);

  return (
    <div className="flex flex-wrap gap-3">
      <div className="relative flex-1 min-w-56">
        {/* z-10: daisyUI's `input` is itself `position: relative` with an
            opaque `base-100` fill, so as a later positioned sibling it would
            otherwise paint over this icon. */}
        <MagnifyingGlassIcon className="absolute left-3 top-1/2 z-10 -translate-y-1/2 size-4 text-base-content-muted pointer-events-none" />
        <Input
          className={cn("h-10 pl-9", q && "pr-9")}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search description or actor email…"
          value={q}
        />
        {q && (
          <button
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 flex size-6 items-center justify-center rounded-md text-base-content-muted hover:text-base-content hover:bg-base-300 transition-colors"
            onClick={() => setQ("")}
            type="button"
          >
            <XIcon className="size-4" />
          </button>
        )}
      </div>

      <SearchableSelect
        onValueChange={(v) => updateParams({ action: v })}
        options={[
          { value: "all", label: "All Actions" },
          ...actions.map((a) => ({ value: a, label: getAuditActionLabel(a) })),
        ]}
        placeholder="All Actions"
        searchPlaceholder="Search action…"
        triggerClassName="w-56"
        value={action}
      />
    </div>
  );
}
