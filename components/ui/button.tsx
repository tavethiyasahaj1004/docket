import type * as React from "react";

import { Slot } from "@/lib/slot";
import { cn } from "@/lib/utils";

// Fully daisyUI: `btn` owns the box (height, rounding, border, centring, gap,
// transition and every interaction state) and the `btn-*` modifiers own the
// palette via `--btn-color`/`--btn-fg`, which alias the Docket theme tokens —
// so every variant follows the active preset and appearance mode for free.
const buttonVariantClasses = {
  default: "btn-primary",
  outline: "btn-outline",
  secondary: "btn-secondary",
  ghost: "btn-ghost",
  // `btn-soft` is daisyUI's own tinted-fill treatment — an 8% error wash with
  // a 10% border and error text, which is what this variant always wanted.
  destructive: "btn-error btn-soft",
  link: "btn-link",
} as const;

// daisyUI's size scale (`--size-field × 6/8/10/12`) carries the matching font
// size and `--btn-p` inline padding with it. `btn-square` zeroes `--btn-p` and
// squares the box for icon-only buttons.
const buttonSizeClasses = {
  default: "",
  xs: "btn-xs [&_svg:not([class*='size-'])]:size-3",
  sm: "btn-sm",
  lg: "btn-lg",
  icon: "btn-square",
  "icon-xs": "btn-square btn-xs [&_svg:not([class*='size-'])]:size-3",
  "icon-sm": "btn-square btn-sm",
  "icon-lg": "btn-square btn-lg",
} as const;

type ButtonVariant = keyof typeof buttonVariantClasses;
type ButtonSize = keyof typeof buttonSizeClasses;

function buttonVariants({
  variant = "default",
  size = "default",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}) {
  return cn(
    // What's left in Tailwind is brand typography daisyUI has no opinion about
    // (uppercase + `tracking-ui`) and an icon-sizing rule `btn` doesn't ship.
    // Everything visual comes from `btn` and its modifiers.
    "btn tracking-ui whitespace-nowrap uppercase [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
    buttonVariantClasses[variant],
    buttonSizeClasses[size],
    className
  );
}

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
}) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      className={buttonVariants({ variant, size, className })}
      data-size={size}
      data-slot="button"
      data-variant={variant}
      {...props}
    />
  );
}

export { Button, buttonVariants };
