import type * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        // `textarea` owns the surface, border, padding, outline and disabled
        // state. Tailwind keeps the auto-growing layout (a 4rem floor, not
        // daisyUI's fixed 5rem), the placeholder colour it applies only to
        // nested textareas, and the sub-`md` 16px type iOS Safari needs.
        "textarea flex field-sizing-content min-h-16 w-full resize-none text-base placeholder:text-base-content-muted aria-invalid:border-error md:text-sm dark:aria-invalid:border-error/50",
        className
      )}
      data-slot="textarea"
      {...props}
    />
  );
}

export { Textarea };
