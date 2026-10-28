"use client";

import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { CaretRightIcon, CheckIcon } from "@phosphor-icons/react";
import { createContext, type ReactNode, useContext, useState } from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Slot } from "@/lib/slot";
import { cn } from "@/lib/utils";

// daisyUI `menu` for looks, Headless UI `Menu` for behaviour — hence the real
// `<ul><li>` tree `menu` requires, and the render prop mapping `focus`/`disabled`
// onto `menu-focus`/`menu-disabled`, since its roving tabindex never moves DOM
// focus. daisyUI's `dropdown` would fight it for open state, so it is unused.
type Align = "center" | "end" | "start";

const ALIGN_TO_ANCHOR: Record<Align, "bottom end" | "bottom start" | "bottom"> =
  {
    center: "bottom",
    end: "bottom end",
    start: "bottom start",
  };

// `menu` sizes items but ships no icon rule, and nothing in daisyUI sizes an
// inline SVG.
const ITEM_ICON =
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5";

const ModalContext = createContext(false);

function DropdownMenu({
  modal = false,
  children,
}: {
  children: ReactNode;
  modal?: boolean;
}) {
  return (
    <ModalContext.Provider value={modal}>
      <Menu>{children}</Menu>
    </ModalContext.Provider>
  );
}

function DropdownMenuPortal({ children }: { children: ReactNode }) {
  return children;
}

function DropdownMenuTrigger({
  asChild,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  return (
    <MenuButton
      as={asChild ? Slot : "button"}
      data-slot="dropdown-menu-trigger"
      {...props}
    />
  );
}

function DropdownMenuContent({
  className,
  align = "start",
  ...props
}: Omit<React.ComponentProps<typeof MenuItems>, "as"> & { align?: Align }) {
  const modal = useContext(ModalContext);
  return (
    <MenuItems
      anchor={{ gap: 4, padding: 8, to: ALIGN_TO_ANCHOR[align] }}
      as="ul"
      // `menu` supplies padding, type and column flow; Tailwind is left with
      // elevation, stacking and the transition. `flex-nowrap` cancels `menu`'s
      // `column wrap`, which would break a long menu into columns at max height.
      className={cn(
        "menu z-50 min-w-48 flex-nowrap overflow-x-hidden overflow-y-auto rounded-box bg-base-100 text-base-content shadow-md ring-1 ring-base-content/10 outline-hidden transition duration-100 data-closed:scale-95 data-closed:opacity-0",
        className
      )}
      data-slot="dropdown-menu-content"
      modal={modal}
      transition
      {...props}
    />
  );
}

// A `<ul>` may only contain `<li>`, so a group is an `li > ul` whose inner list
// is `display: contents` — the items stay direct flex children of the popup and
// daisyUI's nested-submenu indent rules never generate a box.
function DropdownMenuGroup({
  className,
  children,
}: React.ComponentProps<"ul">) {
  return (
    <li data-slot="dropdown-menu-group" role="none">
      <ul className={cn("contents", className)} role="none">
        {children}
      </ul>
    </li>
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  disabled,
  onSelect,
  children,
  ...props
}: React.ComponentProps<"span"> & {
  disabled?: boolean;
  inset?: boolean;
  onSelect?: (event: React.MouseEvent<HTMLLIElement>) => void;
  variant?: "default" | "destructive";
}) {
  return (
    // The activation handler sits on the `li` — the element Headless UI gives
    // `role="menuitem"`, a tabindex and its own keyboard handling — not on the
    // presentational span inside it.
    <MenuItem
      as="li"
      className={disabled ? "menu-disabled" : undefined}
      disabled={disabled}
      onClick={onSelect}
    >
      {({ focus }) => (
        <span
          className={cn(
            "cursor-pointer",
            ITEM_ICON,
            focus && "menu-focus",
            inset && "pl-9.5",
            // daisyUI's focus/hover fill is a neutral base-content wash; the
            // destructive row recolours it and its text from `error`. Tailwind
            // utilities are unlayered, so they beat `menu-focus` without `!`.
            variant === "destructive" &&
              "text-error hover:bg-error/10 dark:hover:bg-error/20",
            variant === "destructive" &&
              focus &&
              "bg-error/10 text-error dark:bg-error/20",
            className
          )}
          data-inset={inset}
          data-slot="dropdown-menu-item"
          data-variant={variant}
          {...props}
        >
          {children}
        </span>
      )}
    </MenuItem>
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  disabled,
  onCheckedChange,
  inset,
  ...props
}: React.ComponentProps<"span"> & {
  checked?: boolean;
  disabled?: boolean;
  inset?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}) {
  return (
    <MenuItem
      as="li"
      className={disabled ? "menu-disabled" : undefined}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
    >
      {({ focus }) => (
        <span
          className={cn(
            "cursor-pointer",
            ITEM_ICON,
            focus && "menu-focus",
            inset && "pl-9.5",
            className
          )}
          data-inset={inset}
          data-slot="dropdown-menu-checkbox-item"
          {...props}
        >
          {children}
          {/* `menu` lays items out as a grid with `grid-auto-flow: column`, so
              the indicator is simply the trailing cell — it keeps its width
              whether or not the item is checked, which keeps labels aligned. */}
          <span
            className="pointer-events-none size-3.5 justify-self-end"
            data-slot="dropdown-menu-checkbox-item-indicator"
          >
            {checked && <CheckIcon />}
          </span>
        </span>
      )}
    </MenuItem>
  );
}

interface RadioGroupContextValue {
  onValueChange?: (value: string) => void;
  value?: string;
}

const RadioGroupContext = createContext<RadioGroupContextValue>({});

function DropdownMenuRadioGroup({
  value,
  onValueChange,
  children,
}: {
  children: ReactNode;
  onValueChange?: (value: string) => void;
  value?: string;
}) {
  return (
    <RadioGroupContext.Provider value={{ onValueChange, value }}>
      {children}
    </RadioGroupContext.Provider>
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  disabled,
  inset,
  value,
  ...props
}: React.ComponentProps<"span"> & {
  disabled?: boolean;
  inset?: boolean;
  value: string;
}) {
  const group = useContext(RadioGroupContext);
  const checked = group.value === value;
  return (
    <MenuItem
      as="li"
      className={disabled ? "menu-disabled" : undefined}
      disabled={disabled}
      onClick={() => group.onValueChange?.(value)}
    >
      {({ focus }) => (
        <span
          className={cn(
            "cursor-pointer",
            ITEM_ICON,
            focus && "menu-focus",
            inset && "pl-9.5",
            className
          )}
          data-inset={inset}
          data-slot="dropdown-menu-radio-item"
          {...props}
        >
          {children}
          <span
            className="pointer-events-none size-3.5 justify-self-end"
            data-slot="dropdown-menu-radio-item-indicator"
          >
            {checked && <CheckIcon />}
          </span>
        </span>
      )}
    </MenuItem>
  );
}

// `menu-title` is daisyUI's own section heading: 40% base-content, 0.5/0.75rem
// padding, 600 weight — and it is what `menu`'s item selectors exclude, so the
// heading never picks up hover or focus styling.
function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<"li"> & { inset?: boolean }) {
  return (
    <li
      className={cn(
        "menu-title tracking-wider uppercase data-inset:pl-9.5",
        className
      )}
      data-inset={inset}
      data-slot="dropdown-menu-label"
      {...props}
    />
  );
}

