"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { TicketView } from "@/lib/tickets-list-query";
import { cn } from "@/lib/utils";

interface Props {
  allCount: number;
  awaitingCount: number;
  openCount: number;
}

/** The three primary queue tabs atop the ticket list. A tab sets (or, for
 * "All Tickets", clears) the `view` query param (see lib/tickets-list-query.ts)
 * — "All Tickets" has no `view` value of its own, it's simply the absence of
 * the param, which is the unrestricted list this page always showed before
 * this feature. That keeps existing bookmarks/links without `view` behaving
 * exactly as before. */
export function TicketViewTabs({ allCount, awaitingCount, openCount }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeView = searchParams.get("view");

  const tabs: Array<{
    count: number;
    label: string;
    value: TicketView | null;
  }> = [
    { value: "awaiting", label: "Awaiting Our Reply", count: awaitingCount },
    { value: "open", label: "All Open Tickets", count: openCount },
    { value: null, label: "All Tickets", count: allCount },
  ];

  function selectView(value: TicketView | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set("view", value);
    } else {
      params.delete("view");
    }
    params.delete("page"); // reset pagination on view change
    const qs = params.toString();
    router.push(`/tickets${qs ? `?${qs}` : ""}`);
  }

  return (
    <div className="flex gap-6 border-b border-base-300" role="tablist">
      {tabs.map((tab) => {
        const active = activeView === tab.value;
        return (
          <button
            aria-selected={active}
            className={cn(
              "-mb-px flex items-center gap-2 border-b-2 pt-1 pb-2.5 text-sm transition-colors",
              active
                ? "border-primary font-semibold text-base-content"
                : "border-transparent font-medium text-base-content-muted hover:text-base-content"
            )}
            key={tab.label}
            onClick={() => selectView(tab.value)}
            role="tab"
            type="button"
          >
            {tab.label}
            <span
              className={cn(
                "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-2xs font-semibold",
                active
                  ? "bg-primary text-primary-content"
                  : "bg-base-300 text-base-content-muted"
              )}
            >
              {tab.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
