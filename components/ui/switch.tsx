import type * as React from "react";

import { cn } from "@/lib/utils";

// daisyUI's size ramp: `--size-selector × 4/5/6`.
const switchSizeClasses = {
  xs: "toggle-xs",
  sm: "toggle-sm",
  default: "",
} as const;

type SwitchSize = keyof typeof switchSizeClasses;

function Switch({
  className,
  size = "sm",
  onCheckedChange,
  ...props
}: Omit<React.ComponentProps<"input">, "onChange" | "size" | "type"> & {
  onCheckedChange?: (checked: boolean) => void;
  size?: SwitchSize;
}) {
  return (
    <input
      className={cn(
        // Stock daisyUI. `toggle` is an *outlined* switch by design — the track
        // stays unfilled and the knob carries the state, by position and
        // `--input-color`. Tailwind keeps only the invalid state.
        "toggle toggle-primary aria-invalid:outline-2 aria-invalid:outline-error/20",
        switchSizeClasses[size],
        className
      )}
      data-size={size}
      data-slot="switch"
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      type="checkbox"
      {...props}
    />
  );
}

export { Switch };
