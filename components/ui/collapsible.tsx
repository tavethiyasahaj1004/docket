"use client";

import { createContext, useContext, useId } from "react";

// Intentionally not daisyUI's `collapse`, which toggles off a peer checkbox or
// `:focus`; this disclosure is React-state driven and drops content via `hidden`,
// keeping it out of the a11y tree. It ships no styling to migrate anyway.
interface CollapsibleContextValue {
  contentId: string;
  onOpenChange?: (open: boolean) => void;
  open: boolean;
}

const CollapsibleContext = createContext<CollapsibleContextValue | null>(null);

function useCollapsibleContext() {
  const context = useContext(CollapsibleContext);
  if (!context) {
    throw new Error(
      "Collapsible sub-components must be rendered inside <Collapsible>"
    );
  }
  return context;
}

function Collapsible({
  open,
  onOpenChange,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  onOpenChange?: (open: boolean) => void;
  open: boolean;
}) {
  const contentId = useId();
  return (
    <CollapsibleContext.Provider value={{ open, onOpenChange, contentId }}>
      <div
        data-slot="collapsible"
        data-state={open ? "open" : "closed"}
        {...props}
      >
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
}

function CollapsibleTrigger({
  onClick,
  ...props
}: React.ComponentProps<"button">) {
  const { open, onOpenChange, contentId } = useCollapsibleContext();
  return (
    <button
      aria-controls={contentId}
      aria-expanded={open}
      data-slot="collapsible-trigger"
      data-state={open ? "open" : "closed"}
      onClick={(event) => {
        onClick?.(event);
        onOpenChange?.(!open);
      }}
      type="button"
      {...props}
    />
  );
}

function CollapsibleContent({
  children,
  ...props
}: React.ComponentProps<"div">) {
  const { open, contentId } = useCollapsibleContext();
  return (
    <div
      data-slot="collapsible-content"
      data-state={open ? "open" : "closed"}
      hidden={!open}
      id={contentId}
      {...props}
    >
      {children}
    </div>
  );
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
