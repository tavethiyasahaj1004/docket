"use client";

import { CaretDownIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface Props {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  /** Shown as a small pill after the title so a collapsed section still says
   *  it has content (e.g. how many linked tickets). Hidden when 0/undefined. */
  count?: number;
  defaultOpen?: boolean;
  icon?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  /** Controlled open state — pass together with `onOpenChange` for accordion
   *  behavior (e.g. only one SidebarCard open at a time). Omit both to fall
   *  back to internal state seeded from `defaultOpen`. */
  open?: boolean;
  title: string;
  titleClassName?: string;
}

/** Collapsible card used by the ticket detail sidebar sections. */
export function SidebarCard({
  title,
  icon,
  children,
  count,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  className,
  contentClassName,
  titleClassName,
}: Props) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = controlledOnOpenChange ?? setUncontrolledOpen;

  return (
    <Collapsible
      className={cn(
        "bg-base-100 rounded-xl border border-base-300 shadow-soft overflow-hidden",
        className
      )}
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 p-4 text-left cursor-pointer">
        <h3
          className={cn(
            "text-xs font-semibold text-base-content-muted uppercase tracking-wide flex items-center gap-1.5",
            titleClassName
          )}
        >
          {icon}
          {title}
          {count ? (
            <Badge className="badge-xs badge-primary">{count}</Badge>
          ) : null}
        </h3>
        <CaretDownIcon
          className={cn(
            "size-3.5 text-base-content-muted shrink-0 transition-transform",
            open && "rotate-180"
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "px-4 pb-4 data-[state=closed]:animate-none",
          contentClassName
        )}
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
