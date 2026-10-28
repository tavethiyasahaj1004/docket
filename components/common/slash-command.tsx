"use client";

import {
  CodeBlockIcon,
  ListBulletsIcon,
  ListNumbersIcon,
  ParagraphIcon,
  QuotesIcon,
  TextHOneIcon,
  TextHThreeIcon,
  TextHTwoIcon,
} from "@phosphor-icons/react";
import {
  type Editor,
  Extension,
  type Range,
  ReactRenderer,
} from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { cn } from "@/lib/utils";

interface SlashItem {
  command: (props: { editor: Editor; range: Range }) => void;
  hint: string;
  icon: ReactNode;
  title: string;
}

const ITEMS: SlashItem[] = [
  {
    title: "Text",
    hint: "Plain paragraph",
    icon: <ParagraphIcon className="size-4" />,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    title: "Heading 1",
    hint: "Big section heading",
    icon: <TextHOneIcon className="size-4" />,
    command: ({ editor, range }) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .setNode("heading", { level: 1 })
        .run(),
  },
  {
    title: "Heading 2",
    hint: "Medium heading",
    icon: <TextHTwoIcon className="size-4" />,
    command: ({ editor, range }) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .setNode("heading", { level: 2 })
        .run(),
  },
  {
    title: "Heading 3",
    hint: "Small heading",
    icon: <TextHThreeIcon className="size-4" />,
    command: ({ editor, range }) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .setNode("heading", { level: 3 })
        .run(),
  },
  {
    title: "Bullet List",
    hint: "Unordered list",
    icon: <ListBulletsIcon className="size-4" />,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: "Numbered List",
    hint: "Ordered list",
    icon: <ListNumbersIcon className="size-4" />,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: "Quote",
    hint: "Blockquote",
    icon: <QuotesIcon className="size-4" />,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    title: "Code Block",
    hint: "Formatted code",
    icon: <CodeBlockIcon className="size-4" />,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
];

interface SlashListProps {
  command: (item: SlashItem) => void;
  items: SlashItem[];
}

export interface SlashListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

const SlashList = ({
  ref,
  ...props
}: SlashListProps & { ref?: RefObject<SlashListRef | null> }) => {
  const [selected, setSelected] = useState(0);

  // props.items is a deliberate re-run trigger, not a value read in the effect.
  // Dropping it would run this only on mount, leaving `selected` on a stale
  // index whenever the filtered list shrinks.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional re-run trigger, not a read dependency
  useEffect(() => setSelected(0), [props.items]);

  const pick = (index: number) => {
    const item = props.items[index];
    if (item) {
      props.command(item);
    }
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (props.items.length === 0) {
        return false;
      }
      if (event.key === "ArrowUp") {
        setSelected((s) => (s + props.items.length - 1) % props.items.length);
        return true;
      }
      if (event.key === "ArrowDown") {
        setSelected((s) => (s + 1) % props.items.length);
        return true;
      }
      if (event.key === "Enter") {
        pick(selected);
        return true;
      }
      return false;
    },
  }));

  if (props.items.length === 0) {
    return null;
  }

  return (
    <div className="w-60 overflow-hidden rounded-lg border border-base-300 bg-base-100 p-1 shadow-md">
      {props.items.map((item, index) => (
        <button
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
            index === selected ? "bg-base-300" : "hover:bg-base-300/60"
          )}
          key={item.title}
          onMouseDown={(e) => {
            e.preventDefault();
            pick(index);
          }}
          onMouseEnter={() => setSelected(index)}
          type="button"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-base-300 bg-base-100 text-base-content">
            {item.icon}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-base-content">
              {item.title}
            </span>
            <span className="block text-xs text-base-content-muted">
              {item.hint}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
};
SlashList.displayName = "SlashList";

/** Notion-style "/" slash menu for inserting headings, lists, quotes, code. */
export const SlashCommand = Extension.create({
  name: "slashCommand",

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: "/",
        // Trigger at the start of a block or after whitespace — so "/" fires the
        // menu but things like "http://" don't.
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name === "codeBlock") {
            return false;
          }
          if (range.from === 0) {
            return true;
          }
          const before = state.doc.textBetween(
            range.from - 1,
            range.from,
            "\n",
            "\n"
          );
          return before === "" || before === " " || before === "\n";
        },
        items: ({ query }) =>
          ITEMS.filter((i) =>
            i.title.toLowerCase().includes(query.toLowerCase())
          ),
        command: ({ editor, range, props }) => props.command({ editor, range }),
        render: () => {
          let renderer: ReactRenderer<SlashListRef, SlashListProps>;
          let popup: TippyInstance[];

          return {
            onStart: (props) => {
              renderer = new ReactRenderer(SlashList, {
                props,
                editor: props.editor,
              });
              if (!props.clientRect) {
                return;
              }
              popup = tippy("body", {
                getReferenceClientRect: () =>
                  props.clientRect?.() ?? new DOMRect(),
                appendTo: () => document.body,
                content: renderer.element,
                showOnCreate: true,
                interactive: true,
                trigger: "manual",
                placement: "bottom-start",
                arrow: false,
              });
            },
            onUpdate: (props) => {
              renderer.updateProps(props);
              if (props.clientRect) {
                popup?.[0]?.setProps({
                  getReferenceClientRect: () =>
                    props.clientRect?.() ?? new DOMRect(),
                });
              }
            },
            onKeyDown: (props) => {
              if (props.event.key === "Escape") {
                popup?.[0]?.hide();
                return true;
              }
              return renderer.ref?.onKeyDown(props) ?? false;
            },
            onExit: () => {
              popup?.[0]?.destroy();
              renderer.destroy();
            },
          };
        },
      }),
    ];
  },
});
