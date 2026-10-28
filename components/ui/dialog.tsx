"use client";

import {
  DialogBackdrop,
  DialogPanel,
  Dialog as HeadlessDialog,
  DialogTitle as HeadlessDialogTitle,
} from "@headlessui/react";
import { XIcon } from "@phosphor-icons/react";
import { createContext, useContext } from "react";

import { Button } from "@/components/ui/button";
import { Slot } from "@/lib/slot";
import { cn } from "@/lib/utils";

// daisyUI `modal-box`/`modal-action` for the surface, Headless UI `Dialog` for
// behaviour. `modal-box` can't own its own visibility here: its `opacity: 0`
// is undone only by `.modal[open]`, the CSS state machine Headless UI replaces.
// So the panel pins `opacity-100 scale-100` and defers to `data-closed`.
interface DialogContextValue {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

const DialogContext = createContext<DialogContextValue | null>(null);

function useDialogContext(name: string) {
  const context = useContext(DialogContext);
  if (!context) {
    throw new Error(`<${name}> must be rendered inside <Dialog>`);
  }
  return context;
}

function Dialog({
  open,
  onOpenChange,
  children,
}: {
  children: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <DialogContext.Provider
      value={{ open, onOpenChange: onOpenChange ?? (() => undefined) }}
    >
      {children}
    </DialogContext.Provider>
  );
}

function DialogTrigger({
  asChild,
  onClick,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  const { onOpenChange } = useDialogContext("DialogTrigger");
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="dialog-trigger"
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        onOpenChange(true);
      }}
      {...props}
    />
  );
}

function DialogPortal({ children }: { children: React.ReactNode }) {
  return children;
}

function DialogClose({
  asChild,
  onClick,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  const { onOpenChange } = useDialogContext("DialogClose");
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="dialog-close"
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        onOpenChange(false);
      }}
      {...props}
    />
  );
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogBackdrop>) {
  return (
    <DialogBackdrop
      className={cn(
        "fixed inset-0 z-50 bg-black/40 transition-opacity duration-100 data-closed:opacity-0",
        className
      )}
      data-slot="dialog-overlay"
      transition
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: Omit<React.ComponentProps<typeof DialogPanel>, "children"> & {
  children?: React.ReactNode;
  showCloseButton?: boolean;
}) {
  const { open, onOpenChange } = useDialogContext("DialogContent");
  return (
    <HeadlessDialog
      className="relative z-50"
      onClose={() => onOpenChange(false)}
      open={open}
    >
      <DialogOverlay />
      <div className="fixed inset-0 z-50 flex w-screen items-center justify-center p-4">
        <DialogPanel
          className={cn(
            "modal-box relative grid max-h-full scale-100 gap-6 text-sm text-base-content opacity-100 transition-all duration-100 outline-none data-closed:scale-95 data-closed:opacity-0",
            className
          )}
          data-slot="dialog-content"
          transition
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogClose asChild>
              <Button
                className="absolute top-5 right-5"
                size="icon-sm"
                variant="ghost"
              >
                <XIcon />
                <span className="sr-only">Close</span>
              </Button>
            </DialogClose>
          )}
        </DialogPanel>
      </div>
    </HeadlessDialog>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2", className)}
      data-slot="dialog-header"
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      // `modal-action` supplies the flex row, `justify-content: flex-end` and
      // the 0.5rem gap. Its `margin-top: 1.5rem` is zeroed because the panel is
      // a grid with the same 1.5rem gap already between its sections.
      className={cn(
        "modal-action mt-0 flex-col-reverse sm:flex-row",
        className
      )}
      data-slot="dialog-footer"
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogClose asChild>
          <Button variant="outline">Close</Button>
        </DialogClose>
      )}
    </div>
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof HeadlessDialogTitle>) {
  return (
    <HeadlessDialogTitle
      className={cn(
        "font-heading text-lg leading-none font-semibold tracking-wider uppercase",
        className
      )}
      data-slot="dialog-title"
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn(
        "mt-0.5 text-sm leading-relaxed text-base-content-muted *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-base-content",
        className
      )}
      data-slot="dialog-description"
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
