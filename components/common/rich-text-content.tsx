"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import { cn } from "@/lib/utils";
import {
  baseRichTextExtensions,
  parseRichTextContent,
} from "./rich-text-extensions";

interface Props {
  className?: string;
  content: string;
}

/** Read-only renderer for reply content stored as Tiptap JSON. Going through a
 * non-editable Tiptap instance rather than raw HTML means only known nodes are
 * produced, so customer content can't inject markup. Legacy plain text is as-is. */
export function RichTextContent({ content, className }: Props) {
  const editor = useEditor({
    editable: false,
    extensions: baseRichTextExtensions(),
    content: parseRichTextContent(content),
    editorProps: {
      attributes: {
        class: cn("tiptap-content focus:outline-none", className),
      },
    },
    immediatelyRender: false,
  });

  if (!editor) {
    // SSR / first paint fallback so text is visible before hydration.
    return (
      <div className={cn("tiptap-content whitespace-pre-wrap", className)}>
        {parseRichTextContent(content) === content ? content : ""}
      </div>
    );
  }

  return <EditorContent editor={editor} />;
}
