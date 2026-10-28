"use client";

import {
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
} from "@headlessui/react";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import {
  Children,
  createContext,
  isValidElement,
  type ReactNode,
  useContext,
} from "react";

import { cn } from "@/lib/utils";

type Align = "center" | "end" | "start";

interface SelectContextValue {
  selectedLabel: ReactNode;
  size: "sm" | "default";
}

const SelectContext = createContext<SelectContextValue | null>(null);

function useSelectContext(name: string) {
  const context = useContext(SelectContext);
  if (!context) {
    throw new Error(`<${name}> must be rendered inside <Select>`);
  }
  return context;
}

// Items only mount once the dropdown has opened (Headless UI doesn't render a
// closed Listbox.Options), so a registration effect can't know the selected
// label on first paint. Walking the JSX tree needs no mount, so it works.
function findSelectedLabel(
  children: ReactNode,
  value: string
): ReactNode | undefined {
  let found: ReactNode | undefined;
  Children.forEach(children, (child) => {
    if (found !== undefined || !isValidElement(child)) {
      return;
    }
    if (child.type === SelectItem) {
      const itemProps = child.props as { children?: ReactNode; value: string };
      if (itemProps.value === value) {
        found = itemProps.children;
      }
      return;
    }
    const childProps = child.props as { children?: ReactNode } | undefined;
    if (childProps?.children !== undefined) {
      found = findSelectedLabel(childProps.children, value);
    }
  });
  return found;
}

function Select({
  value,
  onValueChange,
  disabled,
  size = "default",
  children,
}: {
  children: ReactNode;
  disabled?: boolean;
  onValueChange?: (value: string) => void;
  size?: "sm" | "default";
  value?: string;
}) {
  const selectedLabel = value ? findSelectedLabel(children, value) : undefined;

  return (
    <SelectContext.Provider value={{ selectedLabel, size }}>
      <Listbox
        disabled={disabled}
        onChange={(next) => {
          if (typeof next === "string") {
            onValueChange?.(next);
          }
        }}
        value={value}
      >
        {children}
      </Listbox>
    </SelectContext.Provider>
  );
}

// A `<ul>` may only contain `<li>`, so a group is an `li > ul` whose inner list
// is `display: contents` — the options stay direct children of the popup.
function SelectGroup({ className, children }: React.ComponentProps<"ul">) {
  return (
    <li data-slot="select-group" role="none">
      <ul className={cn("contents", className)} role="none">
        {children}
      </ul>
    </li>
  );
}

function SelectValue({
  placeholder,
  className,
}: {
  className?: string;
  placeholder?: ReactNode;
}) {
  const { selectedLabel } = useSelectContext("SelectValue");
  return (
    <span className={cn("truncate", className)} data-slot="select-value">
      {selectedLabel ?? placeholder}
    </span>
  );
}

function SelectTrigger({
  className,
  size,
  children,
  ...props
}: Omit<React.ComponentProps<typeof ListboxButton>, "children"> & {
  children?: ReactNode;
  size?: "sm" | "default";
}) {
  const context = useSelectContext("SelectTrigger");
  const resolvedSize = size ?? context.size;
  return (
    <ListboxButton
      className={cn(
        // `select` supplies the control box, keeping the trigger dimensionally
        // identical to `Input`. `bg-none` drops daisyUI's CSS caret (a Phosphor
        // one renders below) and `px-3` re-evens the padding it reserved.
        "select flex w-fit items-center justify-between bg-none px-3 whitespace-nowrap data-disabled:cursor-not-allowed aria-invalid:border-error [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        resolvedSize === "sm" && "select-sm",
        className
      )}
      data-size={resolvedSize}
      data-slot="select-trigger"
      {...props}
    >
      {children}
      <CaretDownIcon className="pointer-events-none size-3.5 text-base-content-muted" />
    </ListboxButton>
  );
}

// The popup is a daisyUI `menu`, so it needs a real `<ul><li>` tree. Headless
// UI's roving tabindex never moves DOM focus, so `data-focus`/`data-selected`
// map onto `menu-focus`/`menu-active`; the selected row always stays active.
function SelectContent({
  className,
  children,
  align = "start",
  ...props
}: Omit<React.ComponentProps<typeof ListboxOptions>, "as"> & {
  align?: Align;
}) {
  const anchor =
    align === "end"
      ? "bottom end"
      : align === "center"
        ? "bottom"
        : "bottom start";
  return (
    <ListboxOptions
      anchor={{ gap: 4, padding: 8, to: anchor }}
      as="ul"
      // z-[60], one above Popover/Dialog (z-50): an open listbox is always
      // the topmost layer, but it's portaled separately, so at an equal
      // z-index a Popover mounted later (e.g. the ticket "Link ticket"
      // popover) paints over its options and swallows clicks on them.
      className={cn(
        "menu z-[60] max-h-72 min-w-(--button-width) flex-nowrap overflow-x-hidden overflow-y-auto rounded-box bg-base-100 text-base-content shadow-md ring-1 ring-base-content/10 outline-hidden transition duration-100 data-closed:scale-95 data-closed:opacity-0",
        className
      )}
      data-slot="select-content"
      transition
      {...props}
    >
      {children}
    </ListboxOptions>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      className={cn("menu-title tracking-wider uppercase", className)}
      data-slot="select-label"
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  value,
  disabled,
  ...props
}: Omit<React.ComponentProps<typeof ListboxOption>, "children" | "value"> & {
  children?: ReactNode;
  disabled?: boolean;
  value: string;
}) {
  return (
    <ListboxOption
      as="li"
      className={disabled ? "menu-disabled" : undefined}
      disabled={disabled}
      value={value}
      {...props}
    >
      {({ selected, focus }) => (
        <span
          className={cn(
            "cursor-pointer [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
            // The selected row stays `menu-active` whether or not it holds the
            // cursor — otherwise it flips light (on open, when it has focus)
            // to dark (once the cursor moves to another row), which reads as
            // two different "selected" colours. The cursor shows on other rows.
            selected ? "menu-active" : focus && "menu-focus",
            // Same reason as SearchableSelect: daisyUI's pressed-row fill
            // matches `menu-active`, so only the selected row may stay dark.
            !selected && "active:bg-base-content/10 active:text-base-content",
            className
          )}
          data-slot="select-item"
        >
          {children}
          {/* `menu` lays the row out as a grid with `grid-auto-flow: column`,
              so the tick is just the trailing cell — always present, so
              labels stay aligned whether or not the row is selected. */}
          <span className="pointer-events-none size-3.5 justify-self-end">
            {selected && <CheckIcon />}
          </span>
        </span>
      )}
    </ListboxOption>
  );
}

// An empty `<li>` is daisyUI's menu separator. `role="none"` keeps it out of
// the listbox's accessibility tree, where a bare `listitem` would be an
// invalid child of `role="listbox"`.
function SelectSeparator({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      className={className}
      data-slot="select-separator"
      role="none"
      {...props}
    />
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
