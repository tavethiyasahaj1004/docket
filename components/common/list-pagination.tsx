"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { SearchableSelect } from "@/components/common/searchable-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface GoToPageProps {
  /** Route to push page-jump navigations to, e.g. "/tickets". */
  basePath: string;
  totalPages: number;
}

export function GoToPage({ totalPages, basePath }: GoToPageProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState("");

  function go() {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) {
      return;
    }
    const target = Math.min(Math.max(1, n), totalPages);
    const params = new URLSearchParams(searchParams.toString());
    if (target > 1) {
      params.set("page", String(target));
    } else {
      params.delete("page");
    }
    router.push(`${basePath}?${params.toString()}`);
    setValue("");
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-base-content-muted shrink-0">
        Go to page
      </span>
      <Input
        className="h-8 w-16 text-xs text-center px-1"
        max={totalPages}
        min={1}
        onChange={(e) => {
          // The HTML max attribute only constrains the spinner arrows —
          // typed input must be clamped by hand to keep 1..totalPages.
          const raw = e.target.value;
          if (raw === "") {
            setValue("");
            return;
          }
          const n = Number.parseInt(raw, 10);
          if (!Number.isFinite(n)) {
            return;
          }
          setValue(String(Math.min(Math.max(1, n), totalPages)));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            go();
          }
        }}
        placeholder={`1–${totalPages}`}
        type="number"
        value={value}
      />
      <Button
        className="h-8 border-base-300 text-base-content hover:bg-base-300"
        disabled={!value}
        onClick={go}
        size="sm"
        variant="outline"
      >
        Go
      </Button>
    </div>
  );
}

interface PageSizeSelectProps {
  /** Route to push page-size changes to, e.g. "/tickets". */
  basePath: string;
  options: number[];
  pageSize: number;
}

export function PageSizeSelect({
  pageSize,
  options,
  basePath,
}: PageSizeSelectProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  // The new size is only reflected in `pageSize` once the server has re-rendered
  // the list, so show the pick right away — otherwise the trigger and the
  // menu's check/highlight keep showing the old size (and two rows look
  // selected) until navigation finishes. Reverts to the real prop afterwards.
  const [optimisticSize, setOptimisticSize] = useOptimistic(pageSize);

  function handleChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("pageSize", value);
    params.delete("page"); // reset pagination when the page size changes
    startTransition(() => {
      setOptimisticSize(Number(value));
      router.push(`${basePath}?${params.toString()}`);
    });
  }

  return (
    <SearchableSelect
      // Plain numbers — the "per page" context comes from the label next to
      // the select, so a "/ page" suffix on every option would just repeat it.
      onValueChange={handleChange}
      options={options.map((n) => ({ value: String(n), label: String(n) }))}
      search={false}
      triggerClassName="h-8 w-20 text-xs"
      value={String(optimisticSize)}
    />
  );
}