// An empty `<li>` is daisyUI's menu separator (`.menu :where(li:empty)`). It
// carries `role="none"` to stay out of the accessibility tree, where a bare
// `listitem` would be an invalid child of `role="menu"`.
function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<"li">) {
  return (
    <li
      className={className}
      data-slot="dropdown-menu-separator"
      role="none"
      {...props}
    />
  );
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "justify-self-end text-xs tracking-widest text-base-content-muted",
        className
      )}
      data-slot="dropdown-menu-shortcut"
      {...props}
    />
  );
}

// Submenus keep Floating UI: Headless UI's Menu has no nested-menu primitive,
// and daisyUI's own submenu is a `<details>` disclosure with no collision
// handling. The popup still renders as a daisyUI `menu`.
function DropdownMenuSub({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      {children}
    </Popover>
  );
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<"span"> & { inset?: boolean }) {
  return (
    <li>
      <PopoverTrigger asChild>
        <span
          className={cn(
            "cursor-pointer",
            ITEM_ICON,
            inset && "pl-9.5",
            className
          )}
          data-inset={inset}
          data-slot="dropdown-menu-sub-trigger"
          {...props}
        >
          {children}
          <CaretRightIcon className="justify-self-end" />
        </span>
      </PopoverTrigger>
    </li>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof PopoverContent>) {
  return (
    <PopoverContent
      align="start"
      as="ul"
      className={cn(
        "menu w-auto min-w-40 flex-nowrap border-0 p-2 ring-1 ring-base-content/10",
        className
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
