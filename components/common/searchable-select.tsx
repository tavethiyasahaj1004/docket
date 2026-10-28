"use client";

import {
  CaretUpDownIcon,
  CheckIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface SelectOption {
  label: string;
  value: string;
}

interface Props {
  /** Tighter trigger chrome for dense contexts like table cells, where the
   * default caret and padding can crowd out the value in a fixed-width column. */
  compact?: boolean;
  disabled?: boolean;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  /** Set false for short fixed lists (e.g. page sizes): hides the search box and
   * lets the menu hug the trigger width instead of reserving room for an input,
   * growing to its longest option if the trigger is narrower. */
  search?: boolean;
  searchPlaceholder?: string;
  triggerClassName?: string;
  value: string;
}

/** A searchable single-select (Popover + filterable list). Always opens directly
 * below the trigger, never re-centering on the selected option the way a native
 * select does. Type to filter, ↑/↓ to move, Enter to pick, Esc to close. */
export function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder = "Select",
  search = true,
  searchPlaceholder = "Search…",
  triggerClassName,
  disabled = false,
  compact = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [triggerEl, setTriggerEl] = useState<HTMLButtonElement | null>(null);
  const [triggerWidth, setTriggerWidth] = useState<number>();

  useEffect(() => {
    if (!triggerEl) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      setTriggerWidth(entry.contentRect.width);
    });
    observer.observe(triggerEl);
    return () => observer.disconnect();
  }, [triggerEl]);

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? options.filter((o) => o.label.toLowerCase().includes(q))
      : options;
  }, [options, query]);

  const pick = (v: string) => {
    onValueChange(v);
    setOpen(false);
    setQuery("");
  };

  const handleListKeys = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[active];
      if (opt) {
        pick(opt.value);
      }
    }
  };

  return (
    <Popover
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          // Start keyboard navigation on the current selection.
          const idx = options.findIndex((opt) => opt.value === value);
          setActive(idx >= 0 ? idx : 0);
        } else {
          setQuery("");
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <button
          aria-expanded={open}
          // daisyUI `select` owns the trigger box, keeping it dimensionally
          // identical to `<SelectTrigger>` and `<Input>`. `bg-none` drops its
          // CSS caret (a Phosphor one renders below) and padding is re-evened.
          className={cn(
            "select flex items-center justify-between bg-none",
            compact ? "gap-1 px-2" : "gap-2 px-3",
            triggerClassName
          )}
          disabled={disabled}
          ref={setTriggerEl}
          role="combobox"
          title={selected?.label}
          type="button"
        >
          <span
            className={cn("truncate", !selected && "text-base-content-muted")}
          >
            {selected?.label ?? placeholder}
          </span>
          <CaretUpDownIcon
            className={cn(
              "shrink-0 text-base-content-muted",
              compact ? "size-3" : "size-4"
            )}
          />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className={cn("p-0", search ? "min-w-48" : "w-max")}
        onKeyDown={search ? undefined : handleListKeys}
        style={triggerWidth ? { minWidth: triggerWidth } : undefined}
      >
        {search && (
          <div className="flex items-center gap-2 border-b border-base-300 px-2.5">
            <MagnifyingGlassIcon className="size-4 shrink-0 text-base-content-muted" />
            <input
              // focus the search when the popover opens
              autoFocus
              className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-base-content-muted"
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={handleListKeys}
              placeholder={searchPlaceholder}
              value={query}
            />
          </div>
        )}
        {/* daisyUI `menu` — the same treatment `<SelectContent>` uses, which
            is why the list is a real `<ul><li>` tree. daisyUI styles real
            `:hover` itself; the keyboard cursor is mapped onto its own
            `menu-focus` class and the current value onto `menu-active`. The
            selected row always stays active so it doesn't flip colour as the
            cursor moves on and off it. */}
        <ul className="menu max-h-60 w-full flex-nowrap overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <li className="px-2 py-4 text-center text-xs text-base-content-muted">
              No results
            </li>
          ) : (
            filtered.map((o, i) => (
              <li key={o.value}>
                <button
                  className={cn(
                    o.value === value
                      ? "menu-active"
                      : i === active && "menu-focus",
                    // daisyUI paints a pressed row with the same dark fill as
                    // `menu-active`, so press-and-hold on another option made
                    // it look selected too. Keep the dark fill for the
                    // selected row only; a pressed row stays hover-light.
                    o.value !== value &&
                      "active:bg-base-content/10 active:text-base-content"
                  )}
                  onClick={() => pick(o.value)}
                  onMouseEnter={() => setActive(i)}
                  type="button"
                >
                  <span className="truncate">{o.label}</span>
                  {o.value === value && (
                    <CheckIcon className="size-4 shrink-0 justify-self-end" />
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
