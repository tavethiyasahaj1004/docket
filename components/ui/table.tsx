"use client";

import type * as React from "react";

import { cn } from "@/lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      className="relative w-full overflow-x-auto"
      data-slot="table-container"
    >
      <table
        className={cn(
          // `table` supplies width, alignment, type, cell padding and — the
          // load-bearing part — the separator rules, replacing the per-row
          // `border-b` bookkeeping this did by hand. Only the colour is ours.
          "table caption-bottom [&_td]:border-base-300 [&_th]:border-base-300",
          className
        )}
        data-slot="table"
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      className={cn("bg-base-300/40", className)}
      data-slot="table-header"
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody className={className} data-slot="table-body" {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      className={cn("bg-base-300/50 font-semibold", className)}
      data-slot="table-footer"
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      className={cn(
        // No `border-b` here — `table` draws the separator on the cells, which
        // also handles "every row but the last" without extra selectors.
        "transition-colors hover:bg-base-300/50 has-aria-expanded:bg-base-300/50 data-[state=selected]:bg-base-300",
        className
      )}
      data-slot="table-row"
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      className={cn(
        // `table` already handles head-cell padding, alignment, colour, weight
        // and nowrap. Left here: the brand's uppercase micro-type, and aligning
        // the edge cells with the card's padding.
        "first:pl-[var(--card-spacing,1rem)] last:pr-[var(--card-spacing,1rem)] tracking-ui uppercase [&:has([role=checkbox])]:pr-0",
        className
      )}
      data-slot="table-head"
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      className={cn(
        // Padding and vertical alignment come from `table`; only the edge
        // cells' alignment with the card's padding is set here.
        "first:pl-[var(--card-spacing,1rem)] last:pr-[var(--card-spacing,1rem)] whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      data-slot="table-cell"
      {...props}
    />
  );
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      className={cn("mt-4 text-sm text-base-content-muted", className)}
      data-slot="table-caption"
      {...props}
    />
  );
}

export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
};
