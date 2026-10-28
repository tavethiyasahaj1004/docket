"use client";

import { PlusIcon, TagIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface Tag {
  id: string;
  name: string;
}

interface Props {
  disabled?: boolean;
  onSelect: (name: string) => void;
}

/** Bulk-bar tag picker — search-or-create against the shared tag pool, mirroring ticket-tags.tsx's popover. */
export function BulkTagSelect({ disabled = false, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Tag[]>([]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/tags?q=${encodeURIComponent(query)}`);
        if (res.ok) {
          setResults((await res.json()) as Tag[]);
        }
      } catch {
        // Autocomplete is best-effort — a failed search just shows no matches.
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [open, query]);

  const normalizedQuery = query.trim().toLowerCase();
  const canCreate =
    normalizedQuery.length > 0 &&
    !results.some((t) => t.name.toLowerCase() === normalizedQuery);

  function pick(name: string) {
    onSelect(name);
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setQuery("");
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <button
          className="flex h-9 items-center gap-1.5 rounded-md border border-base-300 bg-transparent px-3 text-sm text-base-content-muted transition-colors hover:border-stone hover:text-base-content disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled}
          type="button"
        >
          <TagIcon className="size-4" />
          Add tag…
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <div className="border-b border-base-300 px-2.5">
          <input
            autoFocus
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-base-content-muted"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canCreate) {
                e.preventDefault();
                pick(query);
              }
            }}
            placeholder="Search or create a tag…"
            value={query}
          />
        </div>
        <div className="max-h-52 overflow-y-auto p-1">
          {canCreate && (
            <button
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-base-content transition-colors hover:bg-base-300/60"
              onClick={() => pick(query)}
              type="button"
            >
              <PlusIcon className="size-3.5 shrink-0 text-base-content-muted" />
              <span className="truncate">Create "{query.trim()}"</span>
            </button>
          )}
          {results.map((tag) => (
            <button
              className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-base-content transition-colors hover:bg-base-300/60"
              key={tag.id}
              onClick={() => pick(tag.name)}
              type="button"
            >
              <span className="truncate">{tag.name}</span>
            </button>
          ))}
          {!canCreate && results.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-base-content-muted">
              {query ? "No matches" : "No tags yet"}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
