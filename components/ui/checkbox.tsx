import type * as React from "react";

import { cn } from "@/lib/utils";

// daisyUI's size ramp: `--size-selector × 4/5/6`.
const checkboxSizeClasses = {
  xs: "checkbox-xs",
  sm: "checkbox-sm",
  default: "",
} as const;

type CheckboxSize = keyof typeof checkboxSizeClasses;

function Checkbox({
  className,
  size = "sm",
  onCheckedChange,
  ...props
}: Omit<React.ComponentProps<"input">, "onChange" | "size" | "type"> & {
  onCheckedChange?: (checked: boolean) => void;
  size?: CheckboxSize;
}) {
  return (
    <input
      className={cn(
        // `checkbox`/`checkbox-primary` own the box, tick, outline and disabled
        // state. The border is the one override: `--input-color` drives both the
        // resting border and the checked fill, so unchecked boxes would carry a
        // full-strength `primary` frame — too heavy down a table column.
        "checkbox checkbox-primary border-base-300 checked:border-primary indeterminate:border-primary aria-invalid:border-error aria-invalid:outline-2 aria-invalid:outline-error/20",
        checkboxSizeClasses[size],
        className
      )}
      data-size={size}
      data-slot="checkbox"
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      type="checkbox"
      {...props}
    />
  );
}

export { Checkbox };
