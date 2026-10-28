"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All time" },
] as const;

/** A quick day-range picker atop the ticket list, sitting alongside the queue
 * tabs. Writes the same `range` query param the Filters popover's own Date
 * Range dropdown already uses (see lib/tickets-list-query.ts's getRangeStart
 * — "today"/"7d"/"30d"/"90d" are additive slugs it also recognizes), so this
 * is a second, faster way to set the identical filter, not a parallel one. */
export function TicketDateQuickFilter() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const active = searchParams.get("range") ?? "all";

  function selectRange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "all") {
      params.delete("range");
    } else {
      params.set("range", value);
    }
    // A lingering custom range's dates would otherwise sit unused in the URL.
    params.delete("from");
    params.delete("to");
    params.delete("page"); // reset pagination on filter change
    const qs = params.toString();
    router.push(`/tickets${qs ? `?${qs}` : ""}`);
  }

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 rounded-md border border-base-300 px-1">
      {OPTIONS.map((opt) => {
        const selected = active === opt.value;
        return (
          <button
            aria-pressed={selected}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors",
              selected
                ? "bg-primary text-primary-content"
                : "text-base-content-muted hover:bg-base-300 hover:text-base-content"
            )}
            key={opt.value}
            onClick={() => selectRange(opt.value)}
            type="button"
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
