// Helpers for reply content stored as a serialized Tiptap document, so replies
// can carry basic formatting. Older comments were plain text, so every helper
// here falls back to treating a non-JSON string as plain text.

import { generateHTML, generateJSON } from "@tiptap/html";
import { baseRichTextExtensions } from "@/components/common/rich-text-extensions";

interface TiptapNode {
  content?: TiptapNode[];
  text?: string;
  type?: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseDoc(content: string): TiptapNode | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as TiptapNode;
  } catch {
    return null;
  }
}

function collectText(node: TiptapNode, out: string[]): void {
  if (node.text) {
    out.push(node.text);
  }
  if (node.content) {
    for (const child of node.content) {
      collectText(child, out);
    }
  }
  // Block-level nodes imply a line break between them.
  if (
    node.type &&
    ["paragraph", "heading", "listItem", "blockquote"].includes(node.type)
  ) {
    out.push("\n");
  }
}

/** Flatten reply content to plain text for previews, emails, notifications and
 * push bodies. Accepts Tiptap JSON or a legacy plain-text string. */
export function richTextToPlainText(content: string): string {
  const doc = parseDoc(content);
  if (!doc) {
    return content;
  }
  const parts: string[] = [];
  collectText(doc, parts);
  return parts
    .join("")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** True when the reply has no visible text (empty Tiptap doc or blank string). */
export function isRichTextEmpty(content: string): boolean {
  return richTextToPlainText(content).trim().length === 0;
}

/** Renders stored reply content as HTML for callers wanting formatting rather
 * than a flatten (currently just the public API's comments endpoint). Safe by
 * construction: `generateHTML` emits strictly through our own editor schema, so
 * only whitelisted tags come out. Legacy plain text is escaped into a <p>. */
export function richTextToHtml(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    try {
      const doc = JSON.parse(trimmed);
      return generateHTML(doc, baseRichTextExtensions());
    } catch {
      // fall through to plain-text handling below
    }
  }
  return `<p>${escapeHtml(content).replace(/\n/g, "<br>")}</p>`;
}

/** Wraps plain text into a minimal Tiptap document, one paragraph per line, for
 * callers holding plain text that needs storing — chiefly the public API, whose
 * `description` takes plain text by default (htmlToRichTextJson is the other). */
export function textToRichTextJson(text: string): string {
  const lines = text.split(/\r\n|\r|\n/);
  return JSON.stringify({
    type: "doc",
    content: lines.map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  });
}

/** Converts an HTML string into a stored Tiptap document. The one place allowed
 * to accept *external* HTML, precisely because it never trusts it: `generateJSON`
 * parses through our own schema, dropping any tag or attribute it doesn't know
 * (scripts, event handlers, unknown elements) rather than storing it. */
export function htmlToRichTextJson(html: string): string {
  return JSON.stringify(generateJSON(html, baseRichTextExtensions()));
}
