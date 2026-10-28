"use client";

import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  flip,
  offset,
  type Placement,
  shift,
  size,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
  useTransitionStyles,
} from "@floating-ui/react";
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useState,
} from "react";

import { Slot } from "@/lib/slot";
import { cn } from "@/lib/utils";

// Floating UI for behaviour, daisyUI tokens for the surface: daisyUI has no
// *controlled* popover panel, and its `dropdown-content` rules can't reach a
// portalled one anyway. `as` is the escape hatch letting a caller whose content
// *is* a list — the dropdown submenu — render a `<ul>` and pick up `menu`.
type Align = "center" | "end" | "start";

const ALIGN_TO_PLACEMENT: Record<Align, Placement> = {
  center: "bottom",
  end: "bottom-end",
  start: "bottom-start",
};

interface PopoverContextValue {
  context: ReturnType<typeof useFloating>["context"];
  floatingStyles: React.CSSProperties;
  getFloatingProps: ReturnType<typeof useInteractions>["getFloatingProps"];
  getReferenceProps: ReturnType<typeof useInteractions>["getReferenceProps"];
  open: boolean;
  refs: ReturnType<typeof useFloating>["refs"];
  setPlacement: (placement: Placement) => void;
}

const PopoverContext = createContext<PopoverContextValue | null>(null);

function usePopoverContext(name: string) {
  const context = useContext(PopoverContext);
  if (!context) {
    throw new Error(`<${name}> must be rendered inside <Popover>`);
  }
  return context;
}

function Popover({
  open,
  onOpenChange,
  children,
}: {
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
  open: boolean;
}) {
  const [placement, setPlacement] = useState<Placement>("bottom-start");

  const { context, floatingStyles, refs } = useFloating({
    middleware: [
      offset(4),
      flip(),
      shift({ padding: 8 }),
      size({
        apply({ availableHeight, elements }) {
          Object.assign(elements.floating.style, {
            maxHeight: `${availableHeight}px`,
          });
        },
        padding: 8,
      }),
    ],
    onOpenChange: (next) => onOpenChange?.(next),
    open,
    placement,
    // Positions with top/left instead of `transform`, so the open/close
    // animation in PopoverContent can own `transform` without clobbering it.
    transform: false,
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context);
  const { getFloatingProps, getReferenceProps } = useInteractions([
    click,
    dismiss,
    role,
  ]);

  return (
    <PopoverContext.Provider
      value={{
        context,
        floatingStyles,
        getFloatingProps,
        getReferenceProps,
        open,
        refs,
        setPlacement,
      }}
    >
      {children}
    </PopoverContext.Provider>
  );
}

function PopoverTrigger({
  asChild,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  const { getReferenceProps, refs } = usePopoverContext("PopoverTrigger");
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="popover-trigger"
      ref={refs.setReference}
      {...getReferenceProps(props)}
    />
  );
}

function PopoverAnchor(props: React.ComponentProps<"div">) {
  const { refs } = usePopoverContext("PopoverAnchor");
  return <div data-slot="popover-anchor" ref={refs.setReference} {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  as: Comp = "div",
  style,
  ...props
}: React.ComponentProps<"div"> & {
  align?: Align;
  as?: "div" | "ul";
}) {
  const { context, getFloatingProps, floatingStyles, refs, setPlacement } =
    usePopoverContext("PopoverContent");

  useLayoutEffect(() => {
    setPlacement(ALIGN_TO_PLACEMENT[align]);
  }, [align, setPlacement]);

  // Keeps the panel mounted through the close animation, then unmounts it.
  const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
    duration: { close: 90, open: 140 },
    initial: { opacity: 0, transform: "scale(0.97)" },
  });

  if (!isMounted) {
    return null;
  }

  return (
    <FloatingPortal>
      {/* `modal={false}` — a popover is not a modal: the rest of the page stays
          reachable and Tab can leave (which dismisses, via closeOnFocusOut).
          What this restores is the part the hand-rolled Floating UI rebuild
          dropped: focus moves to the first tabbable node inside on open, and
          returns to the trigger on close. Floating UI skips the return when
          focus was deliberately moved elsewhere before unmount (e.g. the
          rich-text toolbar's link/canned-response popovers call
          `editor.chain().focus()` before closing), so the caret stays in the
          editor rather than snapping back to the toolbar button. */}
      <FloatingFocusManager context={context} modal={false}>
        <Comp
          className={cn(
            "z-50 w-72 overflow-y-auto rounded-box border border-base-300 bg-base-100 p-4 text-base-content shadow-md outline-hidden",
            className
          )}
          data-slot="popover-content"
          ref={refs.setFloating}
          style={{ ...floatingStyles, ...transitionStyles, ...style }}
          {...getFloatingProps(props)}
        />
      </FloatingFocusManager>
    </FloatingPortal>
  );
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
