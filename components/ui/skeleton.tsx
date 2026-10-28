import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      // Pure daisyUI: `skeleton` supplies the `base-300` fill, `--radius-box`
      // rounding and a sweep animation correctly gated behind
      // `prefers-reduced-motion` (`animate-pulse` was not). Any caller passing
      // its own `rounded-*` still wins through `cn`.
      className={cn("skeleton", className)}
      data-slot="skeleton"
      {...props}
    />
  );
}

export { Skeleton };
