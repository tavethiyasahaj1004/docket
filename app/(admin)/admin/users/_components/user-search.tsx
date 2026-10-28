"use client";

import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function UserSearch() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlQ = searchParams.get("q") ?? "";
  const [q, setQ] = useState(urlQ);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUrlQ = useRef(urlQ);

  const push = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set("q", value);
      } else {
        params.delete("q");
      }
      params.delete("page");
      router.push(`/admin/users?${params.toString()}`);
    },
    [router, searchParams]
  );

  useEffect(() => {
    // Skip when already in sync with the URL — otherwise each router.push()
    // produces a new searchParams (and new push callback), re-firing this
    // effect in an infinite navigation loop.
    const current = searchParams.get("q") ?? "";
    if (q === current) {
      return;
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => push(q), 300);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [q, searchParams, push]);

  // Adopt URL changes this input didn't make — browser back/forward, and the
  // reset Add User does so a newly created user isn't hidden behind a filter.
  // Without this the debounce above would push the stale term straight back.
  useEffect(() => {
    if (urlQ !== lastUrlQ.current) {
      lastUrlQ.current = urlQ;
      setQ(urlQ);
    }
  }, [urlQ]);

  return (
    <div className="relative w-72">
      {/* z-10: daisyUI's `input` is itself `position: relative` with an opaque
          `base-100` fill, so as a later positioned sibling it would otherwise
          paint over this icon. */}
      <MagnifyingGlassIcon className="absolute left-3 top-1/2 z-10 -translate-y-1/2 size-4 text-base-content-muted pointer-events-none" />
      <Input
        autoComplete="off"
        className={cn("h-10 pl-9", q && "pr-9")}
        name="user-search"
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name or email…"
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
  );
}
