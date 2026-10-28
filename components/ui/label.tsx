import type * as React from "react";

import { cn } from "@/lib/utils";

// Intentionally not daisyUI's `label` — re-checked against 5.7.16. Of the four
// things it sets, three need undoing here (60% colour fails 4.5:1, inline-flex
// is wrong for a block sibling, nowrap breaks narrow columns), leaving just a
// gap. Its other rules target labels joined *into* a control, which this isn't.
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: callers supply htmlFor or wrap the control
    <label
      className={cn(
        "flex items-center gap-2 text-xs font-semibold tracking-wide uppercase select-none group-data-disabled:pointer-events-none group-data-disabled:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 peer-data-[slot=checkbox]:text-sm peer-data-[slot=checkbox]:font-normal peer-data-[slot=checkbox]:tracking-normal peer-data-[slot=checkbox]:normal-case peer-data-[slot=radio-group-item]:text-sm peer-data-[slot=radio-group-item]:font-normal peer-data-[slot=radio-group-item]:tracking-normal peer-data-[slot=radio-group-item]:normal-case peer-data-[slot=switch]:text-sm peer-data-[slot=switch]:font-normal peer-data-[slot=switch]:tracking-normal peer-data-[slot=switch]:normal-case",
        className
      )}
      data-slot="label"
      {...props}
    />
  );
}

export { Label };
