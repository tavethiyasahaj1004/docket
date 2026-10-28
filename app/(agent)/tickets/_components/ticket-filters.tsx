"use client";

import {
  ArrowRightIcon,
  CalendarBlankIcon,
  ChatCircleDotsIcon,
  FunnelIcon,
  MagnifyingGlassIcon,
  UserIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { SearchableSelect } from "@/components/common/searchable-select";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type {
  TicketCategory,
  TicketPriority,
  TicketStatus,
} from "@/lib/ticket-config";
import { cn } from "@/lib/utils";
import { TicketDateQuickFilter } from "./ticket-date-quick-filter";

const RANGE_OPTIONS = [
  { value: "all", label: "All Time" },
  { value: "last_day", label: "Last One Day" },
  { value: "last_week", label: "Last 1 Week" },
  { value: "this_month", label: "This Month" },
  { value: "custom", label: "Custom Range" },
];
const RANGE_LABEL = Object.fromEntries(
  RANGE_OPTIONS.map((o) => [o.value, o.label])
);

const formatDay = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

const parseDay = (iso: string) => new Date(`${iso}T00:00:00`);
const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

interface Agent {
  email: string;
  id: string;
  name: string | null;
}

interface Props {
  agents: Agent[];
  categories: TicketCategory[];
  priorities: TicketPriority[];
  statuses: TicketStatus[];
  tags: string[];
}

export function TicketFilters({
  statuses,
  categories,
  priorities,
  agents,
  tags,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [q, setQ] = useState(searchParams.get("q") ?? "");
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const status = searchParams.get("status") ?? "all";
  const category = searchParams.get("category") ?? "all";
  const priority = searchParams.get("priority") ?? "all";
  const assignee = searchParams.get("assignee") ?? "all";
  const tag = searchParams.get("tag") ?? "all";
  const range = searchParams.get("range") ?? "all";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const awaiting = searchParams.get("awaiting") === "1";
  const mine = searchParams.get("mine") === "1";

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
      params.delete("page"); // reset pagination on filter change
      router.push(`/tickets?${params.toString()}`);
    },
    [router, searchParams]
  );

  useEffect(() => {
    // Already in sync with the URL — do nothing. Without this guard, each
    // router.push() yields a new searchParams (and thus a new updateParams),
    // which re-triggers this effect and causes an infinite navigation loop.
    const current = searchParams.get("q") ?? "";
    if (q === current) {
      return;
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      updateParams({ q });
    }, 300);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [q, searchParams, updateParams]);

  const statusMap = Object.fromEntries(statuses.map((s) => [s.slug, s.label]));
  const categoryMap = Object.fromEntries(
    categories.map((c) => [c.slug, c.label])
  );
  const priorityMap = Object.fromEntries(
    priorities.map((p) => [p.slug, p.label])
  );
  const agentMap = Object.fromEntries(
    agents.map((a) => [a.id, a.name ?? a.email])
  );

  const tagOptions =
    tag !== "all" && !tags.includes(tag) ? [tag, ...tags] : tags;

  const activeFilters = [
    status !== "all" && {
      key: "status",
      // May be a comma-separated bucket from a dashboard card link.
      label: status
        .split(",")
        .map((v) => statusMap[v] ?? v)
        .join(" / "),
    },
    category !== "all" && {
      key: "category",
      label: categoryMap[category] ?? category,
    },
    priority !== "all" && {
      key: "priority",
      label: priorityMap[priority] ?? priority,
    },
    assignee !== "all" && {
      key: "assignee",
      label:
        assignee === "unassigned"
          ? "Unassigned"
          : (agentMap[assignee] ?? assignee),
    },
    tag !== "all" && { key: "tag", label: `Tag: ${tag}` },
    range !== "all" && {
      key: "range",
      label:
        range === "custom"
          ? from && to
            ? `${formatDay(from)} – ${formatDay(to)}`
            : from
              ? `From ${formatDay(from)}`
              : to
                ? `Until ${formatDay(to)}`
                : "Custom Range"
          : (RANGE_LABEL[range] ?? range),
    },
    mine && { key: "mine", label: "Assigned to me" },
    awaiting && { key: "awaiting", label: "Awaiting reply" },
  ].filter(Boolean) as Array<{ key: string; label: string }>;

  const activeCount = activeFilters.length;

  function clearAll() {
    setQ("");
    updateParams({
      q: "",
      status: "all",
      category: "all",
      priority: "all",
      assignee: "all",
      tag: "all",
      range: "all",
      from: "",
      to: "",
      awaiting: "",
      mine: "",
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        {/* Quick day-range filter — shares the `range` param with the Date
            Range option below (see lib/tickets-list-query.ts). */}
        <TicketDateQuickFilter />

        {/* Search */}
        <div className="relative flex-1 min-w-0">
          {/* z-10: daisyUI's `input` is itself `position: relative` with an
              opaque `base-100` fill, so as a later positioned sibling it would
              otherwise paint over this icon. */}
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 z-10 -translate-y-1/2 size-4 text-base-content-muted pointer-events-none" />
          <Input
            className={cn("h-10 pl-9", q && "pr-9")}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tickets, customers…"
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

        {/* Filters popover */}
        <Popover onOpenChange={setOpen} open={open}>
          <PopoverTrigger asChild>
            <button
              className={cn(
                "inline-flex h-10 shrink-0 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors",
                activeCount > 0
                  ? "border-primary/30 bg-primary/5 text-base-content"
                  : "border-base-300 text-base-content-muted hover:text-base-content hover:bg-base-300"
              )}
              type="button"
            >
              <FunnelIcon className="size-4" />
              Filters
              {activeCount > 0 && (
                <span className="inline-flex size-4.5 items-center justify-center rounded-full bg-primary text-primary-content text-2xs font-semibold">
                  {activeCount}
                </span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-4 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-base-content">
                Filters
              </span>
              {activeCount > 0 && (
                <button
                  className="text-xs text-base-content-muted hover:text-base-content"
                  onClick={clearAll}
                  type="button"
                >
                  Clear all
                </button>
              )}
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-base-content-muted">
                  Status
                </span>
                <Select
                  onValueChange={(v) => updateParams({ status: v })}
                  value={status}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="All Statuses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    {statuses.map((s) => (
                      <SelectItem key={s.slug} value={s.slug}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <span className="text-xs font-medium text-base-content-muted">
                  Category
                </span>
                <Select
                  onValueChange={(v) => updateParams({ category: v })}
                  value={category}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="All Categories" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c.slug} value={c.slug}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <span className="text-xs font-medium text-base-content-muted">
                  Priority
                </span>
                <Select
                  onValueChange={(v) => updateParams({ priority: v })}
                  value={priority}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="All Priorities" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Priorities</SelectItem>
                    {priorities.map((p) => (
                      <SelectItem key={p.slug} value={p.slug}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <span className="text-xs font-medium text-base-content-muted">
                  Assignee
                </span>
                <SearchableSelect
                  onValueChange={(v) => updateParams({ assignee: v })}
                  options={[
                    { value: "all", label: "All Assignees" },
                    { value: "unassigned", label: "Unassigned" },
                    ...agents.map((a) => ({
                      value: a.id,
                      label: a.name ?? a.email,
                    })),
                  ]}
                  placeholder="All Assignees"
                  searchPlaceholder="Search agents…"
                  triggerClassName="w-full"
                  value={assignee}
                />
              </div>

              <div className="space-y-1.5">
                <span className="text-xs font-medium text-base-content-muted">
                  Tag
                </span>
                <SearchableSelect
                  onValueChange={(v) => updateParams({ tag: v })}
                  options={[
                    { value: "all", label: "All Tags" },
                    // Keep a tag from the URL selectable even if it no longer
                    // exists in the pool, so the control never shows blank.
                    ...tagOptions.map((t) => ({ value: t, label: t })),
                  ]}
                  placeholder="All Tags"
                  searchPlaceholder="Search tags…"
                  triggerClassName="w-full"
                  value={tag}
                />
              </div>

              <div className="space-y-1.5">
                <span className="text-xs font-medium text-base-content-muted">
                  Date Range
                </span>
                <SearchableSelect
                  onValueChange={(v) =>
                    // Leaving Custom must also drop its dates from the URL.
                    updateParams(
                      v === "custom"
                        ? { range: v }
                        : { range: v, from: "", to: "" }
                    )
                  }
                  options={RANGE_OPTIONS}
                  placeholder="All Time"
                  searchPlaceholder="Search range…"
                  triggerClassName="w-full"
                  value={range}
                />
                {range === "custom" && (
                  <div className="space-y-2 pt-1">
                    <div className="flex items-center justify-center gap-2">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md border border-base-300 px-2 py-1 text-xs",
                          from ? "text-base-content" : "text-base-content-muted"
                        )}
                      >
                        <CalendarBlankIcon className="size-3.5 shrink-0" />
                        {from ? formatDay(from) : "Start date"}
                      </span>
                      <ArrowRightIcon className="size-3.5 shrink-0 text-base-content-muted" />
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md border border-base-300 px-2 py-1 text-xs",
                          to ? "text-base-content" : "text-base-content-muted"
                        )}
                      >
                        <CalendarBlankIcon className="size-3.5 shrink-0" />
                        {to ? formatDay(to) : "End date"}
                      </span>
                    </div>
                    <Calendar
                      className="w-full rounded-md border border-base-300"
                      defaultMonth={from ? parseDay(from) : undefined}
                      disabled={{ after: new Date() }}
                      mode="range"
                      onSelect={(r) =>
                        updateParams({
                          from: r?.from ? toIso(r.from) : "",
                          to: r?.to ? toIso(r.to) : "",
                        })
                      }
                      selected={{
                        from: from ? parseDay(from) : undefined,
                        to: to ? parseDay(to) : undefined,
                      }}
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-3 border-t border-base-300 pt-3">
              <div className="flex items-center justify-between gap-2">
                <button
                  className="flex items-center gap-1.5 text-sm text-base-content"
                  onClick={() => updateParams({ mine: mine ? "" : "1" })}
                  type="button"
                >
                  <UserIcon className="size-4 text-base-content-muted" />
                  Assigned to me
                </button>
                <Switch
                  checked={mine}
                  onCheckedChange={(v) => updateParams({ mine: v ? "1" : "" })}
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <button
                  className="flex items-center gap-1.5 text-sm text-base-content"
                  onClick={() =>
                    updateParams({ awaiting: awaiting ? "" : "1" })
                  }
                  type="button"
                >
                  <ChatCircleDotsIcon className="size-4 text-base-content-muted" />
                  Awaiting reply
                </button>
                <Switch
                  checked={awaiting}
                  onCheckedChange={(v) =>
                    updateParams({ awaiting: v ? "1" : "" })
                  }
                />
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {/* Active filter chips */}
      {activeCount > 0 && (
        <div className="flex flex-wrap gap-2">
          {activeFilters.map((f) => (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 border border-primary/20 px-2.5 py-1 text-xs font-medium text-base-content"
              key={f.key}
            >
              {f.label}
              <button
                className="ml-0.5 hover:text-base-content/60"
                onClick={() =>
                  // Removing the range chip must also drop its custom dates.
                  updateParams(
                    f.key === "range"
                      ? { range: "", from: "", to: "" }
                      : { [f.key]: "" }
                  )
                }
                type="button"
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
          <Button
            className="h-auto py-1 px-2 text-xs text-base-content-muted hover:text-base-content"
            onClick={clearAll}
            size="sm"
            variant="ghost"
          >
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
}
