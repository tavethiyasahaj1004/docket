"use client";

import {
  cloneElement,
  isValidElement,
  type ReactNode,
  type Ref,
  useMemo,
} from "react";
import { cn } from "@/lib/utils";

interface SlotProps extends React.HTMLAttributes<HTMLElement> {
  children?: ReactNode;
  ref?: Ref<HTMLElement>;
}

function composeRefs<T>(...refs: Array<Ref<T> | null | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === "function") {
        ref(node);
      } else if (ref && "current" in ref) {
        (ref as { current: T | null }).current = node;
      }
    }
  };
}

/** Merges its props onto a single child instead of rendering a DOM node, backing
 * `asChild` without a radix-ui dependency; both refs are composed. That composed
 * ref must stay memoized — callers like Floating UI's `refs.setReference` set
 * state on every ref call, so a fresh identity per render loops forever. */
export function Slot({ children, className, ref, ...props }: SlotProps) {
  const childRef = isValidElement(children)
    ? ((children.props as { ref?: Ref<HTMLElement> }).ref ?? null)
    : null;

  // composeRefs must stay referentially stable while its inputs don't change —
  // the whole point of this memo.
  const composedRef = useMemo(
    () => composeRefs(ref, childRef),
    [ref, childRef]
  );

  if (!isValidElement(children)) {
    return children;
  }

  const childProps = children.props as Record<string, unknown>;

  return cloneElement(children, {
    ...props,
    ...childProps,
    className: cn(className, childProps.className as string | undefined),
    ref: composedRef,
  } as React.Attributes);
}
