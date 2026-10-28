import { signFileUrl } from "@/lib/file-access";

/** The customer portal's attachments, each with a signed, short-lived link:
 * the ticket's own (description) files, and those on the public comments the
 * page shows. Any other attachment (an internal note's) is dropped here, so no
 * link is ever minted for it. A fresh render mints fresh links. */
export function groupCustomerAttachments<
  T extends { commentId: string | null; storageKey: string },
>(
  attachments: T[],
  publicCommentIds: ReadonlySet<string>,
  nowMs: number = Date.now()
): {
  ticketLevel: Array<T & { url: string }>;
  byComment: Map<string, Array<T & { url: string }>>;
} {
  const ticketLevel: Array<T & { url: string }> = [];
  const byComment = new Map<string, Array<T & { url: string }>>();
  for (const a of attachments) {
    if (a.commentId && !publicCommentIds.has(a.commentId)) {
      continue;
    }
    const withUrl = { ...a, url: signFileUrl(a.storageKey, nowMs) };
    if (!a.commentId) {
      ticketLevel.push(withUrl);
      continue;
    }
    const list = byComment.get(a.commentId);
    if (list) {
      list.push(withUrl);
    } else {
      byComment.set(a.commentId, [withUrl]);
    }
  }
  return { ticketLevel, byComment };
}
