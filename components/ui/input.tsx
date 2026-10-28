import type * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        // `input` owns the control outright. Three things it doesn't cover stay
        // in Tailwind: full-width layout (daisyUI caps inputs at 20rem), the
        // placeholder colour (it styles only *nested* inputs), and `text-base`
        // below `md`, which stops iOS Safari zooming the page on focus.
        "input w-full min-w-0 text-base file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-base-content placeholder:text-base-content-muted aria-invalid:border-error md:text-sm dark:aria-invalid:border-error/50",
        className
      )}
      data-slot="input"
      type={type}
      {...props}
    />
  );
}

export { Input };
