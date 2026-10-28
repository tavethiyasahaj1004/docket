import type * as React from "react";

import { Slot } from "@/lib/slot";
import { cn } from "@/lib/utils";

// daisyUI's `badge` supplies the whole chip, so the variants below are its own
// modifiers. `badge-soft` is the workhorse, mixing `--badge-color` into
// `base-100` to stay legible in light *and* dark; `badge-ghost` sits on
// `base-200`, equal to `base-100` here, so it reads chrome-less by design.
const badgeVariantClasses = {
  default: "badge-soft",
  secondary: "badge-soft text-base-content-muted",
  destructive: "badge-error badge-soft",
  outline: "badge-outline",
  ghost: "badge-ghost text-base-content-muted",
  link: "badge-ghost underline-offset-4 [a]:hover:underline",
} as const;

type BadgeVariant = keyof typeof badgeVariantClasses;

function badgeVariants({
  variant = "default",
  className,
}: {
  variant?: BadgeVariant;
  className?: string;
} = {}) {
  return cn(
    // Only brand typography and icon sizing are left to Tailwind — `badge` has
    // no opinion about either.
    "badge group/badge tracking-ui whitespace-nowrap uppercase [&>svg]:pointer-events-none [&>svg]:size-3",
    badgeVariantClasses[variant],
    className
  );
}

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & {
  variant?: BadgeVariant;
  asChild?: boolean;
}) {
  const Comp = asChild ? Slot : "span";

  return (
    <Comp
      className={badgeVariants({ variant, className })}
      data-slot="badge"
      data-variant={variant}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
