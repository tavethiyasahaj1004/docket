import type * as React from "react";

import { cn } from "@/lib/utils";

// daisyUI's `divider` paints the rules itself and centres children between them,
// making "─── or ───" one element rather than three. Its axis naming is the
// reverse of ARIA's: `divider-horizontal` draws a *vertical* rule.
function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  decorative?: boolean;
  orientation?: "horizontal" | "vertical";
}) {
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-orientation only renders when role="separator" (decorative=false), never alongside role="none"
    <div
      aria-orientation={decorative ? undefined : orientation}
      className={cn(
        "divider",
        orientation === "vertical" ? "divider-horizontal" : "divider-vertical",
        className
      )}
      data-slot="separator"
      role={decorative ? "none" : "separator"}
      {...props}
    >
      {children}
    </div>
  );
}

export { Separator };
