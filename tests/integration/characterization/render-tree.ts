import { isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * Walks the element tree a Next.js server component returns, the way the RSC
 * renderer would, but without React: ASYNC function components (server
 * components such as TicketsResults) are awaited and their output walked;
 * everything else is recorded, never rendered.
 *
 *  - host elements (`"div"`): only their text is collected
 *  - sync function / class / memo / forwardRef components (client components,
 *    Link, icons, skeletons): recorded as `{ name, props }`, NOT called
 *  - Fragment / Suspense / other symbol types: their children are walked
 *
 * The output is a plain serialisable structure, so it can be snapshotted.
 */

export type CapturedComponent = {
  name: string;
  key?: string;
  props: unknown;
};

export type RenderCapture = {
  /** Names of the async (server) components that were awaited, in order. */
  asyncCalls: string[];
  /** Every non-async component element met, in tree order. */
  components: CapturedComponent[];
  /** Text runs from host elements and component children, in tree order. */
  text: string[];
};

// biome-ignore lint/complexity/noBannedTypes: component types are arbitrary
type AnyFn = Function;

function isAsyncFunction(
  fn: unknown
): fn is (props: unknown) => Promise<ReactNode> {
  return (
    typeof fn === "function" &&
    Object.prototype.toString.call(fn) === "[object AsyncFunction]"
  );
}

/** Unwraps memo/forwardRef/lazy-ish wrappers to find a display name. */
export function componentName(type: unknown): string {
  if (typeof type === "function") {
    const fn = type as AnyFn & { displayName?: string };
    return fn.displayName || fn.name || "Anonymous";
  }
  if (type && typeof type === "object") {
    const t = type as {
      displayName?: string;
      render?: AnyFn;
      type?: unknown;
    };
    if (t.displayName) {
      return t.displayName;
    }
    if (t.render) {
      return componentName(t.render);
    }
    if (t.type) {
      return `memo(${componentName(t.type)})`;
    }
  }
  if (typeof type === "symbol") {
    return type.description ?? "Symbol";
  }
  return "Unknown";
}

/** Turns arbitrary prop values into snapshot-stable plain data. */
export function serialize(value: unknown, depth = 0): unknown {
  if (depth > 12) {
    return "[MaxDepth]";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (value instanceof Date) {
    return `[Date ${Number.isNaN(value.getTime()) ? "Invalid" : value.toISOString()}]`;
  }
  if (typeof value === "function") {
    return `[Function ${(value as AnyFn).name || "anonymous"}]`;
  }
  if (typeof value === "symbol") {
    return `[Symbol ${value.description}]`;
  }
  if (typeof value === "bigint") {
    return `[BigInt ${value}]`;
  }
  if (isValidElement(value)) {
    return `[Element ${componentName((value as ReactElement).type)}]`;
  }
  if (value instanceof Map) {
    return {
      "[Map]": [...value.entries()].map(([k, v]) => [
        serialize(k, depth + 1),
        serialize(v, depth + 1),
      ]),
    };
  }
  if (value instanceof Set) {
    return { "[Set]": [...value.values()].map((v) => serialize(v, depth + 1)) };
  }
  if (Array.isArray(value)) {
    return value.map((v) => serialize(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serialize(v, depth + 1);
    }
    return out;
  }
  return value;
}

export async function captureTree(root: ReactNode): Promise<RenderCapture> {
  const capture: RenderCapture = { asyncCalls: [], components: [], text: [] };
  let run = "";

  const flush = () => {
    const trimmed = run.replace(/\s+/g, " ").trim();
    if (trimmed) {
      capture.text.push(trimmed);
    }
    run = "";
  };

  async function visit(node: ReactNode): Promise<void> {
    if (node === null || node === undefined || typeof node === "boolean") {
      return;
    }
    if (typeof node === "string" || typeof node === "number") {
      run += String(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        await visit(child);
      }
      return;
    }
    if (!isValidElement(node)) {
      return;
    }
    const element = node as ReactElement<Record<string, unknown>>;
    const { type, props } = element;
    const children = props?.children as ReactNode;

    if (typeof type === "string") {
      flush();
      await visit(children);
      flush();
      return;
    }
    if (typeof type === "symbol") {
      // Fragment, Suspense, StrictMode, ... — transparent.
      await visit(children);
      return;
    }
    if (isAsyncFunction(type)) {
      flush();
      capture.asyncCalls.push(componentName(type));
      const output = await type(props);
      await visit(output);
      flush();
      return;
    }
    // Sync component of any flavour: record, do not render.
    flush();
    const { children: _children, ...rest } = props ?? {};
    capture.components.push({
      name: componentName(type),
      ...(element.key === null ? {} : { key: String(element.key) }),
      props: serialize(rest),
    });
    await visit(children);
    flush();
  }

  await visit(root);
  flush();
  return capture;
}

/** Components with the given display name(s), in tree order. */
export function pick(capture: RenderCapture, ...names: string[]) {
  const wanted = new Set(names);
  return capture.components.filter((c) => wanted.has(c.name));
}
